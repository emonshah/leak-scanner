import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { apiFetch } from '@/api/client';
import type { Finding, ScanQuality, ScanRow } from '@/types';

const SERVABLE_SHOT_RE = /^(ev-(phone|overflow|cta|tap)-\d+\.webp|(mobile|desktop|tablet)(-recheck)?-hero(-annotated)?\.webp)$/;

interface ReportData {
  scan: ScanRow;
  website: {
    url: string;
    business_name: string | null;
    contact_name: string | null;
    niche: string | null;
    city: string | null;
    primary_tech: string | null;
  } | null;
  findings: Finding[];
  quality: ScanQuality | null;
  tech: { primaryPlatform: string | null } | null;
  generatedAt: string;
}

const SEV_STYLE: Record<string, string> = {
  EMERGENCY: 'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5',
  HIGH: 'background:#fef3c7;color:#92400e;border:1px solid #fcd34d',
  MEDIUM: 'background:#fef9c3;color:#854d0e;border:1px solid #fde047',
};

export function ScanReport() {
  const { id } = useParams<{ id: string }>();
  const scanId = Number(id);
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scanId) return;
    void (async () => {
      try {
        const d = await apiFetch<ReportData & { ok: boolean }>(`/api/scans/${scanId}/report`);
        setData(d);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [scanId]);

  if (error) return <div className="mx-auto max-w-3xl bg-white p-8 text-sm text-red-700">Failed to load report: {error}</div>;
  if (!data) return <div className="mx-auto max-w-3xl bg-white p-8 text-sm text-gray-500">Loading report…</div>;

  const { scan, website, findings, quality } = data;
  const score = scan.opportunityScore ?? 0;
  const domain = (() => {
    try {
      return new URL(website?.url ?? scan.websiteUrl).hostname.replace(/^www\./, '');
    } catch {
      return website?.url ?? scan.websiteUrl;
    }
  })();
  const date = (scan.completedAt ?? scan.createdAt ?? '').slice(0, 10);

  return (
    <div className="min-h-screen bg-gray-200">
      <style>{`@media print { .no-print { display: none !important; } .print-page { box-shadow: none !important; margin: 0 !important; max-width: 100% !important; } body { background: #fff !important; } }`}</style>
      <div className="no-print mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
        <Link to={`/scans/${scanId}`} className="flex items-center gap-1 text-sm text-gray-600 hover:text-black">
          <ArrowLeft className="h-4 w-4" /> Back to scan
        </Link>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-1.5 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
        >
          <Printer className="h-4 w-4" /> Print / Save PDF
        </button>
      </div>

      <div className="print-page mx-auto mb-8 max-w-3xl bg-white p-8 text-gray-900 shadow-lg sm:p-10">
        <div className="border-b-2 border-black pb-4">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-gray-500">Website conversion audit</p>
          <h1 className="mt-1 text-3xl font-extrabold">{website?.business_name ?? domain}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {domain}
            {website?.city ? ` · ${website.city}` : ''} · Scanned {date}
          </p>
        </div>

        <div className="mt-5 flex items-center gap-4 rounded-xl bg-gray-50 p-4">
          <div className="text-5xl font-extrabold">{score}<span className="text-xl text-gray-400">/100</span></div>
          <p className="text-sm text-gray-600">
            {score >= 60
              ? 'High number of conversion leaks found. Each item below is money walking out the door.'
              : score >= 30
                ? 'Several real conversion leaks found. Fixing them is the fastest way to more calls and quotes.'
                : score >= 10
                  ? 'A few issues found. Quick fixes will tighten up conversions.'
                  : 'Site looks healthy — only minor polish items, if any.'}
          </p>
        </div>

        {findings.length === 0 ? (
          <p className="mt-6 text-sm text-gray-600">No major leaks found on this scan. Nice work keeping the site in shape.</p>
        ) : (
          <div className="mt-6 space-y-5">
            {findings.map((f, i) => {
              const details = (f.evidence?.details ?? {}) as Record<string, unknown>;
              const shot = typeof details['screenshot'] === 'string' && SERVABLE_SHOT_RE.test(details['screenshot'])
                ? details['screenshot'] as string
                : null;
              const lcp = typeof details['lcp_url'] === 'string' && /^https?:\/\//i.test(details['lcp_url'])
                ? details['lcp_url'] as string
                : null;
              return (
                <div key={f.id} className="break-inside-avoid rounded-xl border border-gray-200 p-4">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-gray-400">#{i + 1}</span>
                    <span className="rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ ...(parseStyle(SEV_STYLE[f.severity] ?? '')) }}>
                      {f.severity}
                    </span>
                  </div>
                  <h2 className="mt-1 text-lg font-bold">{f.title}</h2>
                  {f.description && <p className="mt-1 text-sm text-gray-600">{f.description}</p>}
                  {(f.measuredValue || f.expectedValue) && (
                    <p className="mt-2 font-mono text-xs text-gray-500">
                      {f.measuredValue ? `Found: ${f.measuredValue}` : ''}{f.measuredValue && f.expectedValue ? ' · ' : ''}{f.expectedValue ? `Should be: ${f.expectedValue}` : ''}
                    </p>
                  )}
                  {shot && (
                    <img src={`/api/scans/${scanId}/screenshot?file=${encodeURIComponent(shot)}`} alt={f.title} className="mt-3 max-h-80 w-full rounded-lg border border-gray-200 object-contain" />
                  )}
                  {lcp && (
                    <img src={lcp} alt="Slow asset" referrerPolicy="no-referrer" className="mt-3 max-h-80 w-full rounded-lg border border-gray-200 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {quality && (
          <p className="mt-6 text-xs text-gray-400">
            Coverage: {quality.pagesAnalyzed} pages · {quality.checksCompleted} checks · {quality.visualChecks} visual · {quality.contradictions} contradictions resolved
          </p>
        )}

        <div className="mt-6 border-t border-gray-200 pt-4 text-sm text-gray-600">
          <p className="font-bold text-black">Want these fixed?</p>
          <p>Reply to this report and we will take care of every item above — most fixes land within days, not weeks.</p>
        </div>
      </div>
    </div>
  );
}

function parseStyle(css: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const part of css.split(';')) {
    const [k, v] = part.split(':').map((s) => s?.trim());
    if (k && v) out[k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out as React.CSSProperties;
}
