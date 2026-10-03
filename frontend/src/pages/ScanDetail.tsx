import { useParams } from 'react-router-dom';
import { useScan } from '@/hooks/useScans';
import { useScanStream } from '@/hooks/useWebSocket';
import { StatusBadge } from '@/components/StatusBadge';
import { FindingCard } from '@/components/FindingCard';
import { ProgressStream } from '@/components/ProgressStream';
import { EvidenceViewer } from '@/components/EvidenceViewer';
import { ArrowLeft, RefreshCw, RotateCcw, Pause, Play, Square, Trash2, Copy, Check, Printer, Code2, ShieldAlert } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { apiFetch, apiPost, apiDelete } from '@/api/client';
import type { ScanRow, Finding, ScanQuality } from '@/types';
import { useState, useEffect, useRef } from 'react';

export function ScanDetail() {
  const { id } = useParams<{ id: string }>();
  const scanId = Number(id);
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'findings' | 'pages' | 'browser' | 'security' | 'tech' | 'logs'>('findings');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [quality, setQuality] = useState<ScanQuality | null>(null);
  const [securityChecks, setSecurityChecks] = useState<Array<Record<string, unknown>>>([]);
  const [tech, setTech] = useState<Record<string, unknown> | null>(null);
  const [pages, setPages] = useState<Array<Record<string, unknown>>>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  const { scan, isLoading, error, refetch } = useScan(scanId, 3000);
  const isActive = scan?.status === 'scanning' || scan?.status === 'pending' || scan?.status === 'paused';
  const { logs, connected } = useScanStream(scanId, isActive);

  // Findings + quality: load once (quality strip lives in the header, so it
  // must not wait for the Security tab), then refresh silently while active.
  useEffect(() => {
    if (!scanId) return;
    let cancelled = false;
    void (async () => {
      try {
        const fData = await apiFetch<{ ok: boolean; scan: ScanRow; findings: Finding[] }>(`/api/scans/${scanId}`);
        if (!cancelled) {
          setFindings(fData.findings);
          if (fData.scan?.quality) setQuality(fData.scan.quality);
        }
      } catch (e) {
        if (!cancelled) setActionError(`Load failed: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  // While active, refresh findings silently (new findings stream in at finish)
  useEffect(() => {
    if (!scanId || !isActive) return;
    const iv = setInterval(() => {
      void (async () => {
        try {
          const fData = await apiFetch<{ ok: boolean; scan: ScanRow; findings: Finding[] }>(`/api/scans/${scanId}`);
          setFindings(fData.findings);
          if (fData.scan?.quality) setQuality(fData.scan.quality);
        } catch {
          /* best-effort */
        }
      })();
    }, 5000);
    return () => clearInterval(iv);
  }, [scanId, isActive]);

  // Refresh findings right when a scan completes
  const prevStatus = useRef<string | null>(null);
  useEffect(() => {
    const s = scan?.status ?? null;
    if (prevStatus.current && prevStatus.current !== s && s === 'completed') {
      void (async () => {
        try {
          const fData = await apiFetch<{ ok: boolean; scan: ScanRow; findings: Finding[] }>(`/api/scans/${scanId}`);
          setFindings(fData.findings);
          if (fData.scan?.quality) setQuality(fData.scan.quality);
        } catch {
          /* ignore */
        }
      })();
      setActiveTab('findings');
    }
    prevStatus.current = s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan?.status]);

  // Default to the live terminal while a scan is running
  useEffect(() => {
    if (isActive) setActiveTab('logs');
  }, [isActive]);

  useEffect(() => {
    if (!scanId) return;
    if (activeTab !== 'security' && activeTab !== 'tech' && activeTab !== 'pages') return;
    void loadTabData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanId, activeTab]);

  async function loadTabData() {
    if (!scanId) return;
    try {
      if (activeTab === 'security') {
        const data = await apiFetch<{ ok: boolean; checks: Array<Record<string, unknown>>; quality: ScanQuality | null }>(`/api/scans/${scanId}/security`);
        setSecurityChecks(data.checks);
        setQuality(data.quality);
      } else if (activeTab === 'tech') {
        const data = await apiFetch<{ ok: boolean; items: Array<Record<string, unknown>>; primaryPlatform: string | null }>(`/api/scans/${scanId}/tech`);
        setTech(data);
      } else if (activeTab === 'pages') {
        const data = await apiFetch<{ ok: boolean; pages: Array<Record<string, unknown>> }>(`/api/scans/${scanId}/pages`);
        setPages(data.pages);
      }
    } catch (e) {
      setActionError(`Tab load failed: ${(e as Error).message}`);
    }
  }

  const handleRetry = async () => {
    try {
      await apiPost(`/api/scans/${scanId}/retry`, {});
      setActionError(null);
      void refetch();
    } catch (e) {
      setActionError(`Retry failed: ${(e as Error).message}`);
    }
  };

  const [rescanning, setRescanning] = useState(false);
  const handleRescan = async () => {
    if (!scan || rescanning) return;
    setRescanning(true);
    try {
      const data = await apiPost<{ ok: boolean; scanIds: number[] }>('/api/scans', { websiteIds: [scan.websiteId] });
      const newId = data.scanIds[0];
      if (newId) navigate(`/scans/${newId}`);
    } catch (e) {
      setActionError(`Re-scan failed: ${(e as Error).message}`);
    } finally {
      setRescanning(false);
    }
  };

  const handlePause = async () => {
    try {
      await apiPost(`/api/scans/${scanId}/pause`, {});
      setActionError(null);
      void refetch();
    } catch (e) {
      setActionError(`Pause failed: ${(e as Error).message}`);
    }
  };

  const handleResume = async () => {
    try {
      await apiPost(`/api/scans/${scanId}/resume`, {});
      setActionError(null);
      void refetch();
    } catch (e) {
      setActionError(`Resume failed: ${(e as Error).message}`);
    }
  };

  const handleCancel = async () => {
    try {
      await apiPost(`/api/scans/${scanId}/cancel`, {});
      setActionError(null);
      void refetch();
    } catch (e) {
      setActionError(`Cancel failed: ${(e as Error).message}`);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this scan and all its findings?')) return;
    try {
      await apiDelete<{ ok: boolean }>(`/api/scans/${scanId}`);
      navigate('/');
    } catch (e) {
      setActionError(`Delete failed: ${(e as Error).message}`);
    }
  };

  const handlePrint = () => {
    window.open(`/scans/${scanId}/report`, '_blank');
  };

  const [copyAllState, setCopyAllState] = useState<'idle' | 'done' | 'fail'>('idle');
  const handleDeleteFinding = async (fid: number) => {
    try {
      await apiDelete<{ ok: boolean; opportunityScore: number | null }>(`/api/scans/${scanId}/findings/${fid}`);
      setFindings((prev) => prev.filter((f) => f.id !== fid));
      void refetch(true);
    } catch (e) {
      setActionError(`Finding delete failed: ${(e as Error).message}`);
    }
  };

  const handleCopyAll = async () => {
    try {
      const data = await apiFetch<{ ok: boolean; brief: string }>(`/api/scans/${scanId}/llm-brief`);
      await navigator.clipboard.writeText(data.brief);
      setCopyAllState('done');
      setTimeout(() => setCopyAllState('idle'), 2000);
    } catch (e) {
      setActionError(`Copy failed: ${(e as Error).message}`);
      setCopyAllState('fail');
      setTimeout(() => setCopyAllState('idle'), 2000);
    }
  };

  const [briefCopied, setBriefCopied] = useState(false);
  const handleCopyBrief = async () => {
    try {
      const data = await apiFetch<{ ok: boolean; brief: string }>(`/api/scans/${scanId}/llm-brief`);
      await navigator.clipboard.writeText(data.brief);
      setBriefCopied(true);
      setTimeout(() => setBriefCopied(false), 2000);
    } catch (e) {
      setActionError(`Copy failed: ${(e as Error).message}`);
    }
  };

  if (isLoading) return <div className="p-6 text-sm text-inkdim">Loading scan…</div>;
  if (error || !scan) return <div className="p-6 text-sm text-neon-red">{error ?? 'Scan not found'}</div>;

  const score = scan.opportunityScore ?? 0;
  const scoreColor = score >= 60 ? 'text-neon-red' : score >= 30 ? 'text-neon-amber' : 'text-neon-green';

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="btn-quiet">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="font-display text-xl font-bold tracking-tight">Scan #{scan.id}</h1>
          <StatusBadge status={scan.status} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleCopyBrief()}
            title={briefCopied ? 'Copied! Paste into any LLM' : 'Copy LLM brief (paste into ChatGPT/Claude/Gemini)'}
            className="btn-quiet border border-hairline"
          >
            {briefCopied ? <Check className="h-4 w-4 text-neon-green" /> : <Code2 className="h-4 w-4" />}
          </button>
          <button onClick={handlePrint} title="Report JSON / Print to PDF" className="btn-quiet border border-hairline">
            <Printer className="h-4 w-4" />
          </button>
          {scan.status === 'scanning' && (
            <button onClick={() => void handlePause()} title="Pause" className="btn-quiet border border-hairline">
              <Pause className="h-4 w-4" />
            </button>
          )}
          {scan.status === 'paused' && (
            <button onClick={() => void handleResume()} title="Resume" className="btn-quiet border border-hairline">
              <Play className="h-4 w-4" />
            </button>
          )}
          {(scan.status === 'failed' || scan.status === 'blocked') && (
            <button onClick={() => void handleRetry()} title="Retry" className="btn-quiet border border-hairline">
              <RefreshCw className="h-4 w-4" />
            </button>
          )}
          {scan.status !== 'scanning' && scan.status !== 'pending' && (
            <button
              onClick={() => void handleRescan()}
              disabled={rescanning}
              title="Start a fresh scan of this website"
              className="btn-primary px-4 py-2 text-xs disabled:opacity-40"
            >
              <RotateCcw className={`h-3.5 w-3.5 ${rescanning ? 'animate-spin' : ''}`} />
              {rescanning ? 'Starting…' : 'Re-scan'}
            </button>
          )}
          <button onClick={() => void handleCancel()} title="Cancel" className="btn-quiet border border-hairline">
            <Square className="h-4 w-4" />
          </button>
          <button onClick={() => void handleDelete()} title="Delete" className="btn-quiet border border-neon-red/40 text-neon-red hover:bg-neon-red/10">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </header>

      <main className="space-y-6">
        {actionError && (
          <div className="rounded-xl border border-neon-red/40 bg-neon-red/10 px-4 py-3 text-sm text-neon-red">
            {actionError}
          </div>
        )}
        <div className="panel p-6">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <a href={scan.normalizedUrl || scan.websiteUrl} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-lg text-ink hover:text-primary-hover hover:underline">
                {scan.websiteUrl}
              </a>
              <p className="mt-1 text-sm text-inkdim">{scan.createdBy?.email ?? 'Unknown'}</p>
            </div>
            <div className="shrink-0 text-right">
              <div className={`font-display text-4xl font-bold ${scoreColor}`}>{score}/100</div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-inkdim">score</div>
            </div>
          </div>
          {scan.error && <p className="mt-3 text-sm text-neon-red">{scan.error}</p>}
          {quality && (
            <div className="mt-4 grid grid-cols-2 gap-4 text-center text-sm sm:grid-cols-5">
              <div><span className="font-medium text-ink">{quality.pagesAnalyzed}</span><span className="text-inkdim"> pages</span></div>
              <div><span className="font-medium text-ink">{quality.checksCompleted}</span><span className="text-inkdim"> checks done</span></div>
              <div><span className="font-medium text-ink">{quality.visualChecks}</span><span className="text-inkdim"> visual</span></div>
              <div><span className="font-medium text-ink">{quality.contradictions}</span><span className="text-inkdim"> contradictions</span></div>
              <div><span className="font-medium text-ink">{quality.suppressed}</span><span className="text-inkdim"> suppressed</span></div>
            </div>
          )}
        </div>

        {isActive && activeTab !== 'logs' && (
          <div className="mb-6">
            <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-primary">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
              Live scan — {connected ? 'streaming' : 'polling'} progress
            </div>
            <ProgressStream logs={logs} connected={connected} />
          </div>
        )}

        <div className="flex gap-2 border-b border-hairline">
          <nav className="-mb-px flex gap-6">
            {[
              { key: 'findings', label: 'Findings' },
              { key: 'pages', label: 'Pages' },
              { key: 'browser', label: 'Browser' },
              { key: 'security', label: 'Security' },
              { key: 'tech', label: 'Technology' },
              { key: 'logs', label: 'Logs' },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key as typeof activeTab)}
                className={`border-b-2 px-1 py-2 text-sm font-medium ${
                  activeTab === t.key
                    ? 'border-primary text-primary-hover'
                    : 'border-transparent text-inkdim hover:text-ink'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>

        {activeTab === 'findings' && (
          <div className="space-y-3">
            {findings.length > 0 && (
              <div className="flex items-center justify-between">
                <p className="text-xs text-inkdim">
                  {findings.length} leak{findings.length === 1 ? '' : 's'} — wrong ones delete koren, baki gula ekbare copy hobe
                </p>
                <button onClick={() => void handleCopyAll()} className="btn-primary px-4 py-2 text-xs">
                  {copyAllState === 'done' ? (
                    <><Check className="h-3.5 w-3.5" /> Copied! Paste into LLM</>
                  ) : copyAllState === 'fail' ? (
                    'Copy failed — retry'
                  ) : (
                    <><Copy className="h-3.5 w-3.5" /> Copy all ({findings.length}) → LLM</>
                  )}
                </button>
              </div>
            )}
            {findings.length === 0 ? (
              scan.status === 'blocked' || scan.status === 'failed' ? (
                <div className="panel flex flex-col items-center p-8 text-center">
                  <ShieldAlert className="h-8 w-8 text-neon-amber" />
                  <p className="mt-2 text-sm font-medium text-ink">
                    {scan.status === 'blocked' ? 'Bot protection blocked this scan' : 'This scan could not complete'}
                  </p>
                  <p className="mt-1 max-w-md text-xs text-inkdim">
                    {scan.status === 'blocked'
                      ? 'The site refused automated checks (bot wall / WAF). Findings would be guesses — verify the site manually in your own browser instead.'
                      : 'No findings because the scan did not finish — this is NOT a clean site. Check the error above or Logs tab, then Retry.'}
                  </p>
                  {scan.error && <p className="mt-2 font-mono text-[11px] text-neon-red">{scan.error}</p>}
                </div>
              ) : (
                <p className="text-sm text-inkdim">No findings for this scan.</p>
              )
            ) : (
              findings.map((f) => <FindingCard key={f.id} finding={f} onDelete={handleDeleteFinding} />)
            )}
          </div>
        )}

        {activeTab === 'pages' && (
          <div className="panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hairline text-left text-[11px] font-bold uppercase tracking-[0.14em] text-inkdim">
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">URL</th>
                    <th className="px-5 py-3">Title</th>
                    <th className="px-5 py-3">Response</th>
                  </tr>
                </thead>
                <tbody>
                  {(pages as Array<{ statusCode: number; url: string; title: string | null; responseTimeMs: number | null }>).map((p, i) => (
                    <tr key={i} className="border-b border-hairline transition-colors hover:bg-white/[0.02]">
                      <td className="px-5 py-3 font-mono text-ink">{p.statusCode ?? 'ERR'}</td>
                      <td className="px-5 py-3 font-mono text-ink">{p.url}</td>
                      <td className="px-5 py-3 text-inkdim">{p.title ?? ''}</td>
                      <td className="px-5 py-3 text-inkdim">{p.responseTimeMs ? `${p.responseTimeMs}ms` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'browser' && <EvidenceViewer scanId={scanId} />}

        {activeTab === 'security' && (
          <div className="space-y-2">
            {(securityChecks as Array<{ checkId: string; title: string; status: string; risk: string; recommendation: string }>).map((c, i) => (
              <div key={i} className="panel p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{c.title}</span>
                  <StatusBadge status={c.status as ScanRow['status']} />
                </div>
                <p className={`mt-1 text-xs ${c.status === 'FAIL' ? 'text-neon-red' : c.status === 'WARNING' ? 'text-neon-amber' : 'text-inkdim'}`}>{c.status} · {c.risk}</p>
                {c.recommendation && <p className="mt-1 text-sm text-inkdim">{c.recommendation}</p>}
              </div>
            ))}
            {securityChecks.length === 0 && <p className="text-sm text-inkdim">No security checks yet.</p>}
          </div>
        )}

        {activeTab === 'tech' && (
          <div className="space-y-2">
            <p className="text-sm text-inkdim">Primary platform: <span className="text-ink">{(tech as { primaryPlatform: string | null } | null)?.primaryPlatform ?? 'unknown'}</span></p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(((tech as { items: Array<{ technology: string; version: string | null; confidence: string }> } | null)?.items) ?? []).map((item, i) => (
                <div key={i} className="panel p-4">
                  <span className="font-medium text-ink">{item.technology}</span>
                  {item.version && <span className="text-sm text-inkdim"> v{item.version}</span>}
                  <span className="text-xs text-inkdim"> ({item.confidence})</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'logs' && (
          <ProgressStream logs={logs} connected={connected} />
        )}
      </main>
    </div>
  );
}
