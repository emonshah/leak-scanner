export interface OutreachWebsite {
  id: number;
  url: string;
  businessName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  niche: string;
  city: string | null;
}

export interface OutreachScan {
  id: number;
  opportunityScore: number | null;
  status: string;
}

/** Parse bulk textarea/CSV into rows: url[, email][, niche][, name][, business][, city] */
export interface BulkRow {
  url: string;
  email: string | null;
  niche: string | null;
  name: string | null;
  business: string | null;
  city: string | null;
  line: number;
}

export function parseBulkInput(raw: string): { rows: BulkRow[]; errors: { line: number; error: string }[] } {
  const rows: BulkRow[] = [];
  const errors: { line: number; error: string }[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((ln, idx) => {
    const lineNo = idx + 1;
    const trimmed = ln.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    // Accept comma, semicolon, tab or pipe separated. First col = url.
    const parts = trimmed.split(/[,;\t|]/).map((s) => s.trim()).filter((s) => s.length > 0);
    if (parts.length === 0) return;
    const url = parts[0] ?? '';
    if (!url || url.length < 4 || !url.includes('.')) {
      errors.push({ line: lineNo, error: `Bad URL: ${url.slice(0, 80)}` });
      return;
    }
    const pick = (i: number): string | null => (parts[i] && parts[i]!.length > 0 ? parts[i]! : null);
    rows.push({
      url,
      email: pick(1),
      niche: pick(2)?.toLowerCase() ?? null,
      name: pick(3),
      business: pick(4),
      city: pick(5),
      line: lineNo,
    });
    if (rows.length >= 200) return;
  });
  return { rows: rows.slice(0, 200), errors };
}

export function toLeadCsv(rows: Record<string, unknown>[]): string {
  const header = ['website_id', 'url', 'contact_email', 'email_status', 'niche', 'score', 'top_issue', 'scan_id', 'scan_status', 'lead_status'];
  const esc = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [header.join(',')];
  for (const r of rows) out.push(header.map((h) => esc(r[h])).join(','));
  return out.join('\n') + '\n';
}
