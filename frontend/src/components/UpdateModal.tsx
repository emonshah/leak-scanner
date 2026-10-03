import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Clock, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { apiFetch, apiPost } from '@/api/client';

interface UpdateStatus {
  current: string;
  latest: string | null;
  notes: string;
  needsUpdate: boolean;
  updaterEnabled: boolean;
}

interface JobLog {
  jobId: string;
  state: 'idle' | 'running' | 'done' | 'failed';
  lines: string[];
  exitCode: number | null;
}

const SNOOZE_UNTIL_KEY = 'update-snooze-until';
const SNOOZE_COUNT_KEY = 'update-snooze-count';
const MAX_SNOOZE = 3;

function snoozeCount(): number {
  return Number(localStorage.getItem(SNOOZE_COUNT_KEY) ?? 0) || 0;
}

export function UpdateModal({ status, onStatus, onClose }: { status: UpdateStatus; onStatus: (s: UpdateStatus) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<'info' | 'updating' | 'waiting' | 'done' | 'error'>('info');
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const pollRef = useRef<number | null>(null);

  const stopPoll = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => stopPoll, []);

  const snooze = (hours: number) => {
    const now = Date.now();
    localStorage.setItem(SNOOZE_UNTIL_KEY, String(now + hours * 3600 * 1000));
    localStorage.setItem(SNOOZE_COUNT_KEY, String(snoozeCount() + 1));
    onClose();
  };

  const checkAgain = async () => {
    setChecking(true);
    try {
      const s = await apiFetch<UpdateStatus & { ok: boolean }>('/api/updates/status?refresh=1');
      onStatus(s);
      if (!s.needsUpdate) {
        localStorage.removeItem(SNOOZE_COUNT_KEY);
        localStorage.removeItem(SNOOZE_UNTIL_KEY);
      }
    } catch (e) {
      setError(`Check failed: ${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  const pollLog = useCallback((failuresAllowed = 30) => {
    let failures = 0;
    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const log = await apiFetch<JobLog & { ok: boolean }>('/api/admin/update/log');
          failures = 0;
          setLines(log.lines);
          if (log.state === 'done' || log.state === 'failed') {
            stopPoll();
            if (log.state === 'done') waitForVersion();
            else {
              setError(`Update failed (exit ${log.exitCode ?? '?'}). Old version keeps running — check the log above.`);
              setPhase('error');
            }
          }
        } catch {
          // Backend restarting mid-rebuild: connection drops are EXPECTED.
          failures++;
          if (failures >= failuresAllowed) {
            stopPoll();
            waitForVersion();
          }
        }
      })();
    }, 2000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const waitForVersion = useCallback(() => {
    setPhase('waiting');
    const target = status.latest;
    const deadline = Date.now() + 5 * 60 * 1000;
    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const v = await apiFetch<{ ok: boolean; version: string }>('/api/version');
          if (v.version && target && v.version === target.replace(/^v/, '')) {
            stopPoll();
            localStorage.removeItem(SNOOZE_COUNT_KEY);
            setPhase('done');
          } else if (Date.now() > deadline) {
            stopPoll();
            setError('New version is taking too long to come up. Restart the backend (npm start), then reload.');
            setPhase('error');
          }
        } catch {
          /* backend still restarting */
          if (Date.now() > deadline) {
            stopPoll();
            setError('Backend unreachable for 5 minutes. Start the backend manually (npm start), then reload.');
            setPhase('error');
          }
        }
      })();
    }, 3000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.latest]);

  const startUpdate = async () => {
    setError(null);
    setPhase('updating');
    setLines(['Starting update…']);
    try {
      const res = await apiPost<{ ok: boolean; scansActive: number; warning: string | null }>('/api/admin/update/start', {});
      if (res.warning) setLines((l) => [...l, `WARNING: ${res.warning}`]);
      pollLog();
    } catch (e) {
      setError((e as Error).message);
      setPhase('error');
    }
  };

  const count = snoozeCount();
  const maxed = count >= MAX_SNOOZE;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="panel max-h-[85vh] w-full max-w-lg overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {phase === 'info' && (
          <>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-neon-green/15 text-neon-green">
                <ArrowDownToLine className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-display text-lg font-bold">Update available: v{status.latest?.replace(/^v/, '')}</h2>
                <p className="font-mono text-xs text-inkdim">yours: v{status.current} → latest: {status.latest}</p>
              </div>
            </div>
            {status.notes && (
              <pre className="mt-4 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-hairline bg-white/[0.03] p-3 font-mono text-xs text-inkdim">
                {status.notes.slice(0, 1500)}
              </pre>
            )}
            <p className="mt-3 text-xs text-inkdim">
              Updating restarts the app for ~2-5 minutes. Your websites, scans and data are never touched.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={() => void checkAgain()} disabled={checking} className="btn-ghost text-xs disabled:opacity-40" title="Ask GitHub right now (ignores the 24h cache)">
                <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} /> {checking ? 'Checking…' : 'Check again'}
              </button>
              {status.updaterEnabled ? (
                <button onClick={() => void startUpdate()} className="btn-primary">
                  <RefreshCw className="h-4 w-4" /> Update now
                </button>
              ) : (
                <p className="rounded-xl border border-neon-amber/40 bg-neon-amber/10 px-3 py-2 text-xs text-neon-amber">
                  One-click is off on this machine (ENABLE_UPDATER=0). Run <span className="font-mono">git pull</span> then <span className="font-mono">npm run build</span> instead.
                </p>
              )}
              {!maxed ? (
                <>
                  <button onClick={() => snooze(8)} className="btn-ghost text-xs">
                    <Clock className="h-3.5 w-3.5" /> Later today
                  </button>
                  <button onClick={() => snooze(24)} className="btn-ghost text-xs">
                    <Clock className="h-3.5 w-3.5" /> Tomorrow
                  </button>
                </>
              ) : (
                <button onClick={() => snooze(4)} className="btn-ghost text-xs" title="Snoozed 3 times — updates can't wait forever">
                  <Clock className="h-3.5 w-3.5" /> Remind in 4h (last snooze)
                </button>
              )}
            </div>
            {count > 0 && !maxed && <p className="mt-2 text-[11px] text-inkdim">Snoozed {count}/{MAX_SNOOZE} times — updates are mandatory, this popup keeps coming back.</p>}
          </>
        )}

        {(phase === 'updating' || phase === 'waiting') && (
          <>
            <h2 className="font-display text-lg font-bold">
              {phase === 'updating' ? 'Updating… keep this open' : 'Waiting for new version…'}
            </h2>
            <div className="mt-3 max-h-64 space-y-1 overflow-y-auto rounded-lg border border-hairline bg-[#05050c] p-3 font-mono text-xs text-inkdim">
              {lines.length === 0 ? <p>Starting…</p> : lines.map((l, i) => <p key={i}>{l}</p>)}
              {phase === 'waiting' && <p className="animate-pulse text-primary-hover">…backend restarting, checking version…</p>}
            </div>
            <p className="mt-2 text-xs text-inkdim">Do not close this tab. Data is safe.</p>
          </>
        )}

        {phase === 'done' && (
          <div className="text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-neon-green" />
            <h2 className="mt-2 font-display text-lg font-bold">Updated to v{status.latest?.replace(/^v/, '')}!</h2>
            <button onClick={() => window.location.reload()} className="btn-primary mt-4">Reload app</button>
          </div>
        )}

        {phase === 'error' && (
          <div>
            <div className="flex items-center gap-2 text-neon-red">
              <AlertTriangle className="h-5 w-5" />
              <h2 className="font-display text-lg font-bold">Update hit a problem</h2>
            </div>
            <p className="mt-2 text-sm text-inkdim">{error}</p>
            <div className="mt-4 flex gap-2">
              <button onClick={onClose} className="btn-ghost">Close</button>
              <button onClick={() => { setPhase('info'); setError(null); }} className="btn-ghost">Try again</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
