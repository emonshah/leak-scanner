import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { apiPost, apiPatch, apiDelete, apiFetch } from '@/api/client';
import { Plus, Globe, ExternalLink, X, Upload, Download, Zap, Eye, Loader2, Check, Code2, Copy, SkipForward, MessageCircle, Send, LayoutGrid, ArrowDown, Trash2 } from 'lucide-react';
import type { WebsiteDTO, LeadStatus } from '@/types';
import { StatusBadge } from '@/components/StatusBadge';
import { LeadStatusBadge } from '@/components/LeadStatusBadge';

function EmailStatusBadge({ status, manual, checkedAt }: { status: string | null; manual: boolean; checkedAt: string | null }) {
  const cfg: Record<string, { label: string; className: string }> = {
    VALID: { label: 'Verified', className: 'border-neon-green/40 bg-neon-green/10 text-neon-green' },
    INVALID: { label: 'Invalid', className: 'border-neon-red/40 bg-neon-red/10 text-neon-red' },
    UNKNOWN: { label: 'Unknown', className: 'border-neon-amber/40 bg-neon-amber/10 text-neon-amber' },
  };
  const c: { label: string; className: string } = status && cfg[status]
    ? cfg[status] as { label: string; className: string }
    : { label: 'Unverified', className: 'border-hairline bg-white/[0.04] text-inkdim' };
  const title = [
    status ? `Status: ${status}` : 'Not verified yet',
    manual ? 'Confirmed by you' : null,
    checkedAt ? `Checked ${checkedAt.slice(0, 10)}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${c.className}`}>
      <span className="h-1 w-1 rounded-full bg-current" />
      {c.label}{manual && status === 'VALID' ? ' ✓' : ''}
    </span>
  );
}
import { shortSite, visitUrl, brandName } from '@/lib/site';
import { copyText } from '@/lib/clipboard';

export function Websites() {
  const [websites, setWebsites] = useState<WebsiteDTO[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [url, setUrl] = useState('');
  const [email, setEmail] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [bulkNiche, setBulkNiche] = useState('general');
  const [bulkAutoScan, setBulkAutoScan] = useState(true);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [batchIds, setBatchIds] = useState<number[]>([]);
  const [batchScans, setBatchScans] = useState<Array<{ id: number; websiteUrl: string; status: string; opportunityScore: number | null }>>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedScanId, setCopiedScanId] = useState<number | null>(null);
  const [copiedEmailId, setCopiedEmailId] = useState<number | null>(null);
  const [leadFilter, setLeadFilter] = useState<'all' | 'to-message' | 'skipped' | 'contacted'>('all');

  const handleCopyBrief = async (scanId: number) => {
    try {
      const data = await apiFetch<{ ok: boolean; brief: string }>(`/api/scans/${scanId}/llm-brief`);
      await navigator.clipboard.writeText(data.brief);
      setCopiedScanId(scanId);
      setTimeout(() => setCopiedScanId((cur) => (cur === scanId ? null : cur)), 2000);
   } catch (e) {
    setActionError(`Brief copy failed: ${(e as Error).message}`);
  }
 };
  const handleCopyEmail = async (websiteId: number, value: string) => {
    setActionError(null);
    try {
      await copyText(value);
      setCopiedEmailId(websiteId);
      setTimeout(() => setCopiedEmailId((cur) => (cur === websiteId ? null : cur)), 2000);
    } catch (e) {
      setActionError(`Email copy failed: ${(e as Error).message}`);
    }
  };
  const navigate = useNavigate();

  const refetch = (silent = false) => {
    if (!silent) setIsLoading(true);
    void (async () => {
      try {
        const data = await apiFetch<{ ok: boolean; websites: WebsiteDTO[] }>('/api/websites');
        setWebsites(data.websites);
      } catch (e) {
        if (!silent) console.error(e);
      } finally {
        if (!silent) setIsLoading(false);
      }
    })();
  };

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-track the last batch: poll statuses so bulk progress is visible
  // right here without leaving the page. The table itself refreshes
  // silently too, so per-row status + View button stay current.
  useEffect(() => {
    if (batchIds.length === 0) return;
    let cancelled = false;
    const poll = () => {
      void (async () => {
        try {
          const [sData, wData] = await Promise.all([
            apiFetch<{ ok: boolean; scans: Array<{ id: number; websiteUrl: string; status: string; opportunityScore: number | null }> }>('/api/scans?limit=200'),
            apiFetch<{ ok: boolean; websites: WebsiteDTO[] }>('/api/websites'),
          ]);
          if (cancelled) return;
          const wanted = new Set(batchIds);
          setBatchScans(sData.scans.filter((s) => wanted.has(s.id)));
          setWebsites(wData.websites);
        } catch {
          /* best-effort */
        }
      })();
    };
    poll();
    const iv = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [batchIds]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || !url.trim()) return;
    setIsSubmitting(true);
    setActionError(null);
    try {
      await apiPost('/api/websites', { url: url.trim(), email: email.trim() || undefined });
      setUrl('');
      setEmail('');
      setShowForm(false);
      void refetch();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleScan = (id: number) => {
    setActionError(null);
    void (async () => {
      try {
        const data = await apiPost<{ ok: boolean; scanIds: number[] }>('/api/scans', { websiteIds: [id] });
        if (data.scanIds[0]) {
          setBatchIds([data.scanIds[0]!]);
          navigate(`/scans/${data.scanIds[0]}`);
        }
      } catch (e) {
        setActionError(`Scan start failed: ${(e as Error).message}. Backend cholche kina check koren (${window.location.origin}/api/health).`);
      }
    })();
  };

  const handleBulk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || !bulkText.trim()) return;
    setIsSubmitting(true);
    setBulkResult(null);
    try {
      const data = await apiPost<{ ok: boolean; created: number; skipped: number; scanIds: number[]; errors: { line: number; error: string }[] }>(
        '/api/websites/bulk',
        { text: bulkText, niche: bulkNiche, autoScan: bulkAutoScan },
      );
      setBulkResult(`Imported ${data.created} new, ${data.skipped} duplicates skipped${data.scanIds.length ? `, ${data.scanIds.length} scans queued` : ''}${data.errors.length ? `. First issue (line ${data.errors[0]!.line}): ${data.errors[0]!.error}` : ''}`);
      setBulkText('');
      if (data.scanIds.length > 0) setBatchIds(data.scanIds);
      void refetch();
    } catch (err) {
      setBulkResult((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLeadStatus = (id: number, status: LeadStatus) => {
    setActionError(null);
    void (async () => {
      try {
        await apiPatch<{ ok: boolean }>(`/api/websites/${id}/lead-status`, { status });
        refetch(true);
      } catch (e) {
        setActionError(`Lead status update failed: ${(e as Error).message}`);
      }
    })();
  };

    const handleBulkDelete = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`${ids.length} website${ids.length === 1 ? '' : 's'} + sob scan data permanently delete hobe. Sure?`)) return;
    setActionError(null);
    void (async () => {
      try {
        const data = await apiDelete<{ ok: boolean; deletedCount: number; skipped: number[] }>('/api/websites', { ids });
        setSelected(new Set());
        void refetch(true);
        if (data.skipped.length > 0) setActionError(`${data.deletedCount} deleted, ${data.skipped.length} skipped (not found).`);
      } catch (e) {
        setActionError(`Bulk delete failed: ${(e as Error).message}`);
      }
    })();
  };

  const handleBatchScan = () => {    const ids = [...selected];
    if (ids.length === 0) return;
    setActionError(null);
    void (async () => {
      try {
        const data = await apiPost<{ ok: boolean; scanIds: number[] }>('/api/scans', { websiteIds: ids });
        setSelected(new Set());
        if (data.scanIds.length > 0) setBatchIds(data.scanIds);
      } catch (e) {
        setActionError(`Bulk scan failed: ${(e as Error).message}. Backend cholche kina check koren (${window.location.origin}/api/health).`);
      }
    })();
  };

  const batchDone = batchScans.filter((s) => s.status === 'completed' || s.status === 'failed' || s.status === 'blocked' || s.status === 'cancelled').length;

  const isWorkable = (w: WebsiteDTO) => w.leadStatus === 'new' || w.leadStatus === 'qualified';
  const toMessageCount = websites.filter((w) => w.suggestedAction?.action === 'message' && isWorkable(w)).length;
  const skippedCount = websites.filter((w) => w.leadStatus === 'skipped').length;
  const contactedCount = websites.filter((w) => w.leadStatus === 'contacted' || w.leadStatus === 'replied').length;
  const visible = websites.filter((w) => {
    if (leadFilter === 'to-message') return w.suggestedAction?.action === 'message' && isWorkable(w);
    if (leadFilter === 'skipped') return w.leadStatus === 'skipped';
    if (leadFilter === 'contacted') return w.leadStatus === 'contacted' || w.leadStatus === 'replied';
    return true;
  });
  // Export follows the on-screen tab: to-message = score>=10 + still
  // actionable; skipped/contacted export their own buckets; All = all.
  const exportHref =
    leadFilter === 'to-message'
      ? '/api/leads/export?format=csv&minScore=10&excludeActed=1'
      : leadFilter === 'skipped'
        ? '/api/leads/export?format=csv&leadStatus=skipped'
        : leadFilter === 'contacted'
          ? '/api/leads/export?format=csv&leadStatus=contacted,replied'
          : '/api/leads/export?format=csv';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Asset Registry</div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight">Websites</h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-inkdim">{websites.length} tracked domains{toMessageCount > 0 && <span className="inline-flex items-center gap-1 text-neon-green"><MessageCircle className="h-3.5 w-3.5" /> {toMessageCount} to message</span>}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setShowBulk(!showBulk)} className="btn-ghost">
            <Upload className="h-4 w-4" /> Bulk import
          </button>
          <a href={exportHref} title={leadFilter === 'all' ? 'Export all as CSV' : 'Export this tab as CSV'} className="btn-ghost">
            <Download className="h-4 w-4" /> Export CSV{leadFilter !== 'all' && ` (${visible.length})`}
          </a>
          {selected.size > 0 && (
            <button onClick={handleBatchScan} className="btn-ghost">
              <Zap className="h-4 w-4" /> Scan {selected.size} selected
            </button>
          )}
          {selected.size > 0 && (
            <button onClick={handleBulkDelete} className="btn-ghost text-neon-red">
              <Trash2 className="h-4 w-4" /> Delete {selected.size} selected
            </button>
          )}
          <button onClick={() => setShowForm(!showForm)} className="btn-primary">
            <Plus className="h-4 w-4" /> Add Website
          </button>
        </div>
      </div>

      {showBulk && (
        <form onSubmit={handleBulk} className="panel space-y-3 p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-bold tracking-tight">Bulk import (up to 100)</h2>
            <button type="button" onClick={() => setShowBulk(false)} className="btn-quiet"><X className="h-5 w-5" /></button>
          </div>
          <p className="text-xs text-inkdim">One per line: <code className="font-mono">url, email, niche, name, business, city</code> — only URL is required. Example: <code className="font-mono">acmeplumbing.com, info@acme.com, plumbing</code></p>
          <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)} rows={6} className="field font-mono" placeholder={'acmeplumbing.com, info@acme.com, plumbing\njoesroofing.com\n...'} />
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs text-inkdim">Default niche</label>
            <select value={bulkNiche} onChange={(e) => setBulkNiche(e.target.value)} className="field w-44">
              {['general','plumbing','water-damage','towing','locksmith','hvac','roofing','cleaning','pest','landscaping','medspa','solar'].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-xs text-inkdim">
              <input type="checkbox" checked={bulkAutoScan} onChange={(e) => setBulkAutoScan(e.target.checked)} /> Auto-scan after import
            </label>
            <button type="submit" disabled={isSubmitting} className="btn-primary">{isSubmitting ? 'Importing…' : 'Import'}</button>
          </div>
          {bulkResult && <p className="text-xs text-inkdim">{bulkResult}</p>}
        </form>
      )}

      {actionError && (
        <div className="rounded-xl border border-neon-red/40 bg-neon-red/10 px-4 py-3 text-sm text-neon-red">
          {actionError}
        </div>
      )}

      {batchIds.length > 0 && (
        <div className="panel p-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-display text-lg font-bold tracking-tight">
              Batch scan — {batchDone}/{batchIds.length} done
            </h2>
            <button onClick={() => { setBatchIds([]); setBatchScans([]); }} className="btn-quiet text-xs">Dismiss</button>
          </div>
          <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-grad-neon transition-all"
              style={{ width: `${batchIds.length ? (batchDone / batchIds.length) * 100 : 0}%` }}
            />
          </div>
          <div className="max-h-56 space-y-1.5 overflow-y-auto">
            {batchScans.length === 0 ? (
              <p className="text-xs text-inkdim">Queued… live status appearing in seconds.</p>
            ) : (
              batchScans.map((s) => (
                <Link key={s.id} to={`/scans/${s.id}`} className="flex items-center justify-between gap-2 rounded-lg border border-hairline px-3 py-1.5 text-xs hover:bg-white/[0.03]">
                  <span className="truncate font-mono text-ink" title={s.websiteUrl}>#{s.id} {shortSite(s.websiteUrl)}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {(s.status === 'scanning' || s.status === 'pending') && (
                      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                    )}
                    <StatusBadge status={s.status} />
                    {s.opportunityScore != null && <span className="font-mono text-inkdim">{s.opportunityScore}</span>}
                    <span className="text-primary-hover">live →</span>
                  </span>
                </Link>
              ))
            )}
          </div>
          <p className="mt-2 text-[11px] text-inkdim">Click any row to watch its live terminal. This panel auto-refreshes every 3s.</p>
        </div>
      )}

      {showForm && (
        <div className="panel p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-lg font-bold tracking-tight">New Website</h2>
            <button onClick={() => setShowForm(false)} className="btn-quiet">
              <X className="h-5 w-5" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="field-label">URL or domain (http not needed)</label>
              <input
                type="text"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="field"
                placeholder="emonshah.com"
                required
              />
            </div>
            <div>
              <label className="field-label">Contact Email (optional)</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="field"
                placeholder="lead@example.com"
              />
            </div>
            <div className="sm:col-span-2 flex gap-2">
              <button type="submit" disabled={isSubmitting} className="btn-primary">
                {isSubmitting ? 'Adding…' : 'Add'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="btn-ghost">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {isLoading ? (
        <div className="panel p-8 text-center text-sm text-inkdim">Loading websites…</div>
      ) : websites.length === 0 ? (
        <div className="panel flex flex-col items-center py-14 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-hairline bg-white/[0.03]">
            <Globe className="h-7 w-7 text-inkdim" />
          </div>
          <p className="text-sm text-inkdim">No websites yet. Add one to start scanning.</p>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-5 py-3">
            {([
              { key: 'all', label: `All (${websites.length})`, Icon: LayoutGrid },
              { key: 'to-message', label: `To message (${toMessageCount})`, Icon: MessageCircle },
              { key: 'skipped', label: `Skipped (${skippedCount})`, Icon: SkipForward },
              { key: 'contacted', label: `Contacted (${contactedCount})`, Icon: Send },
            ] as const).map((t) => (
              <button
                key={t.key}
                onClick={() => setLeadFilter(t.key)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${leadFilter === t.key ? 'bg-primary/20 text-primary-hover' : 'text-inkdim hover:text-ink'}`}
              >
                <t.Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-[11px] font-bold uppercase tracking-[0.14em] text-inkdim">
                  <th className="px-5 py-3"><input type="checkbox" checked={visible.length > 0 && selected.size === visible.length && visible.every((w) => selected.has(w.id))} onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((w) => w.id)) : new Set())} /></th>
                  <th className="px-5 py-3">Website</th>
                  <th className="px-5 py-3">Email</th>
                  <th className="px-5 py-3">Latest scan</th>
                  <th className="px-5 py-3">Lead</th>
                  <th className="px-5 py-3">Tech</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((w) => {
                  const ls = w.latestScan;
                  const running = ls && (ls.status === 'scanning' || ls.status === 'pending' || ls.status === 'paused');
                  return (
                  <tr key={w.id} className="border-b border-hairline transition-colors hover:bg-white/[0.02]">
                    <td className="px-5 py-3"><input type="checkbox" checked={selected.has(w.id)} onChange={() => setSelected((prev) => { const n = new Set(prev); if (n.has(w.id)) n.delete(w.id); else n.add(w.id); return n; })} /></td>
                    <td className="px-5 py-3">
                      <a
                        href={visitUrl(w.url, w.normalizedUrl)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Visit site: ${visitUrl(w.url, w.normalizedUrl)}`}
                        className="group/site flex items-center gap-2 font-mono text-sm text-ink hover:text-primary-hover"
                      >
                        <Globe className="h-3.5 w-3.5 shrink-0 text-inkdim transition-colors group-hover/site:text-primary-hover" />
                        <span className="group-hover/site:underline" title={shortSite(w.normalizedUrl || w.url)}>{brandName(w.normalizedUrl || w.url)}</span>
                        <ExternalLink className="h-3 w-3 shrink-0 text-inkdim/60 transition-colors group-hover/site:text-primary-hover" />
                      </a>
                      {w.doNotEmail && (
                        <div className="mt-1" title={w.parkedAt ? `Parked since ${w.parkedAt.slice(0, 10)} — dead site, excluded from outreach. Re-scan revives it.` : 'Parked — dead site, excluded from outreach. Re-scan revives it.'}>
                          <span className="rounded-full border border-neon-amber/40 bg-neon-amber/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-neon-amber">
                            Parked
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {w.contactEmail ? (
                        <span className="flex flex-col items-start gap-1">
                          <button
                            type="button"
                            onClick={() => void handleCopyEmail(w.id, w.contactEmail!)}
                            title={copiedEmailId === w.id ? 'Copied!' : 'Click to copy email'}
                            aria-live="polite"
                            className="group/email flex max-w-[220px] items-center gap-1.5 font-mono text-[11px] text-inkdim transition-colors hover:text-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded-sm"
                          >
                            {copiedEmailId === w.id ? (
                              <>
                                <Check className="h-3 w-3 shrink-0 text-neon-green" />
                                <span className="shrink-0 text-neon-green">Copied</span>
                              </>
                            ) : (
                              <>
                                <span className="truncate" title={w.contactEmail}>{w.contactEmail}</span>
                                <Copy className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/email:opacity-100" />
                              </>
                            )}
                          </button>
                          <EmailStatusBadge status={w.emailStatus} manual={w.emailManual} checkedAt={w.emailCheckedAt} />
                        </span>
                      ) : (
                        <span className="font-mono text-[11px] text-inkdim" title="No email on file">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {!ls ? (
                        <span className="text-xs text-inkdim">never scanned</span>
                      ) : (
                        <span className="flex items-center gap-2">
                          {running && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                          <StatusBadge status={ls.status} />
                          {ls.opportunityScore != null && (
                            <span className="font-mono text-xs text-inkdim">{ls.opportunityScore}</span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className="flex flex-col items-start gap-1">
                        <LeadStatusBadge status={w.leadStatus} />
                        {w.suggestedAction?.action === 'skip' && isWorkable(w) && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-inkdim" title={w.suggestedAction.reason}>
                            <ArrowDown className="h-3 w-3" /> Skip suggested
                          </span>
                        )}
                        {w.suggestedAction?.action === 'message' && isWorkable(w) && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-neon-green" title={w.suggestedAction.reason}>
                            <MessageCircle className="h-3 w-3" /> Message
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-inkdim">{w.primaryTech ?? '—'}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-right">
                      <span className="inline-flex items-center gap-1.5">
                        {isWorkable(w) && (
                          <button
                            onClick={() => handleLeadStatus(w.id, 'skipped')}
                            title={w.suggestedAction ? w.suggestedAction.reason : 'Skip this client'}
                            className="btn-ghost px-2 py-1 text-[11px]"
                          >
                            <SkipForward className="h-3 w-3" /> Skip
                          </button>
                        )}
                        <select
                          value={w.leadStatus}
                          onChange={(e) => handleLeadStatus(w.id, e.target.value as LeadStatus)}
                          title="Lead pipeline status"
                          className="rounded-lg border border-hairline bg-white/[0.04] px-1.5 py-1 text-[11px] text-inkdim focus:outline-none"
                        >
                          {(['new', 'qualified', 'skipped', 'contacted', 'replied'] as const).map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                        {ls && (
                          <Link to={`/scans/${ls.id}`} className="btn-ghost px-2 py-1 text-[11px]">
                            <Eye className="h-3 w-3" /> View
                          </Link>
                        )}
                        {ls && ls.status !== 'scanning' && ls.status !== 'pending' && (
                          <button
                            onClick={() => void handleCopyBrief(ls.id)}
                            title={copiedScanId === ls.id ? 'Copied! Paste into any LLM' : 'Copy LLM brief (paste into ChatGPT/Claude/Gemini)'}
                            className="btn-ghost px-2 py-1 text-[11px]"
                          >
                            {copiedScanId === ls.id ? (
                              <><Check className="h-3 w-3 text-neon-green" /> Copied</>
                            ) : (
                              <><Code2 className="h-3 w-3" /> Copy</>
                            )}
                          </button>
                        )}
                        <button
                          onClick={() => handleScan(w.id)}
                          disabled={!!running}
                          className="btn-primary px-2 py-1 text-[11px] disabled:opacity-40"
                        >
                          {running ? 'Scanning…' : ls ? 'Re-scan' : 'Scan'}
                        </button>
                      </span>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
