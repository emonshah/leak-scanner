/**
 * Accuracy-first email validation engine (canonical backend source of truth).
 *
 * Pipeline: normalize -> syntax -> domain -> MX (+A fallback) ->
 * disposable/role metadata -> SMTP (+retry, catch-all probe) ->
 * evidence aggregation -> contradiction-safe verdict + confidence.
 *
 * IRON LAWS (never violate):
 * - Timeout / DNS error / greylist / firewall / blocked / catch-all /
 *   unknown SMTP reply / 4xx is NEVER INVALID. Unverifiable => UNKNOWN
 *   (could not check) or UNVERIFIED (plausible, mailbox unconfirmed).
 * - INVALID only on strong evidence: bad structure, dead domain,
 *   known-disposable domain, or an explicit recipient-rejected 5xx.
 * - Role-based addresses are metadata only — never a verdict driver.
 * - Nothing here sends mail, authenticates, deletes, or modifies addresses.
 * - Frontend executes NO validation logic; it only renders this result.
 */
import { promises as dns } from 'node:dns';
import net from 'node:net';

export type Verdict = 'VALID' | 'INVALID' | 'UNKNOWN' | 'UNVERIFIED';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface VerifyEvidence {
  originalEmail: string;
  normalizedEmail: string;
  syntax: { status: 'VALID' | 'INVALID'; detail?: string };
  domain: { status: 'VALID' | 'INVALID' | 'UNRESOLVED'; domain: string };
  dns: { status: 'RESOLVED' | 'ERROR' | 'TIMEOUT' };
  mx: { status: 'PRESENT' | 'ABSENT' | 'ERROR' | 'TIMEOUT'; records: string[]; viaAfallback?: boolean };
  roleBased: { isRoleBased: boolean };
  disposable: { status: 'DISPOSABLE' | 'NOT_DISPOSABLE' | 'UNKNOWN' };
  smtp: { status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN' | 'SKIPPED'; reason: string };
  catchAll: { status: 'TRUE' | 'FALSE' | 'UNKNOWN' };
  final: { verdict: Verdict; confidence: Confidence; reason: string };
}

export interface VerifyOutcome {
  verdict: Verdict;
  confidence: Confidence;
  reason: string;
  evidence: VerifyEvidence;
}

/** A stored verdict is trustworthy for 30 days unless the address changes. */
export const VERIFY_FRESH_MS = 30 * 24 * 60 * 60 * 1000;
const SMTP_TIMEOUT_MS = 12000;
const SMTP_MAX_ATTEMPTS = 2;
const SMTP_RETRY_BACKOFF_MS = 2000;
const MAIL_FROM = 'emon@emonshah.com';

/** Business inboxes that exist but are low-value for 1-to-1 outreach (metadata only). */
const ROLE_LOCALS = new Set([
  'info', 'support', 'admin', 'contact', 'sales', 'hello', 'help',
  'billing', 'careers', 'jobs', 'press', 'media', 'marketing', 'office',
]);

/** Throwaway domains (curated, extend as new ones appear). Unknown provider != disposable. */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'yopmail.com', 'trashmail.com', 'fakeinbox.com', 'getnada.com',
  'mohmal.com', 'sharklasers.com', 'grr.la', 'dispostable.com',
  'emailondeck.com', 'temp-mail.org', 'meltmail.com', 'jetable.org',
]);

/** Explicit "no such mailbox" signals inside 5xx replies. Anything else 5xx => UNKNOWN. */
const RECIPIENT_REJECTED_RE =
  /user unknown|unknown user|mailbox (unavailable|not found|unknown)|no such (user|mailbox|recipient)|recipient (unknown|rejected|not found)|unknown recipient|invalid (mailbox|recipient)|account (does not exist|not exist|disabled|unknown|unavailable)|address (unknown|rejected)|does not exist/i;

// ---------------------------------------------------------------- normalization
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// ---------------------------------------------------------------- syntax (§4: structural parser, not regex-only)
export function checkSyntax(email: string): { ok: boolean; detail?: string } {
  if (!email || email.length > 320) return { ok: false, detail: 'empty or too long' };
  if (/\s/.test(email)) return { ok: false, detail: 'contains whitespace' };
  const at = email.indexOf('@');
  if (at < 0 || at !== email.lastIndexOf('@')) return { ok: false, detail: 'must contain exactly one @' };
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || local.length > 64) return { ok: false, detail: 'bad local part length' };
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return { ok: false, detail: 'malformed dots in local part' };
  }
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return { ok: false, detail: 'illegal characters in local part' };
  if (!domain || domain.length > 253) return { ok: false, detail: 'bad domain length' };
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    return { ok: false, detail: 'malformed dots in domain' };
  }
  if (!domain.includes('.')) return { ok: false, detail: 'domain has no dot' };
  const labels = domain.split('.');
  if (labels.some((l) => !l || l.length > 63 || !/^[A-Za-z0-9-]+$/.test(l) || l.startsWith('-') || l.endsWith('-'))) {
    return { ok: false, detail: 'bad domain label' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- metadata detectors
export function isRoleAccount(email: string): boolean {
  return ROLE_LOCALS.has((email.split('@')[0] ?? '').toLowerCase());
}

export function disposableStatus(domain: string): 'DISPOSABLE' | 'NOT_DISPOSABLE' {
  // Unknown provider is never assumed disposable; only curated hits count.
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase()) ? 'DISPOSABLE' : 'NOT_DISPOSABLE';
}

// ---------------------------------------------------------------- injectable network layer (tests fake it; prod uses DNS/SMTP)
export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface SmtpAttempt {
  /** Raw RCPT lines. */
  probeRcpt: string | null;
  targetRcpt: string | null;
  /** Connection-level failure (timeout/refused/greylisted-silence). */
  netError?: string;
}

export interface VerifyDeps {
  resolveMx: (domain: string) => Promise<MxRecord[]>;
  resolveDomain: (domain: string) => Promise<'RESOLVED' | 'UNRESOLVED' | 'TIMEOUT'>;
  smtpAttempt: (mxHost: string, email: string) => Promise<SmtpAttempt>;
  smtpControlOk: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

async function realResolveMx(domain: string): Promise<MxRecord[]> {
  const recs = await dns.resolveMx(domain);
  return recs.filter((r) => r.exchange).sort((a, b) => a.priority - b.priority);
}

async function realResolveDomain(domain: string): Promise<'RESOLVED' | 'UNRESOLVED' | 'TIMEOUT'> {
  try {
    const [v4, v6] = await Promise.all([
      dns.resolve4(domain).catch((e: unknown) => e),
      dns.resolve6(domain).catch((e: unknown) => e),
    ]);
    const ok = (r: unknown): boolean => Array.isArray(r) && r.length > 0;
    if (ok(v4) || ok(v6)) return 'RESOLVED';
    const codes = [v4, v6].map((r) => (r as { code?: string })?.code ?? '');
    if (codes.some((c) => /ETIME|TIMEOUT|EAI_AGAIN|SERVFAIL/i.test(c))) return 'TIMEOUT';
    return 'UNRESOLVED';
  } catch {
    return 'TIMEOUT';
  }
}

function readLine(sock: net.Socket, buf: { data: string }, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('smtp-timeout')), timeoutMs);
    const onData = (d: Buffer): void => {
      buf.data += d.toString('utf8');
      const idx = buf.data.indexOf('\n');
      if (idx >= 0) {
        const line = buf.data.slice(0, idx);
        buf.data = buf.data.slice(idx + 1);
        if (/^\d{3}-/.test(line)) return; // multi-line reply continues
        clearTimeout(timer);
        sock.off('data', onData);
        resolve(line.trim());
      }
    };
    sock.on('data', onData);
  });
}

async function realSmtpAttempt(mxHost: string, email: string): Promise<SmtpAttempt> {
  return new Promise((resolve) => {
    const out: SmtpAttempt = { probeRcpt: null, targetRcpt: null };
    const done = (patch?: Partial<SmtpAttempt>): void => {
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ...out, ...patch });
    };
    const timer = setTimeout(() => done({ netError: 'smtp-timeout' }), SMTP_TIMEOUT_MS);
    const sock = net.createConnection({ host: mxHost, port: 25, family: 4 });
    const buf = { data: '' };
    const step = async (): Promise<void> => {
      try {
        const greet = await readLine(sock, buf, SMTP_TIMEOUT_MS);
        if (!/^220/.test(greet)) { clearTimeout(timer); return done({ netError: `hello refused: ${greet.slice(0, 40)}` }); }
        sock.write(`EHLO scanner\r\n`);
        const ehlo = await readLine(sock, buf, SMTP_TIMEOUT_MS);
        if (!/^250/.test(ehlo)) { clearTimeout(timer); return done({ netError: 'EHLO refused' }); }
        sock.write(`MAIL FROM:<${MAIL_FROM}>\r\n`);
        const mf = await readLine(sock, buf, SMTP_TIMEOUT_MS);
        if (!/^250/.test(mf)) { clearTimeout(timer); return done({ netError: 'sender refused' }); }
        const domain = (email.split('@')[1] ?? '');
        const probe = `no-such-${Date.now().toString(36)}@${domain}`;
        sock.write(`RCPT TO:<${probe}>\r\n`);
        out.probeRcpt = await readLine(sock, buf, SMTP_TIMEOUT_MS);
        sock.write(`RCPT TO:<${email}>\r\n`);
        out.targetRcpt = await readLine(sock, buf, SMTP_TIMEOUT_MS);
        sock.write(`QUIT\r\n`);
        clearTimeout(timer);
        done();
      } catch (e) {
        clearTimeout(timer);
        done({ netError: e instanceof Error ? e.message.slice(0, 80) : 'smtp-error' });
      }
    };
    sock.on('error', (e) => {
      clearTimeout(timer);
      done({ netError: (e as Error).message?.slice(0, 80) ?? 'unreachable' });
    });
    sock.on('connect', () => { void step(); });
  });
}

// Control probe: can THIS network reach port 25 at all? (cached 1h)
let controlCache: { at: number; ok: boolean } | null = null;

async function realControlOk(): Promise<boolean> {
  if (controlCache && Date.now() - controlCache.at < 3600_000) return controlCache.ok;
  const ok = await new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ host: 'aspmx.l.google.com', port: 25, family: 4 });
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } resolve(false); }, 8000);
    sock.on('connect', () => { clearTimeout(timer); try { sock.destroy(); } catch { /* ignore */ } resolve(true); });
    sock.on('error', () => { clearTimeout(timer); resolve(false); });
  });
  controlCache = { at: Date.now(), ok };
  return ok;
}

/** True when a fresh control probe already proved this network blocks SMTP. */
export function smtpKnownBlocked(): boolean {
  return controlCache !== null
    && Date.now() - controlCache.at < 3600_000
    && controlCache.ok === false;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isNetFailure(a: SmtpAttempt): boolean {
  return !!a.netError || (a.probeRcpt === null && a.targetRcpt === null);
}

function isTempFailure(line: string | null): boolean {
  return !!line && (/^4\d\d/.test(line) || /greylist|temporar|try again|rate limit|throttl/i.test(line));
}

// ---------------------------------------------------------------- the engine
export async function verifyEmail(rawEmail: string, deps?: Partial<VerifyDeps>): Promise<VerifyOutcome> {
  const d: VerifyDeps = {
    resolveMx: realResolveMx,
    resolveDomain: realResolveDomain,
    smtpAttempt: realSmtpAttempt,
    smtpControlOk: realControlOk,
    sleep: defaultSleep,
    ...deps,
  };
  const originalEmail = rawEmail;
  const normalizedEmail = normalizeEmail(rawEmail);
  const domain = (normalizedEmail.split('@')[1] ?? '');

  const fail = (
    verdict: Verdict, confidence: Confidence, reason: string,
    part: Partial<VerifyEvidence>,
  ): VerifyOutcome => ({
    verdict, confidence, reason,
    evidence: {
      originalEmail,
      normalizedEmail,
      syntax: { status: 'VALID' },
      domain: { status: 'VALID', domain },
      dns: { status: 'RESOLVED' },
      mx: { status: 'PRESENT', records: [] },
      roleBased: { isRoleBased: isRoleAccount(normalizedEmail) },
      disposable: { status: 'NOT_DISPOSABLE' },
      smtp: { status: 'SKIPPED', reason: 'not-attempted' },
      catchAll: { status: 'UNKNOWN' },
      final: { verdict, confidence, reason },
      ...part,
    } as VerifyEvidence,
  });

  // Step 2 — syntax. INVALID only here: structure itself is broken.
  const syn = checkSyntax(normalizedEmail);
  if (!syn.ok) {
    return fail('INVALID', 'HIGH', `Bad address structure (${syn.detail})`, {
      syntax: { status: 'INVALID', detail: syn.detail },
    });
  }

  // Steps 3–4 — domain + MX (with RFC 5321 A-fallback). Timeouts never INVALID.
  let domainStatus: 'VALID' | 'INVALID' | 'UNRESOLVED' = 'VALID';
  let dnsStatus: 'RESOLVED' | 'ERROR' | 'TIMEOUT' = 'RESOLVED';
  let mxRecords: string[] = [];
  let mxHost: string | null = null;
  let viaAfallback = false;
  try {
    const recs = await d.resolveMx(domain);
    mxRecords = recs.map((r) => r.exchange);
    mxHost = recs[0]?.exchange ?? null;
  } catch (e) {
    const code = (e as { code?: string })?.code ?? '';
    if (/ETIME|TIMEOUT|EAI_AGAIN|SERVFAIL/i.test(code)) {
      return fail('UNKNOWN', 'LOW', 'DNS timeout — could not check (not invalid)', {
        dns: { status: 'TIMEOUT' },
        mx: { status: 'TIMEOUT', records: [] },
      });
    }
    mxHost = null; // ENOTFOUND etc: fall through to domain/MX-absent analysis
  }

  if (!mxHost) {
    const dom = await d.resolveDomain(domain).catch((): 'TIMEOUT' => 'TIMEOUT');
    if (dom === 'TIMEOUT') {
      return fail('UNKNOWN', 'LOW', 'DNS timeout — could not check (not invalid)', {
        dns: { status: 'TIMEOUT' },
        mx: { status: 'TIMEOUT', records: [] },
      });
    }
    if (dom === 'UNRESOLVED') {
      return fail('INVALID', 'HIGH', 'Domain does not exist', {
        domain: { status: 'INVALID', domain },
        dns: { status: 'ERROR' },
        mx: { status: 'ABSENT', records: [] },
      });
    }
    // Domain resolves but advertises no MX: RFC 5321 A-fallback — the domain
    // itself may still accept mail. Never INVALID on this fact alone.
    mxHost = domain;
    viaAfallback = true;
    dnsStatus = 'RESOLVED';
  }

  const mxEvidence = { status: 'PRESENT' as const, records: mxRecords, viaAfallback };

  // Steps 5–6 — metadata. Disposable is strong evidence (fake contact);
  // role-based is metadata ONLY and never drives the verdict.
  if (disposableStatus(domain) === 'DISPOSABLE') {
    return fail('INVALID', 'HIGH', 'Disposable/throwaway domain', {
      mx: mxEvidence,
      disposable: { status: 'DISPOSABLE' },
    });
  }
  const roleBased = isRoleAccount(normalizedEmail);

  // Known-blocked network: skip the doomed handshake, stay honest.
  if (smtpKnownBlocked()) {
    return fail('UNVERIFIED', 'MEDIUM', 'Mail server exists, mailbox unconfirmed (this network blocks SMTP)', {
      mx: mxEvidence,
      roleBased: { isRoleBased: roleBased },
      smtp: { status: 'SKIPPED', reason: 'network-blocks-smtp' },
    });
  }

  // Step 7 — SMTP with bounded retry (timeout / 4xx only, exponential backoff).
  const sleep = d.sleep ?? (async (ms: number): Promise<void> => { await new Promise((r) => setTimeout(r, ms)); });
  let attempt: SmtpAttempt = { probeRcpt: null, targetRcpt: null, netError: 'not-attempted' };
  for (let i = 0; i < SMTP_MAX_ATTEMPTS; i++) {
    attempt = await d.smtpAttempt(mxHost as string, normalizedEmail);
    const retryable = isTempFailure(attempt.targetRcpt)
      || (attempt.targetRcpt === null && /timeout/i.test(attempt.netError ?? ''));
    if (!retryable || i === SMTP_MAX_ATTEMPTS - 1) break;
    await sleep(SMTP_RETRY_BACKOFF_MS * (i + 1));
  }

  const smtpReason = (l: string | null): string => l ?? attempt.netError ?? 'no-reply';

  // Connection-level failure: them or us? Control probe decides.
  if (isNetFailure(attempt)) {
    if (!(await d.smtpControlOk())) {
      return fail('UNVERIFIED', 'MEDIUM', 'Mail server exists, mailbox unconfirmed (this network blocks SMTP)', {
        mx: mxEvidence,
        roleBased: { isRoleBased: roleBased },
        smtp: { status: 'UNKNOWN', reason: smtpReason(null) },
      });
    }
    return fail('UNKNOWN', 'LOW', `Mail server unreachable (${attempt.netError}) — not invalid`, {
      mx: mxEvidence,
      roleBased: { isRoleBased: roleBased },
      smtp: { status: 'UNKNOWN', reason: attempt.netError ?? 'unreachable' },
    });
  }

  const probeAccepted = !!attempt.probeRcpt && /^250|^251/.test(attempt.probeRcpt);
  const t = attempt.targetRcpt ?? '';

  // Explicit recipient rejection => the ONE strong-negative SMTP signal.
  if (/^5\d\d/.test(t)) {
    if (RECIPIENT_REJECTED_RE.test(t)) {
      return fail('INVALID', 'HIGH', `Mailbox rejected by server (${t.slice(0, 80)})`, {
        mx: mxEvidence,
        roleBased: { isRoleBased: roleBased },
        smtp: { status: 'REJECTED', reason: t.slice(0, 120) },
        catchAll: { status: probeAccepted ? 'TRUE' : 'FALSE' },
      });
    }
    return fail('UNKNOWN', 'LOW', `Server refused for policy reasons (${t.slice(0, 80)}) — not proof of a dead mailbox`, {
      mx: mxEvidence,
      roleBased: { isRoleBased: roleBased },
      smtp: { status: 'UNKNOWN', reason: t.slice(0, 120) },
      catchAll: { status: probeAccepted ? 'TRUE' : 'FALSE' },
    });
  }

  // Temporary replies are never verdicts (MX present => plausible => UNVERIFIED).
  if (isTempFailure(t)) {
    return fail('UNVERIFIED', 'LOW', `Temporary server reply (${t.slice(0, 80)}) — retry later, not invalid`, {
      mx: mxEvidence,
      roleBased: { isRoleBased: roleBased },
      smtp: { status: 'UNKNOWN', reason: t.slice(0, 120) },
      catchAll: { status: probeAccepted ? 'TRUE' : 'FALSE' },
    });
  }

  // Accepted — but catch-all domains accept everything, so certainty is capped.
  if (/^250|^251/.test(t)) {
    if (probeAccepted) {
      return fail('UNVERIFIED', 'MEDIUM', 'Server accepts all addresses (catch-all) — mailbox existence unconfirmed', {
        mx: mxEvidence,
        roleBased: { isRoleBased: roleBased },
        smtp: { status: 'ACCEPTED', reason: t.slice(0, 120) },
        catchAll: { status: 'TRUE' },
      });
    }
    // A-fallback accepts are weaker evidence (unusual config) — cap at UNVERIFIED.
    if (viaAfallback) {
      return fail('UNVERIFIED', 'MEDIUM', 'Mailbox accepted via domain fallback (no MX) — plausible, unconfirmed', {
        mx: mxEvidence,
        roleBased: { isRoleBased: roleBased },
        smtp: { status: 'ACCEPTED', reason: t.slice(0, 120) },
        catchAll: { status: 'FALSE' },
      });
    }
    return fail('VALID', 'HIGH', 'Mailbox accepted by receiving server', {
      mx: mxEvidence,
      roleBased: { isRoleBased: roleBased },
      smtp: { status: 'ACCEPTED', reason: t.slice(0, 120) },
      catchAll: { status: 'FALSE' },
    });
  }

  // Anything else unrecognized => UNKNOWN, never INVALID.
  return fail('UNKNOWN', 'LOW', `Unrecognized server reply (${t.slice(0, 80)}) — not invalid`, {
    mx: mxEvidence,
    roleBased: { isRoleBased: roleBased },
    smtp: { status: 'UNKNOWN', reason: t.slice(0, 120) },
    catchAll: { status: probeAccepted ? 'TRUE' : 'FALSE' },
  });
}


// ---------------------------------------------------------------- sendability estimate
// A transparent, rule-based aid — NOT an inbox-placement promise. Real
// deliverability also depends on sender reputation, content, and the
// recipient server, which this tool does not measure. Never 0 / never 100.
export type SendTier = 'READY' | 'CAUTION' | 'HOLD';

export interface SendScore {
  score: number;
  tier: SendTier;
  reasons: string[];
}

export function sendabilityScore(input: {
  verdict: string;
  confidence: string;
  roleBased?: boolean;
  catchAll?: boolean;
  manual?: boolean;
}): SendScore {
  const v = (input.verdict ?? '').toUpperCase();
  const c = (input.confidence ?? '').toUpperCase();
  const reasons: string[] = [];
  let score: number;

  if (v === 'INVALID') {
    return { score: 10, tier: 'HOLD', reasons: ['Mailbox unusable — do not send'] };
  }
  if (v === 'VALID' && c === 'HIGH') {
    score = 90;
    reasons.push('Mailbox accepted by receiving server');
  } else if (v === 'VALID') {
    score = 80;
    reasons.push('Mailbox accepted (medium certainty)');
  } else if (v === 'UNVERIFIED' && c === 'MEDIUM') {
    score = 60;
    reasons.push('Domain can receive mail, mailbox unconfirmed');
  } else if (v === 'UNVERIFIED') {
    score = 50;
    reasons.push('Plausible address, low certainty');
  } else {
    score = 40;
    reasons.push('Address never confirmed — send with care');
  }

  if (input.roleBased) {
    score -= 10;
    reasons.push('Role address — may not reach the decision maker');
  }
  if (input.catchAll) {
    score -= 10;
    reasons.push('Catch-all domain — mail may vanish silently');
  }
  if (input.manual) {
    reasons.push('Confirmed by you');
  }
  score = Math.max(5, Math.min(95, score));
  const tier: SendTier = score >= 75 ? 'READY' : score >= 40 ? 'CAUTION' : 'HOLD';
  return { score, tier, reasons };
}
