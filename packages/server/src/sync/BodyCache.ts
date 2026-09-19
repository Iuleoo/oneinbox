import { sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { logger } from '../logger';
import { readSettings } from '../routes/settings';

const log = logger.child({ mod: 'body-cache' });

/**
 * Keep cached bodies under `bodyCacheMaxMb` by evicting the least recently fetched ones.
 * Evicted rows go back to body_state='none' and are re-fetched on demand.
 */
export function pruneBodyCache(maxBytesOverride?: number): { before: number; evicted: number } {
  const db = getDb();
  const maxBytes = maxBytesOverride ?? readSettings().bodyCacheMaxMb * 1024 * 1024;
  const sizeRow = db
    .select({ bytes: sql<number>`coalesce(sum(length(${schema.messages.bodyHtml}) + length(${schema.messages.bodyText})), 0)` })
    .from(schema.messages)
    .get();
  const before = sizeRow?.bytes ?? 0;
  if (before <= maxBytes) return { before, evicted: 0 };

  // Evict oldest-fetched until under 90% of the cap to avoid pruning every run.
  const target = Math.floor(maxBytes * 0.9);
  let freed = 0;
  let evicted = 0;
  const rows = db
    .select({ id: schema.messages.id, bytes: sql<number>`length(${schema.messages.bodyHtml}) + length(${schema.messages.bodyText})` })
    .from(schema.messages)
    .where(sql`${schema.messages.bodyState} = 'ready'`)
    .orderBy(sql`${schema.messages.bodyFetchedAt} asc`)
    .all();
  db.transaction((tx) => {
    for (const r of rows) {
      if (before - freed <= target) break;
      tx.run(sql`update messages set body_html = null, body_text = null, body_state = 'none', body_fetched_at = null where id = ${r.id}`);
      freed += r.bytes ?? 0;
      evicted++;
    }
  });
  log.info({ beforeMb: (before / 1048576).toFixed(1), evicted, freedMb: (freed / 1048576).toFixed(1) }, 'body cache pruned');
  return { before, evicted };
}
