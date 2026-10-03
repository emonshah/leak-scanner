import { fixRecipeFor } from '../scanner/fix-recipe.js';
import { isDeadSiteSignal, leakFor, moneyHookFor, storyFor, type ClientStory } from '../scanner/money-leaks.js';
import { nicheById } from '../scanner/niches.js';
import type { FindingRow } from '../scanner/types.js';
import type { OutreachScan, OutreachWebsite } from './outreach.js';

const MAX_FINDINGS = 8;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function firstNameOf(contactName: string | null): string {
  if (!contactName) return 'there';
  return contactName.trim().split(/\s+/)[0] || 'there';
}

function oneLine(s: string | null | undefined, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '—';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface LlmBriefOpts {
  /** Pages successfully crawled (context for absence-claims like M3/M8). */
  pagesCrawled?: number | null;
  /** ISO date the scan completed (staleness warning when old). */
  scanDate?: string | null;
}

const STALE_DAYS = 14;

/**
 * Deterministic LLM brief builder (English). No AI, no network.
 * Produces a copy-paste prompt pack: instruction + lead facts + scan
 * evidence + output rules, so any LLM can write the cold email.
 * Top EMERGENCY/HIGH findings only, deduped by title, capped for
 * context size (~3-4KB).
 */
export function buildLlmBrief(
  website: OutreachWebsite,
  scan: OutreachScan,
  findings: FindingRow[],
  techSummary: string | null,
  senderName = 'Emon',
  opts: LlmBriefOpts = {},
): string {
  const niche = nicheById(website.niche);
  const score = scan.opportunityScore ?? 0;
  const domain = domainOf(website.url);
  const business = website.businessName ?? domain;

  // Dedupe repeat offenders (e.g. the same long form on 3 pages lists
  // once, with a count) — an LLM reading one problem three times
  // writes a weaker email. Then group into client stories (L1–L7): one
  // broken money path = one story block, even when several detectors
  // fired (L1 = M3+M4 phone path, L3 = M7+M8 capture path).
  interface StoryBlock { story: ClientStory | null; items: { f: FindingRow; n: number }[] }
  const byTitle = new Map<string, { f: FindingRow; n: number }>();
  for (const f of [...findings]
    .filter((f) => (f.severity === 'EMERGENCY' || f.severity === 'HIGH') && leakFor(f.module, f.category) !== null)
    .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))) {
    const cur = byTitle.get(f.title);
    if (cur) cur.n++;
    else byTitle.set(f.title, { f, n: 1 });
  }
  const blocks: StoryBlock[] = [];
  const blockByStory = new Map<string, StoryBlock>();
  const solo: StoryBlock[] = [];
  for (const entry of byTitle.values()) {
    const story = storyFor(entry.f.module, entry.f.category);
    if (!story) {
      solo.push({ story: null, items: [entry] });
      continue;
    }
    let b = blockByStory.get(story.id);
    if (!b) {
      b = { story, items: [] };
      blockByStory.set(story.id, b);
      blocks.push(b);
    }
    b.items.push(entry);
  }
  const top = [...blocks, ...solo].slice(0, MAX_FINDINGS);
  const deadSite = [...byTitle.values()].some(({ f }) => isDeadSiteSignal(f.module, f.category));

  const scanAgeDays = (() => {
    if (!opts.scanDate) return null;
    const t = Date.parse(opts.scanDate);
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t) / 86400000));
  })();

  const L: string[] = [];
  L.push('SYSTEM: I will upload the EMC evidence files first and then start the chat. Follow those files together with this brief.');
  L.push('SYSTEM: Write the cold emails ONLY from the facts in this brief plus the uploaded files — never invent facts, numbers, or issues.');
  L.push('');
  L.push('# ROLE');
  L.push(
    'You are an expert cold-email copywriter for a web agency that finds and fixes website conversion leaks for local service businesses.',
  );
  L.push('Write exactly ONE cold outreach email using ONLY the facts in LEAD and SCAN RESULTS below. Never invent facts, numbers, or issues not listed.');
  L.push('');
  L.push('# GOAL');
  L.push(
    `Get a reply from the business owner by showing ONE specific, verified website problem and its fix. Soft CTA: offer the 1-page screenshot report. Sender name: ${senderName}.`,
  );
  L.push('');
  L.push('# LEAD');
  L.push(`- Business: ${business}`);
  L.push(`- Website: ${domain}`);
  L.push(`- Contact first name: ${firstNameOf(website.contactName)}`);
  L.push(`- Contact email: ${website.contactEmail ?? 'unknown'}`);
  L.push(`- Niche: ${niche.label}`);
  L.push(`- City: ${website.city ?? 'unknown'}`);
  L.push(`- Conversion lifeline for this niche: ${niche.mega === 'EMERGENCY' ? 'phone calls (customers call in emergencies)' : 'quote/form fills and bookings'}`);
  L.push('');
  L.push(`# SCAN RESULTS (tested on real mobile viewport 390px, opportunity score ${score}/100 — higher means more leaks)`);
  L.push(`- Scan date: ${opts.scanDate ? opts.scanDate.slice(0, 10) : 'unknown'}`);
  L.push(`- Pages crawled: ${opts.pagesCrawled ?? 'unknown'}`);
  if (scanAgeDays != null && scanAgeDays > STALE_DAYS) {
    L.push(`- WARNING: this scan is ${scanAgeDays} days old — re-scan before outreach so the email cites fresh facts.`);
  }
  if (deadSite) {
    L.push('- DO-NOT-EMAIL: the site was unreachable when scanned — no proof, no form, no screenshots exist. Park this lead and re-scan in 7 days. Do NOT write the email.');
  }
  if (top.length === 0) {
    L.push('- No critical leaks found. Only minor polish items. Write a light-touch check-in email offering the full checklist.');
  } else {
    top.forEach((block, i) => {
      if (block.story) {
        L.push(`${i + 1}. [STORY ${block.story.id}] ${block.story.title} — email subject: "${block.story.subject}"`);
      }
      block.items.forEach(({ f, n }) => {
        const fix = fixRecipeFor({
          module: f.module,
          category: f.category,
          title: f.title,
          measuredValue: f.measuredValue,
          evidence: f.evidence as Record<string, unknown>,
        });
        const prefix = block.story ? '   -' : `${i + 1}.`;
        L.push(`${prefix} [${f.severity}] ${oneLine(f.title, 140)}${n > 1 ? ` (found on ${n} pages)` : ''}`);
        L.push(`   Meaning: ${oneLine(f.description, 220)}`);
        L.push(`   Measured: ${oneLine(f.measuredValue, 120)} | Expected: ${oneLine(f.expectedValue, 120)}`);
        L.push(`   Page: ${oneLine(f.pageUrl, 160)}`);
        // Visual proof refs: public LCP asset URL goes verbatim (the LLM
        // can link it in the email); local screenshot filenames refer to
        // the EMC evidence files uploaded with this brief.
        const det = (((f.evidence as { details?: Record<string, unknown> } | undefined)?.details ?? {}) as Record<string, unknown>);
        if (typeof det['lcp_url'] === 'string' && det['lcp_url']) {
          L.push(`   Proof image URL (public, link it in the email): ${oneLine(det['lcp_url'], 200)}`);
        }
        if (typeof det['screenshot'] === 'string' && det['screenshot']) {
          L.push(`   Proof screenshot (uploaded file): ${oneLine(det['screenshot'], 120)}`);
        }
        // Soft-evidence honesty: demoted/hedged findings carry their
        // verify-note + confidence into the brief so the LLM hedges instead
        // of writing absolutes ("literally cannot") from soft evidence.
        const verifyNote = typeof det['suppression_note'] === 'string' && det['suppression_note'] ? det['suppression_note'] : null;
        const softClaim = det['soft_claim'] === 'true';
        if (f.confidence) {
          L.push(`   Confidence: ${oneLine(f.confidence, 20)}${softClaim ? ' (soft claim — verify on a real phone before sending)' : ''}`);
        }
        if (verifyNote) {
          L.push(`   Verify note: ${oneLine(verifyNote, 200)}`);
        }
        L.push(`   Developer fix: ${oneLine(fix, 220)}`);
        const hook = moneyHookFor(f.module, f.category);
        if (hook) {
          L.push(`   Email angle: subject "${hook.subject}" — ${oneLine(hook.pain, 160)}`);
        }
      });
    });
  }
  L.push('');
  L.push(`# TECH STACK${techSummary ? '' : ' (unknown)'}`);
  L.push(techSummary ? `- ${techSummary}` : '- Could not be detected.');
  L.push('');
  L.push('# RULES');
  L.push('- Email body under 120 words. Plain text, no HTML, no attachments mentioned.');
  L.push('- When a "Proof image URL" is listed for the lead problem, include it as a plain clickable link in the body so the owner can see the exact proof (e.g. "this exact file is slowing your site: <url>"). Uploaded proof screenshots may be referenced by filename.');
  L.push('- Lead with the single most painful problem (first finding), name the page it is on.');
  L.push('- When STORY blocks are listed, build the whole email around ONE story only — never mix two stories in one email.');
  L.push('- Include the developer fix in ONE short sentence as the payoff (proof you did the work).');
  L.push('- Friendly, specific, zero hype. Banned words: free, guarantee, discount, act now, limited offer.');
  L.push('- Match certainty to evidence: findings marked "soft claim" or with a Verify note get hedged language ("appears to", "may be") — never absolutes ("literally cannot", "every visitor"). Only HIGH-confidence findings earn strong claims.');
  L.push('- End with exactly one soft question asking if they want the 1-page screenshot report.');
  L.push('- Sign off with the sender name given in GOAL.');
  L.push('');
  L.push('# OUTPUT FORMAT (follow exactly)');
  L.push('Subject: <give 3 subject line options, each under 50 characters>');
  L.push('Body:');
  L.push('<the email body>');
  return L.join('\n');
}
