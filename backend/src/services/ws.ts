type LogEntry = {
  t: string;
  stage: string;
  status: 'running' | 'done' | 'error';
  msg: string;
};

const subscribers = new Map<number, Set<{ send: (data: unknown) => void }>>();

export function subscribe(scanId: number, client: { send: (data: unknown) => void }): () => void {
  let set = subscribers.get(scanId);
  if (!set) {
    set = new Set();
    subscribers.set(scanId, set);
  }
  set.add(client);
  return () => {
    set?.delete(client);
    if (set && set.size === 0) subscribers.delete(scanId);
  };
}

export function broadcastLog(scanId: number, entry: LogEntry): void {
  const set = subscribers.get(scanId);
  if (!set) return;
  const payload = JSON.stringify({ type: 'log', entry });
  for (const client of set) {
    try {
      client.send(payload);
    } catch {
      /* client gone — ignored */
    }
  }
}

export type { LogEntry };
