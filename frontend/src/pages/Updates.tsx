import { useEffect, useState } from 'react';
import { ArrowDownToLine, CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { UpdateModal } from '@/components/UpdateModal';

interface UpdateStatus {
  current: string;
  latest: string | null;
  notes: string;
  needsUpdate: boolean;
  updaterEnabled: boolean;
}

/** Sidebar "Updates" page: click Check → fresh check → ask first.
 *  Update runs ONLY when the user presses "Ha, update din". */
export function Updates() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [asked, setAsked] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const s = await apiFetch<UpdateStatus & { ok: boolean }>('/api/updates/status');
        if (!off) setStatus(s);
      } catch {
        /* backend offline — page shows retry */
      }
    })();
    return () => {
      off = true;
    };
  }, []);

  const check = async () => {
    setChecking(true);
    setError(null);
    setSkipped(false);
    try {
      const s = await apiFetch<UpdateStatus & { ok: boolean }>('/api/updates/status?refresh=1');
      setStatus(s);
      setAsked(s.needsUpdate);
      if (!s.needsUpdate) setAsked(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-primary">System</div>
        <h1 className="font-display text-3xl font-extrabold tracking-tight">Updates</h1>
        <p className="mt-1 text-sm text-inkdim">
          Check GitHub releases first — update runs only when you say yes.
        </p>
      </div>

      <div className="panel p-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="font-mono text-xs text-inkdim">
            Current: <span className="text-ink">v{status?.current ?? '…'}</span>
            {status?.latest && (
              <>
                {' → '}Latest: <span className="text-ink">{status.latest}</span>
              </>
            )}
          </div>
          <button onClick={() => void check()} disabled={checking} className="btn-primary text-sm disabled:opacity-40">
            <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-neon-red/40 bg-neon-red/10 px-4 py-3 text-sm text-neon-red">
            {error}
          </div>
        )}

        {status && !status.needsUpdate && !checking && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-neon-green/40 bg-neon-green/10 px-4 py-3 text-sm text-neon-green">
            <CheckCircle2 className="h-4 w-4" /> You are up to date (v{status.current}).
          </div>
        )}

        {status?.needsUpdate && status.latest && (
          <div className="mt-4 rounded-xl border border-hairline bg-white/[0.03] p-4">
            {status.notes && (
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-hairline bg-white/[0.03] p-3 font-mono text-xs text-inkdim">
                {status.notes.slice(0, 1500)}
              </pre>
            )}
            {!asked && !skipped ? (
              <p className="mt-3 text-sm">
                New version <span className="font-mono font-bold">{status.latest}</span> found.
                Press <span className="font-medium">Check for updates</span> to re-verify, then you will be asked.
              </p>
            ) : skipped ? (
              <p className="mt-3 text-sm text-inkdim">
                Skipped — no update started. Press <span className="font-medium">Check for updates</span> to ask again.
              </p>
            ) : (
              <>
                <p className="mt-3 text-sm font-medium">
                  v{status.current} → {status.latest} available. Want to update now?
                </p>
                {!isAdmin && (
                  <p className="mt-2 flex items-center gap-2 text-xs text-neon-amber">
                    <ShieldAlert className="h-3.5 w-3.5" /> Only admin can run the update — ask your admin.
                  </p>
                )}
                {!status.updaterEnabled && (
                  <p className="mt-2 rounded-xl border border-neon-amber/40 bg-neon-amber/10 px-3 py-2 text-xs text-neon-amber">
                    One-click is off here (ENABLE_UPDATER=0). Run <span className="font-mono">git pull</span> then <span className="font-mono">npm run build</span> instead.
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {status.updaterEnabled && isAdmin && (
                    <button onClick={() => setModalOpen(true)} className="btn-primary text-sm">
                      <ArrowDownToLine className="h-4 w-4" /> Update now
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setAsked(false);
                      setSkipped(true);
                      setModalOpen(false);
                    }}
                    className="btn-ghost text-sm"
>
                      Not now
                    </button>
                </div>
                <p className="mt-2 text-xs text-inkdim">
                  Updating restarts the app for ~2-5 min. Websites, scans and data are never touched.
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {modalOpen && status && (
        <UpdateModal status={status} onStatus={(s) => setStatus(s)} onClose={() => setModalOpen(false)} />
      )}
    </div>
  );
}
