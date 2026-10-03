import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownToLine } from 'lucide-react';
import { apiFetch } from '@/api/client';

interface UpdateStatus {
  current: string;
  latest: string | null;
  needsUpdate: boolean;
}

/** Header version chip + link to the sidebar Updates page.
 *  No auto-popup: Updates page checks fresh, then asks first. */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await apiFetch<UpdateStatus & { ok: boolean }>('/api/updates/status');
        if (!cancelled) setStatus(s);
      } catch {
        /* backend starting / offline — stay silent, retry next page load */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex items-center gap-2 text-xs">
      {status && (
        <span className="rounded-full border border-hairline bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-inkdim" title="App version">
          v{status.current}
        </span>
      )}
      {status?.needsUpdate && (
        <Link
          to="/updates"
          className="flex items-center gap-1.5 rounded-full border border-neon-green/40 bg-neon-green/10 px-3 py-1 font-medium text-neon-green hover:bg-neon-green/20"
        >
          <ArrowDownToLine className="h-3.5 w-3.5" />
          v{status.latest?.replace(/^v/, '')} available
        </Link>
      )}
    </div>
  );
}
