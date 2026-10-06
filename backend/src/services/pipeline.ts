import { checkAvailability } from '../scanner/availability';
import { recheckMobileCtas, runBrowser } from '../scanner/browser';
import { crawlSite, fetchExtraPage } from '../scanner/crawler';
import { analyzeCtas } from '../scanner/cta';
import { buildFindings } from '../scanner/findings';
import { analyzeForms } from '../scanner/forms';
import { analyzePaths, enrichFindings, gateUncorroborated, groupFindings, scoreEnriched, suppressContradicted } from '../scanner/intelligence';
import { checkLinks } from '../scanner/links';
import { analyzePhones } from '../scanner/phone';
import { runSecuritySuite, securityFindings } from '../scanner/security-plus';
import { securityFromAvailability } from '../scanner/security';
import { detectTechnology } from '../scanner/technology';
import type { TechReport } from '../scanner/technology';
import { checkSpfDmarc, probeTlsExpiry, spfDmarcFindings, tlsFindings } from '../scanner/trust';
import type { FindingInput, ScanArtifacts, ScanQuality } from '../scanner/types';
import { crossValidateCtas } from '../scanner/visibility';
import { leakFor } from '../scanner/money-leaks';
import { harvestContactEmail } from '../scanner/email-find';
import { VERIFY_FRESH_MS, verifyEmail } from '../scanner/email-verify';
import { getScanStatus, isPaused, isCancelled, shouldStop } from './queue-state';
import {
  appendScanLog,
  getEmailVerification,
  getWebsiteContactEmail,
  getWebsiteNiche,
  maybeReviveSkippedLead,
  saveEmailVerification,
  saveFindings,
  saveHarvestedContactEmail,
  savePages,
  saveQuality,
  saveSecurityChecks,
  saveTech,
  saveUiChecks,
  setParked,
  setScanStatus,
} from './scans';

function msg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

function buildQuality(a: ScanArtifacts): ScanQuality {
  const checks = a.securityChecks;
  return {
    pagesAnalyzed: a.pages.length,
    pagesBlocked: a.pages.filter((p) => p.statusCode === 403 || p.statusCode === 429).length,
    pagesFailed: a.pages.filter((p) => p.statusCode == null || p.statusCode >= 500).length,
    checksCompleted: checks.filter((c) => ['PASS', 'FAIL', 'WARNING'].includes(c.status)).length,
    checksNotTested: checks.filter((c) => c.status === 'NOT_TESTED' || c.status === 'INCONCLUSIVE').length,
    checksManualReview: checks.filter((c) => c.status === 'REQUIRES_MANUAL_REVIEW').length,
    visualChecks:
      (a.browser?.mobile.ctaObservations.length ?? 0) +
      (a.browser?.tablet.ctaObservations.length ?? 0) +
      (a.browser?.desktop.ctaObservations.length ?? 0),
    contradictions: a.contradictions.length,
    suppressed: a.suppressedCount,
  };
}

function toPageRow(p: ScanArtifacts['pages'][number]) {
  return {
    url: p.url,
    normalizedUrl: p.normalizedUrl,
    statusCode: p.statusCode,
    finalUrl: p.finalUrl,
    responseTimeMs: p.responseTimeMs,
    isHomepage: p.isHomepage,
    title: p.title,
  };
}

export async function runScanPipeline(scanId: number, websiteId: number, seedUrl: string): Promise<void> {
  await setScanStatus(scanId, 'scanning');

  const log = async (stage: string, status: 'running' | 'done' | 'error', msg: string): Promise<void> => {
    await appendScanLog(scanId, { t: new Date().toISOString(), stage, status, msg }).catch(() => {});
  };

  const artifacts: ScanArtifacts = {
    availability: null,
    pages: [],
    links: [],
    linkChecks: [],
    phones: [],
    ctas: [],
    forms: [],
    browser: null,
    security: null,
    securityChecks: [],
    contradictions: [],
    suppressedCount: 0,
    a11y: [],
    moduleErrors: [],
  };

  const paused = async (): Promise<boolean> => {
    if (isCancelled(scanId) || (await getScanStatus(scanId)) === 'cancelled') {
      await log('done', 'error', 'Scan cancelled by user.');
      return true;
    }
    if (isPaused(scanId) || (await getScanStatus(scanId)) === 'paused') {
      await setScanStatus(scanId, 'paused');
      return true;
    }
    return shouldStop();
  };

  const nicheId = await getWebsiteNiche(websiteId);

  async function finish(raw: FindingInput[], homeUrl: string | null): Promise<number> {
    try {
      artifacts.securityChecks = await runSecuritySuite(artifacts, homeUrl ?? seedUrl);
    } catch (err) {
      artifacts.moduleErrors.push({ module: 'security-suite', error: msg(err) });
    }
    // Fail-closed: suite checks (tls-cert/https/spf/...) never become
    // findings unless their module::category maps to the money-leak
    // catalog. M2 transport/TLS coverage already comes from buildFindings.
    const withSec = [
      ...raw,
      ...securityFindings(artifacts.securityChecks, homeUrl).filter(
        (f) => leakFor(f.module, f.category) !== null,
      ),
    ];
    const filtered = gateUncorroborated(suppressContradicted(withSec, artifacts), artifacts);
    const enriched = groupFindings(enrichFindings(filtered, { homeUrl, nicheId }));
    await saveFindings(scanId, websiteId, enriched);
    await saveSecurityChecks(scanId, artifacts.securityChecks);
    await saveUiChecks(scanId, artifacts);
    await saveQuality(scanId, buildQuality(artifacts));
    return scoreEnriched(enriched).score;
  }

  try {
    await log('init', 'running', `Starting scan for ${seedUrl}`);

    await log('availability', 'running', 'Checking website...');
    try {
      artifacts.availability = await checkAvailability(seedUrl);
    } catch (err) {
      artifacts.moduleErrors.push({ module: 'availability', error: msg(err) });
    }
    if (await paused()) return;

    let homeUrl: string = seedUrl;

    if (!artifacts.availability?.ok) {
      await log('availability', 'error', artifacts.availability?.error ?? 'Probe failed');
      // M1 park filter: persistent dead sites (timeout/failed/unavailable)
      // are parked — kept in MySQL, excluded from outreach, revived by a
      // later successful scan. 'blocked' (bot protection) is transient,
      // so it never parks.
      const parkable = artifacts.availability?.status === 'timeout'
        || artifacts.availability?.status === 'failed'
        || artifacts.availability?.status === 'unavailable';
      if (parkable) {
        await setParked(websiteId, true);
        await log('availability', 'done', 'Lead parked (do-not-email) — re-scan in 7 days.');
      }

      // Bot-protection fallback: the fetch probe identifies as
      // ConversionLeakScanner and WAFs (Cloudflare challenge, Sucuri geo-block,
      // etc.) block it on sight. But the *browser* presents as a real visitor
      // (genuine Chrome UA/locale/webdriver mask) and often loads the page
      // fine — verified empirically on emergencydiscountplumbing.com (fetch
      // 403 cf-mitigated:challenge, Playwright desktop 200 real title).
      // So when the probe is blocked, don't give up: try the browser. If it
      // also fails, THEN mark blocked. If it succeeds, continue the scan.
      const blockedByProbe = artifacts.availability?.status === 'blocked';
      if (blockedByProbe) {
        await log('init', 'running', 'Probe blocked — retrying via real browser (may pass WAF challenge)...');
        try {
          artifacts.browser = await runBrowser(seedUrl, scanId);
        } catch (err) {
          artifacts.moduleErrors.push({ module: 'browser', error: msg(err) });
        }
        if (await paused()) return;
        if (artifacts.browser && !artifacts.browser.blocked) {
          // Browser got through — the site IS reachable. Override the
          // probe's blocked verdict and continue the full scan.
          artifacts.availability = {
            ok: true,
            status: 'available',
            httpStatus: 200,
            finalUrl: seedUrl,
            https: seedUrl.toLowerCase().startsWith('https'),
            redirectChain: [],
            redirectCount: 0,
            responseTimeMs: artifacts.browser.desktop.loadMs ?? null,
            ttfbMs: artifacts.browser.desktop.ttfbMs ?? null,
            headers: {},
            certExpiry: null,
            error: null,
            incomplete: false,
            incompleteReason: null,
            attempts: 1,
          };
          artifacts.security = securityFromAvailability(artifacts.availability);
          await setParked(websiteId, false);
          homeUrl = seedUrl;
          await log('availability', 'done', 'Connected via browser (WAF challenge passed)');
          // fall through to the normal crawl/browser pipeline below
        } else {
          const opportunityScore = await finish(buildFindings(artifacts, seedUrl, nicheId), seedUrl);
          await setScanStatus(scanId, 'blocked', {
            error: artifacts.browser?.blockedReason ?? artifacts.availability?.error ?? 'Bot protection detected',
            opportunityScore,
          });
          return;
        }
      } else {
        const opportunityScore = await finish(buildFindings(artifacts, seedUrl, nicheId), seedUrl);
        await setScanStatus(scanId, 'failed', {
          error: artifacts.availability?.error ?? 'Probe failed',
          opportunityScore,
        });
        return;
      }
    } else {
      // Site answered — revive any parked lead automatically.
      await setParked(websiteId, false);

      homeUrl = artifacts.availability.finalUrl ?? seedUrl;
      artifacts.security = securityFromAvailability(artifacts.availability);
      await log('init', 'done', `Target locked: ${homeUrl}`);
      await log('availability', 'done', `Connected (${artifacts.availability.status ?? 200})`);
    }

    await log('crawl', 'running', 'Crawling pages...');
    try {
      const { pages, links } = await crawlSite(homeUrl, { maxPages: 12 });
      artifacts.pages = pages;
      artifacts.links = links;
    } catch (err) {
      artifacts.moduleErrors.push({ module: 'crawler', error: msg(err) });
    }
    if (await paused()) return;
    {
      const pageLines = artifacts.pages.slice(0, 20).map((p) => {
        const code = p.statusCode ?? 'ERR';
        const title = p.title ? ` — ${p.title.slice(0, 60)}` : '';
        return `  ${code}: ${p.url}${title}`;
      });
      const extra = artifacts.pages.length > 20 ? `\n  ...and ${artifacts.pages.length - 20} more` : '';
      await log('crawl', 'done', `Found ${artifacts.pages.length} pages\n${pageLines.join('\n')}${extra}`);
    }

    await log('links', 'running', 'Checking links...');
    try {
      artifacts.linkChecks = await checkLinks(artifacts.links);
    } catch (err) {
      artifacts.moduleErrors.push({ module: 'links', error: msg(err) });
    }
    if (await paused()) return;
    {
      const broken = artifacts.linkChecks.filter((l) => l.broken || (l.status !== null && l.status >= 400));
      const redirected = artifacts.linkChecks.filter((l) => l.status !== null && l.status >= 300 && l.status < 400);
      let m = `${artifacts.linkChecks.length} links checked`;
      if (broken.length > 0) {
        m += `\n  ${broken.length} broken:`;
        for (const l of broken.slice(0, 15)) {
          m += `\n    ${l.status ?? 'ERR'}: ${l.url}`;
        }
        if (broken.length > 15) m += `\n    ...and ${broken.length - 15} more`;
      }
      if (redirected.length > 0) {
        m += `\n  ${redirected.length} redirects:`;
        for (const l of redirected.slice(0, 10)) {
          m += `\n    ${l.status}: ${l.url}`;
        }
        if (redirected.length > 10) m += `\n    ...and ${redirected.length - 10} more`;
      }
      if (broken.length === 0 && redirected.length === 0) m += '\n  All links OK';
      await log('links', 'done', m);
    }

    try {
      const seedHost = new URL(homeUrl).hostname.toLowerCase().replace(/^www\./, '');
      const known = new Set(
        artifacts.pages.flatMap((p) => [p.url, p.finalUrl ?? ''].filter(Boolean).map((u) => u.replace(/\/$/, '').toLowerCase())),
      );
      let fetched = 0;
      for (const l of artifacts.links) {
        if (fetched >= 4) break;
        const href = l.absoluteUrl ?? l.href;
        if (!href || !/^https?:\/\//i.test(href)) continue;
        let u: URL;
        try {
          u = new URL(href);
        } catch {
          continue;
        }
        if (u.hostname.toLowerCase().replace(/^www\./, '') !== seedHost) continue;
        if (!/contact|quote|book|estimate|appointment|get-started|signup|sign-up|schedule|consult|demo|message|calendar|trial|callback/i.test(u.pathname)) continue;
        const key = href.replace(/\/$/, '').toLowerCase();
        if ([...known].some((k) => k === key)) continue;
        const extra = await fetchExtraPage(href);
        if (extra) {
          artifacts.pages.push(extra);
          known.add(extra.url.replace(/\/$/, '').toLowerCase());
          if (extra.finalUrl) known.add(extra.finalUrl.replace(/\/$/, '').toLowerCase());
          fetched++;
        }
      }
      if (fetched > 0) await log('crawl', 'done', `Backfilled ${fetched} quote/contact page${fetched === 1 ? '' : 's'} for path checks`);
    } catch (err) {
      artifacts.moduleErrors.push({ module: 'dest-backfill', error: msg(err) });
    }

    await log('content', 'running', 'Analyzing content...');
    try {
      artifacts.phones = analyzePhones(artifacts.pages, artifacts.links);
      artifacts.ctas = analyzeCtas(artifacts.pages, artifacts.linkChecks);
      artifacts.forms = analyzeForms(artifacts.pages);
    } catch (err) {
      artifacts.moduleErrors.push({ module: 'content', error: msg(err) });
    }

    let emailLine: string | null = null;
    let verifyTarget: string | null = null;
    let verifyPromise: Promise<import('../scanner/email-verify.js').VerifyOutcome> | null = null;
    try {
      const found = harvestContactEmail(artifacts.pages);
      if (found) {
        const existing = await getWebsiteContactEmail(websiteId);
        if (existing) {
          emailLine = 'Contact email already on file (import) — left untouched';
          verifyTarget = existing;
        } else if (await saveHarvestedContactEmail(websiteId, found.email)) {
          emailLine = `Contact email harvested + saved: ${found.email} (${found.source})`;
          verifyTarget = found.email;
        } else {
          emailLine = 'Contact email already on file (import) — left untouched';
          verifyTarget = await getWebsiteContactEmail(websiteId);
        }
      } else {
        verifyTarget = await getWebsiteContactEmail(websiteId);
        if (!verifyTarget) emailLine = 'No contact email found on site — add one to enable outreach';
      }
      if (verifyTarget) {
        const v = await getEmailVerification(websiteId);
        if (v.manual && v.verifiedEmail === verifyTarget) {
          emailLine = `${emailLine ?? ''}${emailLine ? '\n  ' : ''}Email marked ${v.status} by you — kept`.trim();
          verifyTarget = null;
        }
        const fresh = verifyTarget
          && v.checkedAt
          && v.verifiedEmail === verifyTarget
          && Date.now() - new Date(v.checkedAt).getTime() < VERIFY_FRESH_MS;
        if (fresh) {
          emailLine = `${emailLine ?? ''}${emailLine ? '\n  ' : ''}Email already verified (${v.status}) — skipped`.trim();
        } else if (verifyTarget) {
          const target: string = verifyTarget;
          verifyPromise = verifyEmail(target).catch(
            async (): Promise<import('../scanner/email-verify.js').VerifyOutcome> => ({
              verdict: 'UNKNOWN',
              confidence: 'LOW',
              reason: 'Check crashed before evidence — not invalid',
              evidence: {
                originalEmail: target,
                normalizedEmail: target,
                syntax: { status: 'VALID' },
                domain: { status: 'VALID', domain: '' },
                dns: { status: 'ERROR' },
                mx: { status: 'ERROR', records: [] },
                roleBased: { isRoleBased: false },
                disposable: { status: 'UNKNOWN' },
                smtp: { status: 'SKIPPED', reason: 'crash' },
                catchAll: { status: 'UNKNOWN' },
                final: { verdict: 'UNKNOWN', confidence: 'LOW', reason: 'Check crashed before evidence — not invalid' },
              },
            }),
          );
        }
      }
    } catch (err) {
      artifacts.moduleErrors.push({ module: 'email-harvest', error: msg(err) });
    }
    if (await paused()) return;
    {
      let m = `${artifacts.phones.length} phones, ${artifacts.ctas.length} CTAs, ${artifacts.forms.length} forms`;
      if (emailLine) m += `\n  ${emailLine}`;
      if (artifacts.phones.length > 0) {
        m += '\n  Phones:';
        for (const p of artifacts.phones.slice(0, 10)) {
          m += `\n    ${p.raw} (on ${p.page})`;
        }
      }
      if (artifacts.ctas.length > 0) {
        m += '\n  CTAs:';
        for (const c of artifacts.ctas.slice(0, 10)) {
          m += `\n    "${c.text}" → ${c.href ?? 'no link'} (${c.visibleOnMobile === false ? 'hidden on mobile' : 'visible'})`;
        }
        if (artifacts.ctas.length > 10) m += `\n    ...and ${artifacts.ctas.length - 10} more`;
      }
      if (artifacts.forms.length > 0) {
        m += '\n  Forms:';
        for (const f of artifacts.forms.slice(0, 5)) {
          const fields = [];
          if (f.hasEmailField) fields.push('email');
          if (f.hasPhoneField) fields.push('phone');
          if (f.hasMessageField) fields.push('message');
          if (f.hasCaptcha) fields.push('captcha');
          if (!f.hasSubmit) fields.push('NO submit btn');
          m += `\n    ${f.method.toUpperCase()} ${f.action ?? f.page} — fields: ${fields.join(', ') || f.fieldCount}`;
        }
      }
      await log('content', 'done', m);
    }

    await log('browser', 'running', 'Browser testing...');
    try {
      artifacts.browser = await runBrowser(homeUrl, scanId);
      const mobileObs = artifacts.browser.mobile.ctaObservations;
      if (mobileObs.length === 0 && artifacts.ctas.length > 0 && !artifacts.browser.mobile.loadError) {
        try {
          const again = await recheckMobileCtas(homeUrl, scanId);
          if (again.length > 0) {
            artifacts.browser.mobile.ctaObservations = again;
            artifacts.contradictions.push({
              area: 'mobile-cta',
              domSays: 'first pass observed nothing',
              visualSays: `recheck observed ${again.length} CTA(s)`,
              resolution: 'RECHECKED',
            });
          }
        } catch (err) {
          artifacts.moduleErrors.push({ module: 'browser-recheck', error: msg(err) });
        }
      }

      const crawlerHrefs = [
        ...new Set(
          artifacts.links
            .filter((l) => l.kind === 'internal' && l.importance !== 'normal')
            .map((l) => l.absoluteUrl ?? ''),
        ),
      ]
        .filter(Boolean)
        .slice(0, 30);
      const allObs = [
        ...artifacts.browser.mobile.ctaObservations,
        ...artifacts.browser.tablet.ctaObservations,
        ...artifacts.browser.desktop.ctaObservations,
      ].map((o) => ({ text: o.text, href: o.href, verdict: o.verdict }));
      const xv = crossValidateCtas(crawlerHrefs, allObs);
      for (const c of xv.contradictions) {
        artifacts.contradictions.push({ ...c, resolution: 'INCONCLUSIVE' });
      }
      artifacts.suppressedCount += xv.suppressed.length;

      try {
        const { reconcilePhoneDialProofs } = await import('../scanner/phone');
        const fixed = reconcilePhoneDialProofs(artifacts.phones, [
          ...artifacts.browser.mobile.ctaObservations,
          ...artifacts.browser.tablet.ctaObservations,
          ...artifacts.browser.desktop.ctaObservations,
        ]);
        if (fixed > 0) {
          artifacts.contradictions.push({
            area: 'phone-reconcile',
            domSays: 'no tel: link in markup',
            visualSays: `browser dial-proof for ${fixed} number(s)`,
            resolution: 'SUPPRESSED',
          });
          artifacts.suppressedCount += fixed;
        }
      } catch (err) {
        artifacts.moduleErrors.push({ module: 'phone-reconcile', error: msg(err) });
      }

      // Rendered-DOM second pass: static fetch never sees JS-injected
      // numbers/forms (React/Elementor hydration). Re-run the extractors on
      // the settled mobile DOM and merge — endpoint-dedupe for phones (same
      // number twice is one opportunity), signature-dedupe in formFindings
      // covers same-form repeats. Never breaks the scan.
      try {
        const rendered = artifacts.browser.mobile.renderedHtml;
        if (rendered && rendered.length > 1000) {
          const renderedPage = {
            url: homeUrl,
            normalizedUrl: homeUrl,
            statusCode: 200 as number | null,
            finalUrl: homeUrl as string | null,
            responseTimeMs: null as number | null,
            title: null as string | null,
            isHomepage: true,
            html: rendered,
          };
          const strip = (s: string): string => (s ?? '').replace(/\D/g, '');
          const havePhones = new Set(
            artifacts.phones.map((p) => strip(p.e164 ?? p.normalized ?? p.raw)),
          );
          let newPhones = 0;
          for (const p of analyzePhones([renderedPage], artifacts.links)) {
            const k = strip(p.e164 ?? p.normalized ?? p.raw);
            if (!k || havePhones.has(k)) continue;
            havePhones.add(k);
            artifacts.phones.push(p);
            newPhones++;
          }
          const formsBefore = artifacts.forms.length;
          for (const f of analyzeForms([renderedPage])) artifacts.forms.push(f);
          const newForms = artifacts.forms.length - formsBefore;
          if (newPhones > 0 || newForms > 0) {
            await log('content', 'done', `Rendered DOM top-up: +${newPhones} phone(s), +${newForms} form(s) JS-injected`);
          }
        }
      } catch (err) {
        artifacts.moduleErrors.push({ module: 'rendered-dom', error: msg(err) });
      }
    } catch (err) {
      artifacts.moduleErrors.push({ module: 'browser', error: msg(err) });
    }
    if (await paused()) return;
    {
      const b = artifacts.browser;
      if (b) {
        const viewports = ['desktop', 'tablet', 'mobile'].filter((v) => !(b.blocked && v !== 'desktop'));
        let bm = `Tested: ${viewports.join(', ')}`;
        for (const vp of viewports) {
          const r = b[vp as keyof typeof b] as {
            loadMs: number | null;
            ttfbMs: number | null;
            loadError: string | null;
            horizontalOverflow: boolean;
            jsErrors: string[];
          } | undefined;
          if (!r) continue;
          if (r.loadError) {
            bm += `\n  ${vp}: ERROR — ${r.loadError}`;
          } else {
            bm += `\n  ${vp}: ${r.loadMs ?? '?'}ms load, ${r.ttfbMs ?? '?'}ms ttfb`;
            if (r.horizontalOverflow) bm += `, horizontal overflow`;
            if (r.jsErrors.length > 0) bm += `, ${r.jsErrors.length} JS errors`;
          }
        }
        await log('browser', 'done', bm);
      } else {
        await log('browser', 'done', 'Browser test failed');
      }
    }

    if (verifyPromise && verifyTarget) {
      try {
        const out = await verifyPromise;
        await saveEmailVerification(websiteId, verifyTarget, {
          verdict: out.verdict,
          confidence: out.confidence,
          reason: out.reason,
          evidence: out.evidence,
        });
        await log('content', 'done', `Email check: ${verifyTarget} → ${out.verdict} (${out.confidence}, ${out.reason})`);
      } catch (err) {
        artifacts.moduleErrors.push({ module: 'email-verify', error: msg(err) });
      }
      verifyPromise = null;
    }

    if (artifacts.browser?.blocked) {
      await savePages(scanId, artifacts.pages.map(toPageRow));
      const opportunityScore = await finish(buildFindings(artifacts, homeUrl, nicheId), homeUrl);
      await setScanStatus(scanId, 'blocked', {
        error: artifacts.browser.blockedReason ?? 'Bot protection detected',
        opportunityScore,
      });
      return;
    }

    const trustFindings: FindingInput[] = [];
    await log('trust', 'running', 'Checking TLS certificate...');
    try {
      const host = new URL(homeUrl).hostname;
      // Money-leak catalog: TLS expiry (M2) + mail-auth (M14 deliverability).
      // DNS failure = INCONCLUSIVE, never a claim.
      const tlsProbe = await probeTlsExpiry(host);
      trustFindings.push(...tlsFindings(tlsProbe, homeUrl));
      await log(
        'trust',
        'done',
        `TLS: ${tlsProbe.daysLeft != null ? `${tlsProbe.daysLeft}d left` : (tlsProbe.error ?? 'untestable')}`,
      );
      const mailAuth = await checkSpfDmarc(host);
      trustFindings.push(...spfDmarcFindings(mailAuth, homeUrl));
      await log(
        'trust',
        'done',
        `Mail-auth: ${mailAuth.error ?? `SPF ${mailAuth.spf ? 'ok' : 'MISSING'}, DMARC ${mailAuth.dmarc ? 'ok' : 'MISSING'}`}`,
      );
    } catch (err) {
      artifacts.moduleErrors.push({ module: 'trust', error: msg(err) });
      await log('trust', 'error', 'Trust probes failed — continuing without them.');
    }
    if (await paused()) return;

    await log('build', 'running', 'Building findings...');
    const raw = [...buildFindings(artifacts, homeUrl, nicheId), ...trustFindings, ...analyzePaths(artifacts)];
    await savePages(scanId, artifacts.pages.map(toPageRow));

    let tech: TechReport | null = null;
    await log('technology', 'running', 'Detecting technology stack...');
    try {
      tech = await detectTechnology(
        artifacts.pages,
        artifacts.availability?.headers ?? {},
        [...(artifacts.browser?.mobile.resources ?? []), ...(artifacts.browser?.desktop.resources ?? [])],
        homeUrl,
      );
      await saveTech(scanId, tech);
    } catch (err) {
      artifacts.moduleErrors.push({ module: 'technology', error: msg(err) });
    }
    {
      let tm = 'Technology detection complete';
      if (tech) {
        const names = tech.items.slice(0, 8).map((i) => `${i.technology}${i.version ? ` ${i.version}` : ''}`);
        tm += `\n  Platform: ${tech.primaryPlatform}`;
        if (names.length > 0) {
          tm += '\n  Stack:';
          for (const n of names) tm += `\n    - ${n}`;
        }
        if (tech.wordpress?.detected) {
          tm += `\n  WordPress ${tech.wordpress.version ? `v${tech.wordpress.version}` : '(version hidden)'}`;
          if (tech.wordpress.theme) tm += `\n  Theme: ${tech.wordpress.theme.name ?? tech.wordpress.theme.slug}`;
        }
      } else {
        tm += '\n  Detection failed — continuing anyway';
      }
      await log('technology', 'done', tm);
    }

    await log('security', 'running', 'Running security checks...');
    // Money-leak catalog: CVE disclosures, wp-json user lists, and xmlrpc
    // probes never close a small-business deal (and read as threats in
    // outreach), so they are no longer emitted as findings. The passive
    // security_checks suite still runs for the Security tab.
    await log('security', 'done', 'Skipped as findings (not a money leak) — see Security tab for passive checks.');

    {
      let sm = 'Security scan complete';
      if (tech?.wordpress?.detected) {
        sm += '\n  WordPress detected';
        if (tech.wordpress.theme) sm += `\n  Theme: ${tech.wordpress.theme.name ?? tech.wordpress.theme.slug}`;
      }
      const highFindings = raw.filter((f) => f.severity === 'EMERGENCY' || f.severity === 'HIGH');
      if (highFindings.length > 0) {
        sm += `\n  ${highFindings.length} high/critical findings:`;
        for (const f of highFindings.slice(0, 10)) {
          sm += `\n    [${f.severity}] ${f.title}`;
        }
        if (highFindings.length > 10) sm += `\n    ...and ${highFindings.length - 10} more`;
      }
      await log('security', 'done', sm);
    }

    const opportunityScore = await finish(raw, homeUrl);
    const bySev = new Map<string, number>();
    for (const f of raw) bySev.set(f.severity, (bySev.get(f.severity) ?? 0) + 1);
    const majorCount = (bySev.get('EMERGENCY') ?? 0) + (bySev.get('HIGH') ?? 0) + (bySev.get('CRITICAL') ?? 0);
    const minorCount = raw.length - majorCount;
    const sevParts = ['EMERGENCY', 'HIGH']
      .filter((s) => (bySev.get(s) ?? 0) > 0 || (s === 'EMERGENCY' && (bySev.get('CRITICAL') ?? 0) > 0))
      .map((s) => {
        const n = (bySev.get(s) ?? 0) + (s === 'EMERGENCY' ? (bySev.get('CRITICAL') ?? 0) : 0);
        return `${n} ${s.toLowerCase()}`;
      });
    if (minorCount > 0) sevParts.push(`${minorCount} minor noted`);
    await log('done', 'done', `Score: ${opportunityScore}/100\n  ${sevParts.join(', ') || 'No issues found'}\n  ${majorCount} money leaks + ${minorCount} minor noted`);
    await setScanStatus(scanId, 'completed', { opportunityScore });
    if (await maybeReviveSkippedLead(websiteId, opportunityScore)) {
      await log('done', 'done', `Skipped lead auto-revived (re-scan scored ${opportunityScore}/100) — back in To-message`);
    }
  } catch (err) {
    await setScanStatus(scanId, 'failed', {
      error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    });
  }
}
