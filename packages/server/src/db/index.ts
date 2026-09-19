import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config';
import { logger } from '../logger';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

let sqlite: Database.Database | null = null;
let db: Db | null = null;

function resolveMigrationsDir(): string {
  // Works both from src (tsx) and from dist (tsup bundle) — drizzle/ lives at package root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../drizzle'),
    path.resolve(here, '../drizzle'),
    path.resolve(process.cwd(), 'drizzle'),
    path.resolve(process.cwd(), 'packages/server/drizzle'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'meta', '_journal.json'))) return c;
  }
  throw new Error(`Cannot locate drizzle migrations folder. Tried: ${candidates.join(', ')}`);
}

export function openDb(filePath?: string): Db {
  if (db) return db;
  const file = filePath ?? path.join(config.dataDir, 'mail.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('temp_store = MEMORY');

  db = drizzle(sqlite, { schema });
  const migrationsFolder = resolveMigrationsDir();
  migrate(db, { migrationsFolder });
  logger.info({ file, migrationsFolder }, 'database ready');
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('Database not opened. Call openDb() first.');
  return db;
}

export function rawDb(): Database.Database {
  if (!sqlite) throw new Error('Database not opened.');
  return sqlite;
}

export function closeDb(): void {
  if (sqlite) {
    try {
      sqlite.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    sqlite.close();
  }
  sqlite = null;
  db = null;
}

export { schema };
