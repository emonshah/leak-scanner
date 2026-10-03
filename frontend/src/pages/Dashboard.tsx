import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useScans } from '@/hooks/useScans';
import { ScanCard } from '@/components/ScanCard';
import { Plus, RefreshCw, Globe, Activity } from 'lucide-react';
import type { ScanRow } from '@/types';

export function Dashboard() {
  const { user } = useAuth();
  const { scans, isLoading, error, refetch } = useScans(5000);

  const stats = {
    total: scans.length,
    completed: scans.filter((s) => s.status === 'completed').length,
    scanning: scans.filter((s) => s.status === 'scanning' || s.status === 'pending').length,
    failed: scans.filter((s) => s.status === 'failed' || s.status === 'blocked').length,
  };

  const activeScans = scans.filter((s) => s.status === 'scanning' || s.status === 'pending' || s.status === 'paused').slice(0, 8);

  const recent = scans.slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Hero header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-primary">
            <Activity className="h-3.5 w-3.5" /> Live Command Center
          </div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-inkdim">
            Signed in as <span className="text-ink">{user?.email}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void refetch()} className="btn-ghost">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <Link to="/websites" className="btn-primary">
            <Plus className="h-4 w-4" /> New Scan
          </Link>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="stat-tile">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-inkdim">Total Scans</div>
          <div className="mt-2 font-display text-4xl font-bold text-ink">{stats.total}</div>
          <div className="mt-2 h-1 w-full rounded-full bg-white/[0.06]">
            <div className="h-full w-full rounded-full bg-grad-neon" />
          </div>
        </div>
        <div className="stat-tile">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-inkdim">Completed</div>
          <div className="mt-2 font-display text-4xl font-bold text-neon-green">{stats.completed}</div>
          <div className="mt-2 h-1 w-full rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-neon-green" style={{ width: `${stats.total ? (stats.completed / stats.total) * 100 : 0}%` }} />
          </div>
        </div>
        <div className="stat-tile">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-inkdim">In Progress</div>
          <div className="mt-2 font-display text-4xl font-bold text-primary-hover">{stats.scanning}</div>
          <div className="mt-2 h-1 w-full rounded-full bg-white/[0.06]">
            <div className="h-full w-1/3 rounded-full bg-primary shadow-glow" />
          </div>
        </div>
        <div className="stat-tile">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-inkdim">Failed / Blocked</div>
          <div className="mt-2 font-display text-4xl font-bold text-neon-red">{stats.failed}</div>
          <div className="mt-2 h-1 w-full rounded-full bg-white/[0.06]">
            <div className="h-full w-1/4 rounded-full bg-neon-red" />
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-neon-red/40 bg-neon-red/10 px-4 py-3 text-sm text-neon-red">
          {error}
        </div>
      )}

      {activeScans.length > 0 && (
        <div className="panel border-primary/30 p-4">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
            Live now — {activeScans.length} scanning (auto-refresh 5s)
          </div>
          <div className="space-y-1.5">
            {activeScans.map((s) => (
              <Link key={s.id} to={`/scans/${s.id}`} className="flex items-center justify-between gap-2 rounded-lg border border-hairline px-3 py-1.5 text-xs hover:bg-white/[0.03]">
                <span className="truncate font-mono text-ink">#{s.id} {s.websiteUrl}</span>
                <span className="shrink-0 text-primary-hover">watch live →</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Recent scans */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-lg font-bold tracking-tight">Recent Scans</h2>
          <Link to="/websites" className="text-xs text-inkdim hover:text-primary-hover">
            View all →
          </Link>
        </div>

        {isLoading ? (
          <div className="panel p-8 text-center text-sm text-inkdim">Loading scans…</div>
        ) : recent.length === 0 ? (
          <div className="panel flex flex-col items-center py-14 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-hairline bg-white/[0.03]">
              <Globe className="h-7 w-7 text-inkdim" />
            </div>
            <p className="text-sm text-inkdim">No scans yet. Add a website first.</p>
            <Link to="/websites" className="btn-primary mt-4">
              <Plus className="h-4 w-4" /> Go to Websites
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {recent.map((scan: ScanRow) => (
              <ScanCard key={scan.id} scan={scan} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}