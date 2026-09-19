import type { FastifyInstance } from 'fastify';
import { eq, ne, and } from 'drizzle-orm';
import { passwordChangeSchema, settingsPatchSchema, settingsSchema, type Settings } from '@inbox/shared';
import { getDb, schema } from '../db';
import { AppError, unauthorized } from '../errors';
import { SESSION_COOKIE, hashPassword, verifyPassword } from '../auth';

/** Read all settings, applying schema defaults for missing keys. */
export function readSettings(): Settings {
  const rows = getDb().select().from(schema.settings).all();
  const raw: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      raw[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore corrupt value */
    }
  }
  // Validate per key so one corrupt value does not wipe every other setting.
  const defaults = settingsSchema.parse({});
  const out: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(settingsSchema.shape) as (keyof Settings)[]) {
    if (raw[key] === undefined) continue;
    const r = settingsSchema.shape[key].safeParse(raw[key]);
    if (r.success) out[key] = r.data;
  }
  return out as Settings;
}

export function writeSettings(patch: Partial<Settings>): Settings {
  const db = getDb();
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      tx.insert(schema.settings)
        .values({ key, value: JSON.stringify(value) })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value) } })
        .run();
    }
  });
  return readSettings();
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', async (): Promise<Settings> => readSettings());

  app.patch('/settings', async (req): Promise<Settings> => {
    const patch = settingsPatchSchema.parse(req.body);
    return writeSettings(patch);
  });

  app.post(
    '/auth/password',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      if (!req.user) throw unauthorized();
      const body = passwordChangeSchema.parse(req.body);
      const db = getDb();
      const user = db.select().from(schema.appUser).where(eq(schema.appUser.id, req.user.userId)).get();
      if (!user) throw unauthorized();
      if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
        // Not UNAUTHORIZED: a 401 would make the client treat the session as expired and bounce to /login.
        throw new AppError('VALIDATION', '当前密码不正确');
      }
      if (body.currentPassword === body.newPassword) throw new AppError('VALIDATION', '新密码不能与当前密码相同');
      const passwordHash = await hashPassword(body.newPassword);
      const current = req.cookies[SESSION_COOKIE] ?? '';
      db.transaction((tx) => {
        tx.update(schema.appUser).set({ passwordHash }).where(eq(schema.appUser.id, user.id)).run();
        // Log out every other device; keep this session.
        tx.delete(schema.sessions).where(and(eq(schema.sessions.userId, user.id), ne(schema.sessions.token, current))).run();
      });
      return { ok: true };
    },
  );
}
