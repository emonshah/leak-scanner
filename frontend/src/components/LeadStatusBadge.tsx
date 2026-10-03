import type { LeadStatus } from '@/types';

interface LeadStatusBadgeProps {
  status: LeadStatus | string;
  className?: string;
}

const LEAD_CONFIG: Record<string, { label: string; className: string; dot: string }> = {
  new: { label: 'New', className: 'bg-white/[0.06] text-inkdim border border-hairline', dot: 'bg-inkdim' },
  qualified: { label: 'Qualified', className: 'bg-primary/15 text-primary-hover border border-primary/30', dot: 'bg-primary' },
  skipped: { label: 'Skipped', className: 'bg-white/[0.04] text-inkdim border border-hairline', dot: 'bg-inkdim' },
  contacted: { label: 'Contacted', className: 'bg-neon-amber/15 text-neon-amber border border-neon-amber/30', dot: 'bg-neon-amber' },
  replied: { label: 'Replied', className: 'bg-neon-green/15 text-neon-green border border-neon-green/30', dot: 'bg-neon-green' },
};

export function LeadStatusBadge({ status, className }: LeadStatusBadgeProps) {
  const cfg = LEAD_CONFIG[status] ?? { label: status, className: 'bg-white/[0.06] text-inkdim border border-hairline', dot: 'bg-inkdim' };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.className} ${className ?? ''}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}
