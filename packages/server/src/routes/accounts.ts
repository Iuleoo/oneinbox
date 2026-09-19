import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ACCOUNT_COLORS,
  accountCreateSchema,
  accountConnectionSchema,
  accountPatchSchema,
  type Account,
  type AccountTestResult,
  type AccountColor,
  type AccountStatus,
  type FolderInfo,
} from '@inbox/shared';
import { getDb, schema } from '../db';
import type { AccountRow } from '../db/schema';
import { getCipher } from '../crypto';
import { AppError, notFound } from '../errors';
import { getProvider, inferImapHost } from '../providers';
import { testImapConnection } from '../sync/ImapClient';
import { syncManager } from '../sync/SyncManager';
import { startAuthorization } from '../oauth';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const SPECIAL_ORDER = ['\\Inbox', '\\Sent', '\\Drafts', '\\Junk', '\\Trash', '\\Archive'];

function foldersByAccount(): Map<number, FolderInfo[]> {
  const rows = getDb().select().from(schema.folders).orderBy(schema.folders.path).all();
  const out = new Map<number, FolderInfo[]>();
  for (const f of rows) {
    const depth = f.delimiter ? f.path.split(f.delimiter).length - 1 : 0;
    const list = out.get(f.accountId) ?? [];
    list.push({ id: f.id, path: f.path, name: f.displayName, specialUse: f.specialUse, depth, subscribed: f.subscribed === 1, totalCount: f.totalCount, unreadCount: f.unreadCount });
    out.set(f.accountId, list);
  }
  for (const list of out.values()) {
    list.sort((x, y) => {
      const ix = x.specialUse ? SPECIAL_ORDER.indexOf(x.specialUse) : -1;
      const iy = y.specialUse ? SPECIAL_ORDER.indexOf(y.specialUse) : -1;
      if (ix !== -1 || iy !== -1) return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy);
      return x.path.localeCompare(y.path, 'zh');
    });
  }
  return out;
}

function toAccount(row: AccountRow, unreadCount: number, folders: FolderInfo[] = []): Account {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    provider: row.provider as Account['provider'],
    color: row.color as AccountColor,
    authType: row.authType as Account['authType'],
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    imapTls: row.imapTls === 1,
    enabled: row.enabled === 1,
    syncDays: row.syncDays,
    status: (row.enabled === 1 ? row.status : 'disabled') as AccountStatus,
    lastSyncAt: row.lastSyncAt,
    lastError: row.lastError,
    unreadCount,
    folders,
  };
}

/** Unread count per account, INBOX only (what the sidebar badge shows). */
function unreadByAccount(): Map<number, number> {
  const rows = getDb()
    .select({ accountId: schema.messages.accountId, n: sql<number>`count(*)` })
    .from(schema.messages)
    .innerJoin(schema.folders, eq(schema.folders.id, schema.messages.folderId))
    .where(and(eq(schema.messages.seen, 0), eq(schema.messages.deleted, 0), eq(schema.folders.specialUse, '\\Inbox')))
    .groupBy(schema.messages.accountId)
    .all();
  return new Map(rows.map((r) => [r.accountId, r.n]));
}

function pickColor(): AccountColor {
  const used = getDb().select({ color: schema.accounts.color }).from(schema.accounts).all().map((r) => r.color);
  for (const c of ACCOUNT_COLORS) if (!used.includes(c)) return c;
  return ACCOUNT_COLORS[used.length % ACCOUNT_COLORS.length]!;
}

export async function accountRoutes(app: FastifyInstance) {
  app.get('/accounts', async (): Promise<Account[]> => {
    const unread = unreadByAccount();
    const folders = foldersByAccount();
    return getDb()
      .select()
      .from(schema.accounts)
      .orderBy(schema.accounts.createdAt)
      .all()
      .map((r) => toAccount(r, unread.get(r.id) ?? 0, folders.get(r.id) ?? []));
  });

  app.post('/accounts/test', async (req): Promise<AccountTestResult> => {
    const body = accountConnectionSchema.parse(req.body);
    if (body.authType !== 'password') throw new AppError('VALIDATION', 'OAuth2 账户请通过授权流程添加');
    const preset = getProvider(body.provider);
    const host = body.imapHost || inferImapHost(body.provider, body.email);
    const res = await testImapConnection({
      host,
      port: body.imapPort,
      tls: body.imapTls,
      allowInsecureTls: body.allowInsecureTls,
      user: body.email,
      pass: body.secret,
      preset,
    });
    return { ok: true, ...res };
  });

  app.post('/accounts', async (req, reply): Promise<Account> => {
    const body = accountCreateSchema.parse(req.body);
    if (body.authType !== 'password') throw new AppError('VALIDATION', 'OAuth2 账户请通过授权流程添加');
    const preset = getProvider(body.provider);
    if (!preset.authTypes.includes('password')) {
      throw new AppError('VALIDATION', `${preset.label} 不支持密码登录，请使用授权登录`);
    }

    const db = getDb();
    const dup = db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.email, body.email)).get();
    if (dup) throw new AppError('CONFLICT', '该邮箱已添加');

    const host = body.imapHost || inferImapHost(body.provider, body.email);
    // Verify before saving so users never end up with a broken account.
    await testImapConnection({
      host,
      port: body.imapPort,
      tls: body.imapTls,
      allowInsecureTls: body.allowInsecureTls,
      user: body.email,
      pass: body.secret,
      preset,
    });

    const enc = getCipher().encrypt(body.secret);
    const now = Date.now();
    const res = db
      .insert(schema.accounts)
      .values({
        name: body.name,
        email: body.email,
        provider: body.provider,
        color: body.color ?? pickColor(),
        imapHost: host,
        imapPort: body.imapPort,
        imapTls: body.imapTls ? 1 : 0,
        allowInsecureTls: body.allowInsecureTls ? 1 : 0,
        authType: 'password',
        secretEnc: enc.enc,
        secretIv: enc.iv,
        secretTag: enc.tag,
        enabled: 1,
        syncDays: body.syncDays,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const id = Number(res.lastInsertRowid);
    syncManager.startAccount(id);

    const row = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get()!;
    reply.code(201);
    return toAccount(row, 0);
  });

  app.patch('/accounts/:id', async (req): Promise<Account> => {
    const { id } = idParam.parse(req.params);
    const body = accountPatchSchema.parse(req.body);
    const db = getDb();
    const row = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    if (!row) throw notFound('Account');

    const patch: Partial<typeof schema.accounts.$inferInsert> = { updatedAt: Date.now() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.color !== undefined) patch.color = body.color;
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
    if (body.syncDays !== undefined) patch.syncDays = body.syncDays;
    if (body.secret !== undefined) {
      const enc = getCipher().encrypt(body.secret);
      patch.secretEnc = enc.enc;
      patch.secretIv = enc.iv;
      patch.secretTag = enc.tag;
      patch.status = 'idle';
      patch.lastError = null;
    }
    db.update(schema.accounts).set(patch).where(eq(schema.accounts.id, id)).run();

    const needsRestart = body.secret !== undefined || body.enabled !== undefined;
    if (needsRestart) await syncManager.restartAccount(id);

    const updated = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get()!;
    return toAccount(updated, unreadByAccount().get(id) ?? 0, foldersByAccount().get(id) ?? []);
  });

  app.delete('/accounts/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const db = getDb();
    const row = db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    if (!row) throw notFound('Account');
    await syncManager.stopAccount(id);
    db.delete(schema.accounts).where(eq(schema.accounts.id, id)).run(); // cascades
    reply.code(204);
    return null;
  });

  app.post('/accounts/:id/sync', async (req) => {
    const { id } = idParam.parse(req.params);
    const row = getDb().select({ enabled: schema.accounts.enabled }).from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    if (!row) throw notFound('Account');
    if (row.enabled !== 1) throw new AppError('CONFLICT', '账户已禁用');
    const ok = syncManager.requestSync(id);
    if (!ok) syncManager.startAccount(id);
    return { ok: true };
  });

  app.post('/accounts/:id/reauth', async (req) => {
    const { id } = idParam.parse(req.params);
    const row = getDb().select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    if (!row) throw notFound('Account');
    if (row.authType !== 'oauth2') throw new AppError('VALIDATION', '该账户不是 OAuth 账户');
    const provider = row.provider === 'gmail' ? 'google' : 'microsoft';
    return startAuthorization(provider, { accountId: id });
  });

  app.post('/accounts/:id/resync', async (req) => {
    const { id } = idParam.parse(req.params);
    const db = getDb();
    const row = db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    if (!row) throw notFound('Account');
    await syncManager.stopAccount(id);
    db.delete(schema.messages).where(eq(schema.messages.accountId, id)).run();
    db.update(schema.folders)
      .set({ uidvalidity: null, uidnext: null, highestModseq: null, totalCount: 0, unreadCount: 0, lastSyncAt: null })
      .where(eq(schema.folders.accountId, id))
      .run();
    syncManager.startAccount(id);
    return { ok: true };
  });
}
