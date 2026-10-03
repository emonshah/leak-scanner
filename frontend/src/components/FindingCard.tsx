import { useState } from 'react';
import { AlertCircle, ExternalLink, FileText, Trash2, Camera } from 'lucide-react';
import type { Finding as FindingType } from '@/types';

// Filenames the backend agrees to serve (mirror of scans.ts allowlists).
const SERVABLE_SHOT_RE = /^(ev-(phone|overflow|cta|tap)-\d+\.webp|(mobile|desktop|tablet)(-recheck)?-hero(-annotated)?\.webp)$/;

function shotUrl(scanId: number, file: string): string {
  return `/api/scans/${scanId}/screenshot?file=${encodeURIComponent(file)}`;
}

export function FindingCard({ finding, onDelete }: { finding: FindingType; onDelete?: (id: number) => void }) {
  const [shotBroken, setShotBroken] = useState(false);
  const details = (finding.evidence?.details ?? {}) as Record<string, unknown>;
  const shotFile = typeof details['screenshot'] === 'string' ? details['screenshot'] : null;
  const showShot = !shotBroken && shotFile != null && SERVABLE_SHOT_RE.test(shotFile);
  // Slow-asset photo (performance findings): external LCP image URL.
  const [lcpBroken, setLcpBroken] = useState(false);
  const lcpUrl = typeof details['lcp_url'] === 'string' && /^https?:\/\//i.test(details['lcp_url']) ? details['lcp_url'] : null;
  const lcpName = lcpUrl ? lcpUrl.split('/').pop()?.split('?')[0] ?? 'asset' : '';
  const showLcp = !lcpBroken && lcpUrl != null;
  const sevConfig = {
    EMERGENCY: {
      border: 'border-neon-red/40',
      bg: 'bg-neon-red/[0.06]',
      text: 'text-neon-red',
      badge: 'bg-neon-red/15 text-neon-red border border-neon-red/30',
    },
    HIGH: {
      border: 'border-neon-amber/40',
      bg: 'bg-neon-amber/[0.06]',
      text: 'text-neon-amber',
      badge: 'bg-neon-amber/15 text-neon-amber border border-neon-amber/30',
    },
    MEDIUM: {
      border: 'border-yellow-500/40',
      bg: 'bg-yellow-500/[0.06]',
      text: 'text-yellow-400',
      badge: 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/30',
    },
  }[finding.severity] ?? {
    border: 'border-hairline',
    bg: 'bg-white/[0.03]',
    text: 'text-inkdim',
    badge: 'bg-white/[0.06] text-inkdim border border-hairline',
  };

  return (
    <div className={`panel overflow-hidden border ${sevConfig.border} ${sevConfig.bg} p-4`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${sevConfig.badge}`}>
          <AlertCircle className={`h-4 w-4 ${sevConfig.text}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-[10px] font-bold uppercase tracking-[0.18em] ${sevConfig.text}`}>
              {finding.severity}
            </span>
            <span className="text-[11px] text-inkdim">[{finding.category}]</span>
            <span className="text-[11px] text-inkdim">module: {finding.module}</span>
            {onDelete && (
              <button
                onClick={() => {
                  if (window.confirm(`Delete this finding?\n\n"${finding.title}"\n\nUse this when the scanner got it wrong.`)) onDelete(finding.id);
                }}
                title="Delete — scanner got it wrong"
                className="ml-auto rounded-lg p-1.5 text-inkdim transition-colors hover:bg-neon-red/10 hover:text-neon-red"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <h3 className="mt-1 font-sans text-[15px] font-semibold leading-snug text-ink">{finding.title}</h3>
          {finding.description && <p className="mt-1 text-sm text-inkdim">{finding.description}</p>}

          {finding.pageUrl && (
            <a
              href={finding.pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 flex items-center gap-1 text-xs text-primary-hover hover:underline"
            >
              <ExternalLink className="h-3 w-3" /> {finding.pageUrl}
            </a>
          )}

          {showLcp && (
            <div className="mt-3 overflow-hidden rounded-lg border border-hairline">
              <div className="flex items-center gap-1.5 bg-white/[0.03] px-3 py-1.5 font-mono text-[11px] text-inkdim">
                <Camera className="h-3 w-3" /> Slow asset — {lcpName}
              </div>
              <img
                src={lcpUrl!}
                alt={`Slow asset: ${lcpName}`}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setLcpBroken(true)}
                className="max-h-96 w-full bg-[#05050c] object-contain"
              />
            </div>
          )}

          {showShot && (
            <div className="mt-3 overflow-hidden rounded-lg border border-hairline">
              <div className="flex items-center gap-1.5 bg-white/[0.03] px-3 py-1.5 text-[11px] text-inkdim">
                <Camera className="h-3 w-3" /> Visual proof — {shotFile}
              </div>
              <img
                src={shotUrl(finding.scanId, shotFile!)}
                alt={`Evidence: ${finding.title}`}
                loading="lazy"
                onError={() => setShotBroken(true)}
                className="max-h-96 w-full bg-[#05050c] object-contain"
              />
            </div>
          )}

          {finding.evidence?.details != null && (
            <details className="mt-3">
              <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-inkdim hover:text-ink">
                <FileText className="h-3.5 w-3.5" /> Evidence details
              </summary>
              <pre className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-hairline bg-[#05050c] p-3 font-mono text-xs text-inkdim">
                {JSON.stringify(finding.evidence.details, null, 2)}
              </pre>
            </details>
          )}

          {finding.priorityScore != null && (
            <div className="mt-2 text-xs text-inkdim">
              Priority score: <span className="font-mono text-ink">{finding.priorityScore}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
