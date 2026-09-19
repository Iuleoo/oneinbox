import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  messageBatchSchema,
  messageListQuerySchema,
  messagePatchSchema,
  type MessageBatchResult,
  type AccountColor,
  type MessageBody,
  type MessageDetail,
  type MessageList,
  type MessageSummary,
} from '@inbox/shared';
import { getDb, schema } from '../db';
import { AppError, notFound } from '../errors';
import { events } from '../events';
import { getMessageBody } from '../sync/BodyService';
import { contentDisposition, findPart } from '../sync/mime';
import { syncManager } from '../sync/SyncManager';
import { updateFolderCounts } from '../sync/MessageStore';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const attParam = z.object({ id: z.coerce.number().int().positive(), attId: z.coerce.number().int().positive() });
const partParam = z.object({ id: z.coerce.number().int().positive(), partId: z.string().min(1).max(32) });

// ─────────────────────────── cursor ───────────────────────────

function encodeCursor(date: number, id: number): string {
  return Buffer.from(`${date}:${id}`).toString('base64url');
}
function decodeCursor(c: string | undefined): { date: number; id: number } | null {
  if (!c) return null;
  const [d, i] = Buffer.from(c, 'base64url').toString().split(':');
  const date = Number(d);
  const id = Number(i);
  if (!Number.isFinite(date) || !Number.isFinite(id)) throw new AppError('VALIDATION', 'bad cursor');
  return { date, id };
}

// ─────────────────────────── mappers ───────────────────────────

type SummaryRow = {
  id: number;
  accountId: number;
  accountColor: string;
  fromName: string | null;
  fromAddr: string | null;
  subject: string | null;
  snippet: string | null;
  internalDate: number;
  seen: number;
  flagged: number;
  answered: number;
  hasAttachments: number;
  threadId: string | null;
};

const summaryCols = {
  id: schema.messages.id,
  accountId: schema.messages.accountId,
  accountColor: schema.accounts.color,
  fromName: schema.messages.fromName,
  fromAddr: schema.messages.fromAddr,
  subject: schema.messages.subject,
  snippet: schema.messages.snippet,
  internalDate: schema.messages.internalDate,
  seen: schema.messages.seen,
  flagged: schema.messages.flagged,
  answered: schema.messages.answered,
  hasAttachments: schema.messages.hasAttachments,
  threadId: schema.messages.threadId,
};

function toSummary(r: SummaryRow): MessageSummary {
  return {
    id: r.id,
    accountId: r.accountId,
    accountColor: r.accountColor as AccountColor,
    fromName: r.fromName,
    fromAddr: r.fromAddr,
    subject: r.subject,
    snippet: r.snippet,
    internalDate: r.internalDate,
    seen: r.seen === 1,
    flagged: r.flagged === 1,
    answered: r.answered === 1,
    hasAttachments: r.hasAttachments === 1,
    threadId: r.threadId,
  };
}

// ─────────────────────────── batch mutation core ───────────────────────────

type Action = 'seen' | 'unseen' | 'flag' | 'unflag' | 'delete';

/**
 * Apply an action to many messages: update local rows optimistically, queue write-back ops,
 * wake the affected workers and emit SSE events. Returns the number of rows actually changed.
 */
function applyBatch(ids: number[], action: Action): number {
  const db = getDb();
  const rows = db
    .select({ id: schema.messages.id, accountId: schema.messages.accountId, folderId: schema.messages.folderId, seen: schema.messages.seen, flagged: schema.messages.flagged, deleted: schema.messages.deleted })
    .from(schema.messages)
    .where(inArray(schema.messages.id, ids))
    .all();
  if (!rows.length) return 0;

  const now = Date.now();
  const touchedAccounts = new Set<number>();
  const touchedFolders = new Set<number>();
  const changedIds: number[] = [];
  const removedIds: number[] = [];

  db.transaction((tx) => {
    for (const row of rows) {
      if (row.deleted === 1) continue;
      let op: string | null = null;
      const patch: Partial<typeof schema.messages.$inferInsert> = {};
      switch (action) {
        case 'seen':
          if (row.seen === 0) { patch.seen = 1; op = 'set_seen'; }
          break;
        case 'unseen':
          if (row.seen === 1) { patch.seen = 0; op = 'unset_seen'; }
          break;
        case 'flag':
          if (row.flagged === 0) { patch.flagged = 1; op = 'set_flagged'; }
          break;
        case 'unflag':
          if (row.flagged === 1) { patch.flagged = 0; op = 'unset_flagged'; }
          break;
        case 'delete':
          patch.deleted = 1;
          op = 'delete';
          break;
      }
      if (!op) continue;
      tx.update(schema.messages).set(patch).where(eq(schema.messages.id, row.id)).run();
      const opposite = op === 'delete' ? null : op.startsWith('set_') ? 'unset_' + op.slice(4) : 'set_' + op.slice(6);
      if (opposite) tx.delete(schema.pendingOps).where(and(eq(schema.pendingOps.messageId, row.id), eq(schema.pendingOps.op, opposite))).run();
      tx.insert(schema.pendingOps).values({ accountId: row.accountId, messageId: row.id, op, createdAt: now }).run();
      touchedAccounts.add(row.accountId);
      touchedFolders.add(row.folderId);
      (op === 'delete' ? removedIds : changedIds).push(row.id);
    }
  });

  for (const f of touchedFolders) updateFolderCounts(f);
  for (const a of touchedAccounts) {
    syncManager.requestSync(a);
    if (changedIds.length) events.emit('message:flags', { accountId: a, ids: changedIds });
    if (removedIds.length) events.emit('message:removed', { accountId: a, ids: removedIds });
  }
  return changedIds.length + removedIds.length;
}

// ─────────────────────────── routes ───────────────────────────

export async function messageRoutes(app: FastifyInstance) {
  app.get('/messages', async (req): Promise<MessageList> => {
    const q = messageListQuerySchema.parse(req.query);
    const db = getDb();
    const cursor = decodeCursor(q.cursor);

    const conds: SQL[] = [eq(schema.messages.deleted, 0), eq(schema.accounts.enabled, 1)];
    if (q.scope.startsWith('folder:')) conds.push(eq(schema.messages.folderId, Number(q.scope.slice(7))));
    else {
      conds.push(eq(schema.folders.specialUse, '\\Inbox'));
      if (q.scope.startsWith('account:')) conds.push(eq(schema.messages.accountId, Number(q.scope.slice(8))));
    }
    if (q.unread) conds.push(eq(schema.messages.seen, 0));
    if (cursor) {
      conds.push(
        or(
          lt(schema.messages.internalDate, cursor.date),
          and(eq(schema.messages.internalDate, cursor.date), lt(schema.messages.id, cursor.id)),
        )!,
      );
    }

    const rows = db
      .select(summaryCols)
      .from(schema.messages)
      .innerJoin(schema.folders, eq(schema.folders.id, schema.messages.folderId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.messages.accountId))
      .where(and(...conds))
      .orderBy(desc(schema.messages.internalDate), desc(schema.messages.id))
      .limit(q.limit + 1)
      .all();

    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(toSummary),
      nextCursor: hasMore && last ? encodeCursor(last.internalDate, last.id) : null,
    };
  });

  app.get('/messages/:id', async (req): Promise<MessageDetail> => {
    const { id } = idParam.parse(req.params);
    const db = getDb();
    const r = db
      .select({
        ...summaryCols,
        toJson: schema.messages.toJson,
        ccJson: schema.messages.ccJson,
        replyToAddr: schema.messages.replyToAddr,
        date: schema.messages.date,
        size: schema.messages.size,
        messageId: schema.messages.messageId,
        bodyState: schema.messages.bodyState,
      })
      .from(schema.messages)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.messages.accountId))
      .where(eq(schema.messages.id, id))
      .get();
    if (!r) throw notFound('Message');

    const atts = db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.messageId, id))
      .orderBy(schema.attachments.id)
      .all();

    let threadCount = 1;
    if (r.threadId) {
      const t = db
        .select({ n: sql<number>`count(*)` })
        .from(schema.messages)
        .where(and(eq(schema.messages.accountId, r.accountId), eq(schema.messages.threadId, r.threadId), eq(schema.messages.deleted, 0)))
        .get();
      threadCount = t?.n ?? 1;
    }

    return {
      ...toSummary(r),
      to: JSON.parse(r.toJson),
      cc: JSON.parse(r.ccJson),
      replyTo: r.replyToAddr,
      date: r.date,
      size: r.size,
      messageId: r.messageId,
      bodyState: r.bodyState as MessageDetail['bodyState'],
      attachments: atts.map((a) => ({
        id: a.id,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
        isInline: a.isInline === 1,
      })),
      threadCount,
    };
  });

  app.get('/messages/:id/body', async (req): Promise<MessageBody> => {
    const { id } = idParam.parse(req.params);
    return getMessageBody(id);
  });

  app.patch('/messages/:id', async (req): Promise<MessageSummary> => {
    const { id } = idParam.parse(req.params);
    const body = messagePatchSchema.parse(req.body);
    const db = getDb();
    const row = db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
    if (!row) throw notFound('Message');

    const now = Date.now();
    db.transaction((tx) => {
      const patch: Partial<typeof schema.messages.$inferInsert> = {};
      const ops: string[] = [];
      if (body.seen !== undefined && (row.seen === 1) !== body.seen) {
        patch.seen = body.seen ? 1 : 0;
        ops.push(body.seen ? 'set_seen' : 'unset_seen');
      }
      if (body.flagged !== undefined && (row.flagged === 1) !== body.flagged) {
        patch.flagged = body.flagged ? 1 : 0;
        ops.push(body.flagged ? 'set_flagged' : 'unset_flagged');
      }
      if (!ops.length) return;
      tx.update(schema.messages).set(patch).where(eq(schema.messages.id, id)).run();
      // Collapse opposite pending ops for the same message (e.g. set_seen then unset_seen).
      const opposites = ops.map((o) => (o.startsWith('set_') ? 'unset_' + o.slice(4) : 'set_' + o.slice(6)));
      tx.delete(schema.pendingOps)
        .where(and(eq(schema.pendingOps.messageId, id), inArray(schema.pendingOps.op, opposites)))
        .run();
      tx.insert(schema.pendingOps)
        .values(ops.map((op) => ({ accountId: row.accountId, messageId: id, op, createdAt: now })))
        .run();
    });

    if (body.seen !== undefined) updateFolderCounts(row.folderId);
    syncManager.requestSync(row.accountId); // wakes the worker → flushPendingOps
    events.emit('message:flags', { accountId: row.accountId, ids: [id] });

    const updated = db
      .select(summaryCols)
      .from(schema.messages)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.messages.accountId))
      .where(eq(schema.messages.id, id))
      .get()!;
    return toSummary(updated);
  });

  app.delete('/messages/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = applyBatch([id], 'delete');
    if (!n) throw notFound('Message');
    reply.code(204);
    return null;
  });

  app.post('/messages/batch', async (req): Promise<MessageBatchResult> => {
    const body = messageBatchSchema.parse(req.body);
    return { ok: true, affected: applyBatch(body.ids, body.action) };
  });

  // ── attachments & inline parts ──

  const streamPart = async (
    messageId: number,
    partId: string,
    disposition: 'attachment' | 'inline',
    fallbackName: string | null,
    fallbackType: string | null,
    reply: import('fastify').FastifyReply,
  ) => {
    const db = getDb();
    const row = db
      .select({ uid: schema.messages.uid, accountId: schema.messages.accountId, folderId: schema.messages.folderId, size: schema.messages.size })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .get();
    if (!row) throw notFound('Message');
    const folder = db.select({ path: schema.folders.path }).from(schema.folders).where(eq(schema.folders.id, row.folderId)).get();
    if (!folder) throw notFound('Folder');
    const worker = syncManager.getWorker(row.accountId);
    if (!worker) throw new AppError('NETWORK', '该账户未在同步，无法下载附件');

    const dl = await worker.withConnection(folder.path, async (client) => {
      const d = await client.download(String(row.uid), partId, { uid: true });
      if (!d || !d.content) throw notFound('Attachment part');
      return d;
    });

    const type = dl.meta.contentType || fallbackType || 'application/octet-stream';
    const name = dl.meta.filename || fallbackName;
    reply
      .header('Content-Type', type)
      .header('Content-Disposition', contentDisposition(disposition, name))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=86400');
    // No Content-Length: imapflow's expectedSize is the transfer-encoded size, not the decoded byte count.
    return reply.send(dl.content);
  };

  app.get('/messages/:id/attachments/:attId', async (req, reply) => {
    const { id, attId } = attParam.parse(req.params);
    const inline = (req.query as { inline?: string }).inline === '1';
    const att = getDb().select().from(schema.attachments).where(and(eq(schema.attachments.id, attId), eq(schema.attachments.messageId, id))).get();
    if (!att) throw notFound('Attachment');
    return streamPart(id, att.partId, inline ? 'inline' : 'attachment', att.filename, att.contentType, reply);
  });

  app.get('/messages/:id/parts/:partId', async (req, reply) => {
    const { id, partId } = partParam.parse(req.params);
    if (!/^[0-9.]+$/.test(partId)) throw new AppError('VALIDATION', 'bad part id');
    const att = getDb().select().from(schema.attachments).where(and(eq(schema.attachments.messageId, id), eq(schema.attachments.partId, partId))).get();
    // Only serve parts we know are image-ish inline parts, to avoid turning this into a generic proxy.
    if (!att || !(att.contentType ?? '').startsWith('image/')) throw notFound('Part');
    return streamPart(id, partId, 'inline', att.filename, att.contentType, reply);
  });
}

// keep findPart referenced for future part-type validation
void findPart;
