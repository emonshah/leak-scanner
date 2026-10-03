import { useEffect, useState } from 'react';
import { apiFetch } from '@/api/client';
import type { ScanRow, WebsiteDTO } from '@/types';

export function useWebsites() {
  const [websites, setWebsites] = useState<WebsiteDTO[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = () => {
    setIsLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await apiFetch<{ ok: boolean; websites: WebsiteDTO[] }>('/api/websites');
        setWebsites(data.websites);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setIsLoading(false);
      }
    })();
  };

  useEffect(() => refetch(), []);
  return { websites, isLoading, error, refetch };
}

export function useScans(pollWhileActiveMs = 0) {
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = (silent = false) => {
    if (!silent) {
      setIsLoading(true);
      setError(null);
    }
    void (async () => {
      try {
        const data = await apiFetch<{ ok: boolean; scans: ScanRow[] }>('/api/scans?limit=50');
        setScans(data.scans);
      } catch (e) {
        if (!silent) setError((e as Error).message);
      } finally {
        if (!silent) setIsLoading(false);
      }
    })();
  };

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-update the list while anything is running (no loading flash)
  useEffect(() => {
    if (!pollWhileActiveMs) return;
    const iv = setInterval(() => {
      void (async () => {
        try {
          const data = await apiFetch<{ ok: boolean; scans: ScanRow[] }>('/api/scans?limit=50');
          setScans(data.scans);
        } catch {
          /* best-effort */
        }
      })();
    }, pollWhileActiveMs);
    return () => clearInterval(iv);
  }, [pollWhileActiveMs]);

  return { scans, isLoading, error, refetch };
}

export function useScan(id: number, pollWhileActiveMs = 0) {
  const [scan, setScan] = useState<ScanRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = (silent = false) => {
    if (!id) return;
    if (!silent) {
      setIsLoading(true);
      setError(null);
    }
    void (async () => {
      try {
        const data = await apiFetch<{ ok: boolean; scan: ScanRow; findings: unknown[] }>(`/api/scans/${id}`);
        setScan(data.scan);
      } catch (e) {
        if (!silent) setError((e as Error).message);
      } finally {
        if (!silent) setIsLoading(false);
      }
    })();
  };

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!pollWhileActiveMs || !id) return;
    const iv = setInterval(() => refetch(true), pollWhileActiveMs);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, pollWhileActiveMs]);

  return { scan, isLoading, error, refetch };
}
