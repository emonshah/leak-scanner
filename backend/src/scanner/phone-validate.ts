import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * Strict phone validation (deterministic, no regex guessing).
 * Target market: US / UK / CA / AU local services (US+UK first) + BD
 * (agency home market — footers commonly show 01XXXXXXXXX local format).
 * A candidate is kept ONLY when libphonenumber confirms it is
 * possible+valid for one of these regions. '+'-prefixed internationals
 * resolve by prefix regardless of region order.
 */

const DEFAULT_REGIONS = ['US', 'GB', 'CA', 'AU', 'BD'] as const;
type Region = (typeof DEFAULT_REGIONS)[number];

export interface ValidatedPhone {
  e164: string;
  national: string;
  country: string;
}

export function validatePhone(raw: string): ValidatedPhone | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  for (const region of DEFAULT_REGIONS) {
    try {
      const p = parsePhoneNumberFromString(trimmed, region as Region);
      if (p && p.isPossible() && p.isValid()) {
        return { e164: p.number, national: p.formatNational(), country: p.country ?? region };
      }
    } catch {
      /* try next region */
    }
  }
  return null;
}

/** Validate the number inside a tel: URI (strips params like ;ext=). */
export function validateTelUri(href: string): ValidatedPhone | null {
  const m = /^tel:\s*([^;?]+)/i.exec(href.trim());
  if (!m?.[1]) return null;
  return validatePhone(m[1].trim());
}

export function digitsOf(e164: string): string {
  return e164.replace(/\D/g, '');
}

/**
 * Structurally dialable check for tel: URIs — deliberately looser than
 * validatePhone. A mobile dialer attempts ANY 7–15 digit string; it does
 * NOT consult libphonenumber's assigned-range tables. Flagging
 * "possible but unassigned" numbers (e.g. +17864609233) as "dialer will
 * fail" is a 100% false positive. MMI/USSD codes (*, #) are skipped —
 * they are service codes, not phone claims.
 */
export function validateDialable(href: string): string | null {
  const m = /^(?:tel|callto|wtai):\s*([^;?]+)/i.exec(href.trim());
  if (!m?.[1]) return null;
  const num = m[1].trim();
  if (/[*#]/.test(num)) return num; // service code — not our claim to judge
  const d = num.replace(/\D/g, '');
  if (d.length < 7 || d.length > 15) return null;
  return d;
}

/**
 * Trunk-normalized digit compare — the #1 false-positive killer.
 * Text "(555) 123-4567" (10 digits) and href "tel:+15551234567" (11 digits)
 * dial the SAME endpoint; exact-digit compare misses it every time.
 * Rules: NANP leading 1 (11→10 digits), UK 44→0 trunk (12→11 digits),
 * AU 61→0 trunk (11→10 digits: +61412345678 vs tel:0412345678),
 * BD 880→0 trunk (13→11 digits: +8809638138707 vs tel:09638138707).
 * Minimum 10 digits so short-codes never false-match.
 */
function trunk(digits: string): string {
  let x = digits.replace(/\D/g, '');
  if (x.length === 11 && x.startsWith('1')) x = x.slice(1);
  if (x.length === 12 && x.startsWith('44')) x = `0${x.slice(2)}`;
  if (x.length === 11 && x.startsWith('61')) x = `0${x.slice(2)}`;
  if (x.length === 13 && x.startsWith('880')) x = `0${x.slice(3)}`;
  return x;
}

export function matchDigits(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = trunk(a);
  const nb = trunk(b);
  return na.length >= 10 && na === nb;
}
