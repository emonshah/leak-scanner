import type { ScanStatus } from '@/types';

interface StatusBadgeProps {
  status: ScanStatus | string;
  className?: string;
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-white/[0.06] text-inkdim border border-hairline' },
  scanning: { label: 'Scanning', className: 'bg-primary/15 text-primary-hover border border-primary/30' },
  paused: { label: 'Paused', className: 'bg-neon-amber/15 text-neon-amber border border-neon-amber/30' },
  cancelled: { label: 'Cancelled', className: 'bg-white/[0.04] text-inkdim border border-hairline' },
  completed: { label: 'Completed', className: 'bg-neon-green/15 text-neon-green border border-neon-green/30' },
  failed: { label: 'Failed', className: 'bg-neon-red/15 text-neon-red border border-neon-red/30' },
  blocked: { label: 'Blocked', className: 'bg-neon-red/15 text-neon-red border border-neon-red/30' },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, className: 'bg-white/[0.06] text-inkdim border border-hairline' };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.className} ${className ?? ''}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${
        status === 'scanning' ? 'bg-primary animate-pulse-ring' :
        status === 'completed' ? 'bg-neon-green' :
        status === 'failed' || status === 'blocked' ? 'bg-neon-red' :
        status === 'paused' ? 'bg-neon-amber' : 'bg-inkdim'
      }`} />
      {cfg.label}
    </span>
  );
}
