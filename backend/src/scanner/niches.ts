/**
 * Niche-aware ranking weights. One scanner for every niche — these only
 * scale the priority score of conversion categories, transparently.
 * Phase 1+2 (Forensic): 2 mega-groups keep thresholds crash-safe.
 *   EMERGENCY (plumbing, water-damage, towing, locksmith): phone call is life.
 *   BOOKING   (everything else incl. pest + landscaping): quote/form is life.
 * Boost range 1.0-2.0 so a niche-boosted HIGH can overtake a generic
 * EMERGENCY after the cap was raised to 45 (see intelligence.ts).
 */

export type PathKey = 'call' | 'quote' | 'booking' | 'form';

export type MegaGroup = 'EMERGENCY' | 'BOOKING';

export interface NicheProfile {
  id: string;
  label: string;
  mega: MegaGroup;
  boosts: Record<PathKey, number>;
}

export const EMERGENCY_LCP_MS = 3000;
export const BOOKING_LCP_MS = 4000;
export const EMERGENCY_TTFB_MS = 1200;
export const BOOKING_TTFB_MS = 1800;

export const NICHES: NicheProfile[] = [
  { id: 'general', label: 'General local service', mega: 'BOOKING', boosts: { call: 1, quote: 1, booking: 1, form: 1 } },
  // ── EMERGENCY group: phone CTA = CRITICAL ──
  { id: 'plumbing', label: 'Plumbing (emergency)', mega: 'EMERGENCY', boosts: { call: 2.0, quote: 1.1, booking: 1, form: 1 } },
  { id: 'water-damage', label: 'Water Damage Restoration', mega: 'EMERGENCY', boosts: { call: 2.0, quote: 1.1, booking: 1, form: 1 } },
  { id: 'towing', label: 'Towing', mega: 'EMERGENCY', boosts: { call: 2.0, quote: 1.1, booking: 1, form: 1 } },
  { id: 'locksmith', label: 'Locksmith', mega: 'EMERGENCY', boosts: { call: 2.0, quote: 1.1, booking: 1, form: 1 } },
  // ── BOOKING group: form/quote = CRITICAL, sticky = HIGH ──
  { id: 'hvac', label: 'HVAC', mega: 'BOOKING', boosts: { call: 1.2, quote: 1.4, booking: 1.2, form: 1.3 } },
  { id: 'roofing', label: 'Roofing', mega: 'BOOKING', boosts: { call: 1.1, quote: 1.6, booking: 1.1, form: 1.3 } },
  { id: 'cleaning', label: 'Cleaning', mega: 'BOOKING', boosts: { call: 1.1, quote: 1.5, booking: 1.4, form: 1.4 } },
  { id: 'pest', label: 'Pest control', mega: 'BOOKING', boosts: { call: 1.1, quote: 1.5, booking: 1.3, form: 1.3 } },
  { id: 'landscaping', label: 'Landscaping / Tree service', mega: 'BOOKING', boosts: { call: 1.1, quote: 1.5, booking: 1.3, form: 1.3 } },
  { id: 'medspa', label: 'MedSpa / Clinic', mega: 'BOOKING', boosts: { call: 1, quote: 1.2, booking: 2.0, form: 1.5 } },
  { id: 'solar', label: 'Solar', mega: 'BOOKING', boosts: { call: 1.1, quote: 1.6, booking: 1.2, form: 1.4 } },
];

export function nicheById(id: string | null | undefined): NicheProfile {
  return NICHES.find((n) => n.id === (id ?? '').toLowerCase()) ?? NICHES[0]!;
}

/** Mega-group for a niche id (unknown → BOOKING/general behaviour). */
export function megaGroupFor(nicheId: string | null | undefined): MegaGroup {
  return nicheById(nicheId).mega;
}

/** Per-mega performance thresholds (ms). */
export function getPerfThresholds(mega: MegaGroup): { lcp: number; ttfb: number } {
  return mega === 'EMERGENCY'
    ? { lcp: EMERGENCY_LCP_MS, ttfb: EMERGENCY_TTFB_MS }
    : { lcp: BOOKING_LCP_MS, ttfb: BOOKING_TTFB_MS };
}

/** Map a business category to the conversion path it belongs to. */
export function pathKeyForCategory(businessCategory: string, ctaKind?: string): PathKey | null {
  if (ctaKind === 'booking') return 'booking';
  if (ctaKind === 'call') return 'call';
  if (ctaKind === 'quote') return 'quote';
  switch (businessCategory) {
    case 'Call Conversion':
      return 'call';
    case 'Quote Conversion':
      return 'quote';
    case 'Booking Conversion':
      return 'booking';
    case 'Form Friction':
      return 'form';
    default:
      return null;
  }
}
