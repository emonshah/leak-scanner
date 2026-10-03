import { getPool } from '../db/mysql.js';

const pausedIds = new Set<number>();
const cancelledIds = new Set<number>();
let stopping = false;

export function markPaused(id: number): void {
  pausedIds.add(id);
}
export function unmarkPaused(id: number): void {
  pausedIds.delete(id);
}
export function isPaused(id: number): boolean {
  return pausedIds.has(id);
}
export function markCancelled(id: number): void {
  cancelledIds.add(id);
}
export function isCancelled(id: number): boolean {
  return cancelledIds.has(id);
}
export function cancelledCount(): number {
  return cancelledIds.size;
}
export function clearCancelled(): number {
  const n = cancelledIds.size;
  cancelledIds.clear();
  return n;
}
export function requestStop(): void {
  stopping = true;
}
export function shouldStop(): boolean {
  return stopping;
}

export async function getScanStatus(id: number): Promise<string | null> {
  try {
    const [rows] = await getPool().query('SELECT status FROM scans WHERE id = ?', [id]);
    return ((rows as { status: string }[])[0]?.status ?? null) as string | null;
  } catch {
    return null;
  }
}
