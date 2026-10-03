/** Short display for a site URL: hostname without www (e.g. emonshah.com). */
export function shortSite(raw: string | null | undefined): string {
  if (!raw) return '—';
  const t = raw.trim();
  try {
    const withProto = /^https?:\/\//i.test(t) ? t : `https://${t}`;
    const host = new URL(withProto).hostname.replace(/^www\./i, '').toLowerCase();
    return host || t;
  } catch {
    return t.length > 32 ? `${t.slice(0, 31)}…` : t;
  }
}

/** Absolute https URL for visiting the site (falls back to raw input). */
export function visitUrl(raw: string | null | undefined, normalized?: string | null): string {
  const n = (normalized ?? '').trim();
  if (n) return n;
  const t = (raw ?? '').trim();
  if (!t) return '#';
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

const TWO_LEVEL_SUFFIX = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk',
  'com.bd', 'co.bd', 'org.bd', 'net.bd', 'edu.bd', 'gov.bd', 'mil.bd',
  'co.in', 'co.jp', 'com.au', 'co.nz', 'co.za', 'com.br',
]);

/**
 * Brand name for table display: domain without www/TLD, max 10 chars.
 * emonshah.com -> emonshah (8). Common suffixes (.com, .com.bd) dropped.
 */
export function brandName(raw: string | null | undefined, max = 10): string {
  if (!raw) return '—';
  const t = raw.trim();
  try {
    const withProto = /^https?:\/\//i.test(t) ? t : `https://${t}`;
    const host = new URL(withProto).hostname.replace(/^www\./i, '').toLowerCase();
    const parts = host.split('.').filter(Boolean);
    if (parts.length === 0) return t.length > max ? `${t.slice(0, max)}…` : t;
    if (parts.length === 1) {
      const solo = parts[0]!;
      return solo.length > max ? `${solo.slice(0, max)}…` : solo;
    }
    const lastTwo = parts.slice(-2).join('.');
    const suffixParts = TWO_LEVEL_SUFFIX.has(lastTwo) ? 2 : 1;
    const idx = parts.length - suffixParts - 1;
    const brand = (idx >= 0 ? parts[idx] : parts[0]) ?? parts[0]!;
    return brand.length > max ? `${brand.slice(0, max)}…` : brand;
  } catch {
    const flat = t.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0] ?? t;
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  }
}
