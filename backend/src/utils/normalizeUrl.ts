/**
 * URL helpers. Single responsibility: validate + normalize user-pasted URLs.
 * Full URL management (DB persistence) lands in STEP 4.
 */

export function normalizeUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Empty URL');
  if (/\s/.test(trimmed)) throw new Error('URL must not contain spaces');
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withProto); // throws on invalid
  } catch {
    throw new Error('Invalid domain. Examples: emonshah.com, https://emonshah.com');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  const hostRaw = u.hostname.toLowerCase();
  // Accept FQDN form with a single trailing dot (example.com.)
  const host = hostRaw.endsWith('.') && hostRaw.length > 1 ? hostRaw.slice(0, -1) : hostRaw;
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.') || host.length < 4) {
    throw new Error('Invalid domain. Examples: emonshah.com, https://emonshah.com');
  }
  if (!/^[a-z0-9.-]+$/i.test(host)) {
    throw new Error('Invalid domain. Examples: emonshah.com, https://emonshah.com');
  }
  // Strip trailing slash for root, lowercase host
  u.hostname = host;
  return u.toString();
}

export function isValidHttpUrl(input: string): boolean {
  try {
    normalizeUrl(input);
    return true;
  } catch {
    return false;
  }
}
