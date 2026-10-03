import { useEffect, useRef } from 'react';
import { LogEntry } from '@/types';
import { Terminal } from 'lucide-react';

export function ProgressStream({ logs, connected }: { logs: LogEntry[]; connected?: boolean }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll like a terminal as new lines arrive
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  return (
    <div className="panel overflow-hidden">
      <div className="console-bar">
        <Terminal className="h-3.5 w-3.5" /> scan.log
        <span className="ml-2 flex items-center gap-1.5 text-[11px] font-normal normal-case tracking-normal">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? 'bg-neon-green shadow-glow' : 'bg-inkdim/50'}`} />
          {connected ? 'live' : 'polling'}
        </span>
        <span className="ml-auto text-inkdim/60">{logs.length} entries</span>
      </div>
      <div ref={bodyRef} className="console-body max-h-[60vh] overflow-y-auto">
        {logs.map((log, i) => {
          const failed = log.status === 'error';
          const done = log.status === 'done';
          const running = log.status === 'running';
          return (
            <div key={i} className="flex gap-2.5 animate-rise-in">
              <span className={`shrink-0 font-mono ${failed ? 'text-neon-red' : done ? 'text-neon-green' : running ? 'text-primary' : 'text-inkdim'}`}>
                {failed ? '×' : done ? '✓' : '•'}
              </span>
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-inkdim/70">[{log.stage}]</span>
              <span className="break-all text-ink/90">{log.msg}</span>
            </div>
          );
        })}
        {logs.length === 0 && <p className="text-inkdim/60">Waiting for scan output…</p>}
      </div>
    </div>
  );
}
