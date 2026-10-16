import { useEffect, useState } from 'react';
import { Film } from 'lucide-react';
import { apiFetch } from '@/api/client';

function fileUrl(scanId: number, file: string): string {
  return `/api/scans/${scanId}/screenshot?file=${encodeURIComponent(file)}`;
}

// Forensic-only (v1.4.0): heroes/annotated retired — this tab shows only
// per-finding evidence close-ups (ev-*.webp) attached to measured leaks.
export function EvidenceViewer({ scanId }: { scanId: number }) {
  const [clips, setClips] = useState<string[] | null>(null);
  const [activeClip, setActiveClip] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setClips(null);
    setActiveClip(null);
    void (async () => {
      try {
        const data = await apiFetch<{ ok: boolean; clips: string[] }>(
          `/api/scans/${scanId}/screenshots`,
        );
        if (!cancelled) setClips(data.clips);
      } catch {
        if (!cancelled) setClips([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  return (
    <div className="space-y-5">
      <div>
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.18em] text-inkdim">
          <Film className="h-3.5 w-3.5" /> Evidence clips {clips && clips.length > 0 && `(${clips.length})`}
        </h4>
        {clips === null ? (
          <div className="panel p-6 text-center text-sm text-inkdim">Loading evidence…</div>
        ) : clips.length > 0 ? (
          <>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {clips.map((f) => (
                <button
                  key={f}
                  onClick={() => setActiveClip(f)}
                  className={`overflow-hidden rounded-xl border transition-colors ${
                    activeClip === f ? 'border-primary/50' : 'border-hairline hover:border-primary/40'
                  }`}
                  title={f}
                >
                  <img src={fileUrl(scanId, f)} alt={f} loading="lazy" className="aspect-video w-full object-cover" />
                </button>
              ))}
            </div>
            {activeClip && (
              <div className="panel mt-2 overflow-hidden p-3">
                <img src={fileUrl(scanId, activeClip)} alt={activeClip} className="max-w-full rounded-lg" />
                <p className="mt-1 font-mono text-[10px] text-inkdim">{activeClip}</p>
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-inkdim">No close-up clips — this scan found nothing worth clipping.</p>
        )}
      </div>
    </div>
  );
}
