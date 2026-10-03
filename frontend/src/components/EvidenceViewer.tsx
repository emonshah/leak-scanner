import { useEffect, useState } from 'react';
import { Monitor, Tablet, Smartphone, Image, Film } from 'lucide-react';
import { apiFetch } from '@/api/client';

const VIEWPORTS = [
  { key: 'mobile', label: 'Mobile', icon: Smartphone },
  { key: 'tablet', label: 'Tablet', icon: Tablet },
  { key: 'desktop', label: 'Desktop', icon: Monitor },
];

interface ShotList {
  heroes: string[];
  annotated: string[];
  clips: string[];
}

function fileUrl(scanId: number, file: string): string {
  return `/api/scans/${scanId}/screenshot?file=${encodeURIComponent(file)}`;
}

export function EvidenceViewer({ scanId }: { scanId: number }) {
  const [shots, setShots] = useState<ShotList | null>(null);
  const [viewport, setViewport] = useState('mobile');
  const [activeClip, setActiveClip] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setShots(null);
    setActiveClip(null);
    void (async () => {
      try {
        const data = await apiFetch<{ ok: boolean; heroes: string[]; annotated: string[]; clips: string[] }>(
          `/api/scans/${scanId}/screenshots`,
        );
        if (!cancelled) setShots({ heroes: data.heroes, annotated: data.annotated, clips: data.clips });
      } catch {
        if (!cancelled) setShots({ heroes: [], annotated: [], clips: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  const heroFile = `${viewport}-hero.webp`;
  const heroExists = shots?.heroes.includes(heroFile) ?? false;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {VIEWPORTS.map((vp) => {
          const Icon = vp.icon;
          return (
            <button
              key={vp.key}
              onClick={() => setViewport(vp.key)}
              className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                viewport === vp.key
                  ? 'bg-primary/15 text-primary-hover border border-primary/30'
                  : 'border border-hairline bg-white/[0.03] text-inkdim hover:bg-white/[0.06] hover:text-ink'
              }`}
            >
              <Icon className="h-3.5 w-3.5" /> {vp.label}
            </button>
          );
        })}
      </div>

      {shots === null ? (
        <div className="panel p-6 text-center text-sm text-inkdim">Loading screenshots…</div>
      ) : heroExists ? (
        <div className="panel overflow-hidden p-3">
          <img src={fileUrl(scanId, heroFile)} alt={`${viewport} page capture`} className="max-w-full rounded-lg" />
        </div>
      ) : (
        <div className="panel flex flex-col items-center py-10 text-center">
          <Image className="mx-auto h-8 w-8 text-inkdim/60" />
          <p className="mt-2 text-sm text-inkdim">No {viewport} capture for this scan (older scans have mobile only).</p>
        </div>
      )}

      {shots && shots.annotated.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-inkdim">Annotated proof</h4>
          <div className="grid gap-2 sm:grid-cols-2">
            {shots.annotated.map((f) => (
              <div key={f} className="panel overflow-hidden p-3">
                <img src={fileUrl(scanId, f)} alt={f} loading="lazy" className="max-w-full rounded-lg" />
                <p className="mt-1 font-mono text-[10px] text-inkdim">{f}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.18em] text-inkdim">
          <Film className="h-3.5 w-3.5" /> Evidence clips {shots && shots.clips.length > 0 && `(${shots.clips.length})`}
        </h4>
        {shots && shots.clips.length > 0 ? (
          <>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {shots.clips.map((f) => (
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
