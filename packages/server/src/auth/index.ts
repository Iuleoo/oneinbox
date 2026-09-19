import crypto from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, gt, lt } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';

const ARGON_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

export const SESSION_COOKIE = 'inbox_session';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function userCount(): number {
  const db = getDb();
  return db.select({ id: schema.appUser.id }).from(schema.appUser).all().length;
}

export async function createUser(username: string, password: string): Promise<number> {
  const db = getDb();
  const passwordHash = await hashPassword(password);
  const res = db
    .insert(schema.appUser)
    .values({ username, passwordHash, createdAt: Date.now() })
    .run();
  return Number(res.lastInsertRowid);
}

export async function authenticate(
  username: string,
  password: string,
): Promise<{ id: number; username: string } | null> {
  const db = getDb();
  const user = db.select().from(schema.appUser).where(eq(schema.appUser.username, username)).get();
  if (!user) {
    // Constant-ish time: still run a hash verify to avoid trivially leaking user existence.
    await argon2.verify(
      '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      password,
    ).catch(() => false);
    return null;
  }
  const ok = await verifyPassword(user.passwordHash, password);
  return ok ? { id: user.id, username: user.username } : null;
}

export function createSession(userId: number): { token: string; expiresAt: number } {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + config.sessionTtlMs;
  db.insert(schema.sessions).values({ token, userId, expiresAt, createdAt: now }).run();
  return { token, expiresAt };
}

export function resolveSession(token: string): { userId: number; username: string } | null {
  const db = getDb();
  const row = db
    .select({ userId: schema.sessions.userId, username: schema.appUser.username })
    .from(schema.sessions)
    .innerJoin(schema.appUser, eq(schema.appUser.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.token, token), gt(schema.sessions.expiresAt, Date.now())))
    .get();
  return row ?? null;
}

export function destroySession(token: string): void {
  getDb().delete(schema.sessions).where(eq(schema.sessions.token, token)).run();
}

export function purgeExpiredSessions(): number {
  const res = getDb().delete(schema.sessions).where(lt(schema.sessions.expiresAt, Date.now())).run();
  return res.changes;
}

/** Ensure an initial user exists when INIT_USERNAME/INIT_PASSWORD are provided. */
export async function ensureInitialUser(): Promise<'created' | 'exists' | 'skipped'> {
  if (userCount() > 0) return 'exists';
  if (!config.INIT_USERNAME || !config.INIT_PASSWORD) return 'skipped';
  await createUser(config.INIT_USERNAME, config.INIT_PASSWORD);
  return 'created';
}
