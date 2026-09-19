import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { logger } from '../logger';
import { AccountWorker } from './AccountWorker';

class SyncManager {
  private readonly workers = new Map<number, AccountWorker>();
  private readonly log = logger.child({ mod: 'sync' });

  /** Start workers for every enabled account. */
  startAll(): void {
    const rows = getDb().select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.enabled, 1)).all();
    for (const r of rows) this.startAccount(r.id);
    this.log.info({ count: rows.length }, 'sync manager started');
  }

  startAccount(accountId: number): void {
    if (this.workers.has(accountId)) return;
    try {
      const w = new AccountWorker(accountId);
      this.workers.set(accountId, w);
      w.start();
    } catch (err) {
      this.log.error({ err, accountId }, 'failed to start worker');
    }
  }

  async stopAccount(accountId: number): Promise<void> {
    const w = this.workers.get(accountId);
    if (!w) return;
    this.workers.delete(accountId);
    await w.stop();
  }

  async restartAccount(accountId: number): Promise<void> {
    await this.stopAccount(accountId);
    const row = getDb().select({ enabled: schema.accounts.enabled }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
    if (row?.enabled === 1) this.startAccount(accountId);
  }

  requestSync(accountId: number): boolean {
    const w = this.workers.get(accountId);
    if (!w) return false;
    const st = w.getState();
    if (st === 'error' || st === 'stopped') {
      // A worker that gave up (auth failure) is not sleeping, so a wake-up does nothing; restart it.
      this.log.info({ accountId, state: st }, 'restarting stopped worker on sync request');
      void this.restartAccount(accountId);
      return true;
    }
    w.requestSync();
    return true;
  }

  getWorker(accountId: number): AccountWorker | undefined {
    return this.workers.get(accountId);
  }

  getWorkerState(accountId: number): string | null {
    return this.workers.get(accountId)?.getState() ?? null;
  }

  async stopAll(): Promise<void> {
    const all = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(all.map((w) => w.stop()));
    this.log.info('sync manager stopped');
  }
}

export const syncManager = new SyncManager();
