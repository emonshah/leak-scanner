import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/api/client';
import type { LogEntry } from '@/types';

function keyOf(l: LogEntry): string {
  return `${l.t}|${l.stage}|${l.status}|${l.msg}`;
}

/**
 * Live scan log: history first (so reload shows everything),
 * then live WebSocket appends, plus polling fallback every 3s
 * while the scan is active (WS can drop behind proxies).
 * Auto-reconnects WS on close.
 */
export function useScanStream(scanId: number | null, active: boolean) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const seenRef = useRef<Set<string>>(new Set());
  const activeRef = useRef(active);
  activeRef.current = active;

  // Load history once per scan
  useEffect(() => {
    if (!scanId) return;
    seenRef.current = new Set();
    setLogs([]);
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiFetch<{ ok: boolean; log: LogEntry[] }>(`/api/scans/${scanId}/log`);
        if (cancelled) return;
        const keys = new Set<string>();
        const clean = (data.log ?? []).filter((l) => {
          const k = keyOf(l);
          if (keys.has(k)) return false;
          keys.add(k);
          return true;
        });
        seenRef.current = keys;
        setLogs(clean);
      } catch {
        /* history is best-effort; live stream still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  // Live WebSocket with reconnect
  useEffect(() => {
    if (!scanId) return;
    const baseUrl = import.meta.env.VITE_API_URL || window.location.origin;
    const proto = baseUrl.startsWith('https') ? 'wss' : 'ws';
    const host = baseUrl.replace(/^https?:\/\//, '');
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(`${proto}://${host}/api/scans/${scanId}/stream`);
      } catch {
        timer = setTimeout(connect, 3000);
        return;
      }
      ws.onopen = () => {
        setConnected(true);
        try {
          ws?.send(JSON.stringify({ type: 'subscribe', scanId }));
        } catch {
          /* ignore */
        }
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data?.type === 'log' && data.entry) {
            const entry = data.entry as LogEntry;
            const k = keyOf(entry);
            if (!seenRef.current.has(k)) {
              seenRef.current.add(k);
              setLogs((prev) => [...prev, entry]);
            }
          }
        } catch {
          /* ignore malformed messages */
        }
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        ws = null;
        // Reconnect only while scan is still active
        if (!closed && activeRef.current) {
          timer = setTimeout(connect, 3000);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      setConnected(false);
    };
  }, [scanId]);

  // Polling fallback while active (covers WS drops + cookie-less proxies)
  useEffect(() => {
    if (!scanId || !active) return;
    const iv = setInterval(() => {
      void (async () => {
        try {
          const data = await apiFetch<{ ok: boolean; log: LogEntry[] }>(`/api/scans/${scanId}/log`);
          const incoming = data.log ?? [];
          let added = 0;
          for (const l of incoming) {
            const k = keyOf(l);
            if (!seenRef.current.has(k)) {
              seenRef.current.add(k);
              added++;
            }
          }
          if (added > 0) {
            // Rebuild in server order, deduped
            const keys = new Set<string>();
            const merged = incoming.filter((l) => {
              const k = keyOf(l);
              if (keys.has(k)) return false;
              keys.add(k);
              return true;
            });
            setLogs(merged);
          }
        } catch {
          /* polling is best-effort */
        }
      })();
    }, 3000);
    return () => clearInterval(iv);
  }, [scanId, active]);

  return { logs, connected };
}
