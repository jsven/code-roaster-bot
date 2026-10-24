import type { ReviewOrchestrator } from './review-orchestrator.js';
import type { ReviewQueuePort } from './ports.js';

export class ReviewWorker {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly queue: ReviewQueuePort, private readonly orchestrator: ReviewOrchestrator, private readonly intervalMs = 1000, private readonly staleMs = 30 * 60 * 1000) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.queue.requeueStale(this.staleMs);
      const job = this.queue.claimNext();
      if (job) await this.orchestrator.execute(job);
    } finally {
      this.busy = false;
    }
  }
}
