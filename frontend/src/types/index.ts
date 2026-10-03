export type ScanStatus =
  | 'pending'
  | 'scanning'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'blocked';

export type Severity = 'EMERGENCY' | 'HIGH' | 'MEDIUM';

export interface Finding {
  id: number;
  scanId: number;
  websiteId: number;
  pageUrl?: string;
  module: string;
  category: string;
  severity: Severity;
  title: string;
  description: string;
  measuredValue?: string;
  expectedValue?: string;
  evidence: Record<string, unknown>;
  businessCategory?: string;
  conversionImpact?: string;
  confidence?: string;
  priorityScore?: number;
  groupKey?: string | null;
  isGroupPrimary?: boolean;
  createdAt: string;
}

export interface ScanQuality {
  pagesAnalyzed: number;
  pagesBlocked: number;
  pagesFailed: number;
  checksCompleted: number;
  checksNotTested: number;
  checksManualReview: number;
  visualChecks: number;
  contradictions: number;
  suppressed: number;
}

export interface ScanRow {
  id: number;
  websiteId: number;
  websiteUrl: string;
  normalizedUrl: string;
  status: ScanStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  opportunityScore: number | null;
  minorIssuesCount: number;
  quality: ScanQuality | null;
  findingCount: number;
  createdAt: string;
  createdBy: { id: number; email: string; name: string | null } | null;
}

export interface LatestScan {
  id: number;
  status: ScanStatus;
  opportunityScore: number | null;
  findingCount: number;
  createdAt: string;
  completedAt: string | null;
}

export type LeadStatus = 'new' | 'qualified' | 'skipped' | 'contacted' | 'replied';

export interface SuggestedAction {
  action: 'message' | 'skip' | 'needs-scan';
  reason: string;
}

export interface WebsiteDTO {
  id: number;
  url: string;
  normalizedUrl: string;
  status: string;
  niche: string;
  primaryTech: string | null;
  contactEmail: string | null;
  contactName: string | null;
  businessName: string | null;
  city: string | null;
  country: string | null;
  emailStatus: string | null;
  emailCheckedAt: string | null;
  emailManual: boolean;
  doNotEmail: boolean;
  parkedAt: string | null;
  leadStatus: LeadStatus;
  leadStatusAt: string | null;
  leadStatusNote: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: { id: number; email: string; name: string | null } | null;
  latestScan: LatestScan | null;
  suggestedAction: SuggestedAction | null;
}

export interface ProfileUser {
  id: number;
  email: string;
  role: 'admin' | 'user';
  displayName: string | null;
  hasAvatar: boolean;
}

export interface LogEntry {
  t: string;
  stage: string;
  status: 'running' | 'done' | 'error';
  msg: string;
}
