import { Link } from 'react-router-dom';
import { StatusBadge } from '@/components/StatusBadge';
import { Calendar, ExternalLink } from 'lucide-react';
import type { ScanRow } from '@/types';
import { formatDistanceToNow } from 'date-fns';

export function ScanCard({ scan }: { scan: ScanRow }) {
  const score = scan.opportunityScore ?? 0;
  const scoreColor =
    score >= 60 ? 'text-neon-red' : score >= 30 ? 'text-neon-amber' : score >= 10 ? 'text-yellow-400' : 'text-neon-green';

  return (
    <Link to={`/scans/${scan.id}`} className="group block">
      <div className="panel relative overflow-hidden p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow">
        <div className="absolute left-0 top-0 h-px w-16 bg-grad-neon opacity-70" />
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-sm text-ink group-hover:text-primary-hover">{scan.websiteUrl}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-inkdim" />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-inkdim">
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" /> {formatDistanceToNow(new Date(scan.createdAt), { addSuffix: true })}
              </span>
              <span>{scan.findingCount} findings</span>
              {scan.minorIssuesCount > 0 && <span>{scan.minorIssuesCount} minor</span>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className={`font-display text-2xl font-bold ${scoreColor}`}>{score}</div>
              <div className="text-[10px] uppercase tracking-wider text-inkdim">score</div>
            </div>
            <StatusBadge status={scan.status} />
          </div>
        </div>
        {scan.error && <p className="mt-2 text-xs text-neon-red">{scan.error}</p>}
      </div>
    </Link>
  );
}
