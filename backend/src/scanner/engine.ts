/**
 * Queue/worker interface skeleton for STEP 15 (batch queue).
 * Single responsibility now: define the contract, no implementation.
 */

import type { ScanStatus } from './types';

export interface ScanJob {
  id: string;
  url: string;
  status: ScanStatus;
  createdAt: string;
}

export interface ScannerEngine {
  enqueue(url: string): Promise<ScanJob>;
  // pause/resume lands in STEP 16
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
}

export class StubEngine implements ScannerEngine {
  async enqueue(_url: string): Promise<ScanJob> {
    throw new Error('Queue not implemented until STEP 15');
  }
  async pause(_id: string): Promise<void> {
    throw new Error('Pause/resume not implemented until STEP 16');
  }
  async resume(_id: string): Promise<void> {
    throw new Error('Pause/resume not implemented until STEP 16');
  }
}
