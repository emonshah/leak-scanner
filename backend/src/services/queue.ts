import { getPool } from '../db/mysql.js';
import { config } from '../config.js';
import { runScanPipeline } from './pipeline.js';
import { markPaused, unmarkPaused, markCancelled } from './queue-state.js';
import { createScan, getScan, resetScanForRetry, setScanStatus } from './scans.js';

class ScanQueue {
  private running = 0;
  private pending: number[] = [];
  private active = new Map<number, Promise<void>>();

  get concurrency(): number {
    return Math.min(Math.max(config.scan.concurrency, 1), 8);
  }

  get runningCount(): number {
    return this.running;
  }

  get queuedCount(): number {
    return this.pending.length;
  }

  get activeIds(): number[] {
    return [...this.active.keys()];
  }

  get pendingIds(): number[] {
    return [...this.pending];
  }

  async enqueueWebsite(websiteId: number): Promise<number> {
    const scanId = await createScan(websiteId);
    this.pending.push(scanId);
    void this.pump();
    return scanId;
  }

  async enqueueMany(websiteIds: number[]): Promise<number[]> {
    const ids: number[] = [];
    for (const wid of websiteIds) {
      ids.push(await this.enqueueWebsite(wid));
    }
    return ids;
  }

  async retry(scanId: number): Promise<void> {
    const scan = await getScan(scanId);
    if (!scan) throw new Error('Scan not found.');
    if (scan.status === 'scanning') throw new Error('Scan is currently running.');
    unmarkPaused(scanId);
    await resetScanForRetry(scanId);
    this.pending.push(scanId);
    void this.pump();
  }

  async pause(scanId: number): Promise<void> {
    const scan = await getScan(scanId);
    if (!scan) throw new Error('Scan not found.');
    markPaused(scanId);
    if (scan.status === 'pending') {
      this.pending = this.pending.filter((id) => id !== scanId);
      await setScanStatus(scanId, 'paused');
    }
  }

  async resume(scanId: number): Promise<void> {
    const scan = await getScan(scanId);
    if (!scan) throw new Error('Scan not found.');
    unmarkPaused(scanId);
    if (scan.status === 'paused' || scan.status === 'blocked' || scan.status === 'failed') {
      await resetScanForRetry(scanId);
      this.pending.push(scanId);
      void this.pump();
    }
  }

  async cancel(scanId: number): Promise<void> {
    const scan = await getScan(scanId);
    if (!scan) throw new Error('Scan not found.');
    if (scan.status === 'completed') throw new Error('Scan already completed.');
    this.pending = this.pending.filter((id) => id !== scanId);
    unmarkPaused(scanId);
    markCancelled(scanId);
    await setScanStatus(scanId, 'cancelled');
  }

  private async pump(): Promise<void> {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const scanId = this.pending.shift()!;
      if (this.active.has(scanId)) continue;
      this.running++;
      const job = this.execute(scanId).finally(() => {
        this.running--;
        this.active.delete(scanId);
        void this.pump();
      });
      this.active.set(scanId, job);
    }
  }

  private async execute(scanId: number): Promise<void> {
    try {
      const [rows] = await getPool().query(
        'SELECT w.id AS website_id, w.normalized_url AS url FROM scans s JOIN websites w ON w.id = s.website_id WHERE s.id = ?',
        [scanId],
      );
      const row = (rows as { website_id: number; url: string }[])[0];
      if (!row) {
        await setScanStatus(scanId, 'failed', { error: 'Website no longer exists.' });
        return;
      }
      await runScanPipeline(scanId, row.website_id, row.url);
    } catch (err) {
      try {
        await setScanStatus(scanId, 'failed', {
          error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        });
      } catch {
        /* status write failed */
      }
    }
  }
}

export const scanQueue = new ScanQueue();
