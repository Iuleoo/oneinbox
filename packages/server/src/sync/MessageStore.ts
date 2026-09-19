import { and, eq, sql } from 'drizzle-orm';
import type { FetchMessageObject, MessageStructureObject, MessageAddressObject } from 'imapflow';
import { getDb, schema } from '../db';
import type { NewAttachment, NewMessage } from '../db/schema';

export interface ParsedEnvelope {
  message: Omit<NewMessage, 'id' | 'createdAt'>;
  attachments: Omit<NewAttachment, 'id' | 'messageId'>[];
}

interface Addr {
  name: string | null;
  address: string;
}

function toAddr(a?: MessageAddressObject[] | null): Addr[] {
  if (!a) return [];
  return a
    .filter((x) => x.address)
    .map((x) => ({ name: x.name?.trim() || null, address: x.address!.toLowerCase() }));
}

function decodeSubject(s?: string | null): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t || null;
}

interface WalkResult {
  attachments: Omit<NewAttachment, 'id' | 'messageId'>[];
  textPart?: string;
  htmlPart?: string;
}

/**
 * Walk a BODYSTRUCTURE tree to find attachments and body parts.
 * Prefers the first text/plain + text/html found in a multipart/alternative.
 */
export function walkStructure(root: MessageStructureObject): WalkResult {
  const out: WalkResult = { attachments: [] };

  const visit = (node: MessageStructureObject, inAlternative: boolean) => {
    const type = (node.type ?? '').toLowerCase();
    const disposition = (node.disposition ?? '').toLowerCase();
    const filename =
      (node.dispositionParameters?.filename as string | undefined) ??
      (node.parameters?.name as string | undefined) ??
      undefined;
    const isMultipart = type.startsWith('multipart/');

    if (isMultipart) {
      const alt = inAlternative || type === 'multipart/alternative';
      for (const child of node.childNodes ?? []) visit(child, alt);
      return;
    }

    const isText = type === 'text/plain' || type === 'text/html';
    const isAttachment = disposition === 'attachment' || (!!filename && !isText);
    const isInlineImage = disposition === 'inline' && !!node.id && type.startsWith('image/');

    if (isText && !isAttachment) {
      if (type === 'text/plain' && !out.textPart) out.textPart = node.part;
      if (type === 'text/html' && !out.htmlPart) out.htmlPart = node.part;
      return;
    }

    if (node.part && type !== 'message/delivery-status') {
      out.attachments.push({
        partId: node.part,
        filename: filename ?? null,
        contentType: type || null,
        size: typeof node.size === 'number' ? node.size : null,
        contentId: node.id ? node.id.replace(/^<|>$/g, '') : null,
        isInline: isInlineImage ? 1 : 0,
      });
    }
  };

  // Single-part message: imapflow leaves `part` undefined; the body is section "1".
  const rootType = (root.type ?? '').toLowerCase();
  if (!rootType.startsWith('multipart/')) {
    if (rootType === 'text/plain') out.textPart = root.part ?? '1';
    else if (rootType === 'text/html') out.htmlPart = root.part ?? '1';
    else {
      out.attachments.push({
        partId: root.part ?? '1',
        filename: (root.dispositionParameters?.filename as string | undefined) ?? null,
        contentType: rootType || null,
        size: typeof root.size === 'number' ? root.size : null,
        contentId: null,
        isInline: 0,
      });
    }
    return out;
  }

  visit(root, false);
  return out;
}

export function parseFetchedMessage(
  accountId: number,
  folderId: number,
  msg: FetchMessageObject,
  snippet: string | null,
): ParsedEnvelope {
  const env = msg.envelope;
  const from = toAddr(env?.from)[0] ?? null;
  const to = toAddr(env?.to);
  const cc = toAddr(env?.cc);
  const replyTo = toAddr(env?.replyTo)[0]?.address ?? null;
  const flags = msg.flags ?? new Set<string>();

  const structure = msg.bodyStructure ? walkStructure(msg.bodyStructure) : { attachments: [] };
  const realAttachments = structure.attachments.filter((a) => !a.isInline);

  const internalDate = msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now();
  const date = env?.date ? new Date(env.date).getTime() : internalDate;

  const gm = (msg as unknown as { threadId?: string; emailId?: string });

  return {
    message: {
      accountId,
      folderId,
      uid: msg.uid,
      messageId: env?.messageId ? env.messageId.replace(/^<|>$/g, '') : null,
      threadId: gm.threadId ?? null,
      fromName: from?.name ?? null,
      fromAddr: from?.address ?? null,
      toJson: JSON.stringify(to),
      ccJson: JSON.stringify(cc),
      replyToAddr: replyTo,
      subject: decodeSubject(env?.subject),
      snippet,
      date: Number.isFinite(date) ? date : internalDate,
      internalDate,
      seen: flags.has('\\Seen') ? 1 : 0,
      flagged: flags.has('\\Flagged') ? 1 : 0,
      answered: flags.has('\\Answered') ? 1 : 0,
      deleted: 0,
      hasAttachments: realAttachments.length > 0 ? 1 : 0,
      size: typeof msg.size === 'number' ? msg.size : null,
      bodyParts: JSON.stringify({ text: structure.textPart, html: structure.htmlPart }),
      bodyState: 'none',
    },
    attachments: structure.attachments,
  };
}

/** Insert or update a batch of envelopes in a single transaction. Returns ids of newly inserted rows. */
export function upsertEnvelopes(batch: ParsedEnvelope[]): number[] {
  const db = getDb();
  const now = Date.now();
  const inserted: number[] = [];

  db.transaction((tx) => {
    for (const item of batch) {
      const existing = tx
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(and(eq(schema.messages.folderId, item.message.folderId), eq(schema.messages.uid, item.message.uid)))
        .get();

      if (existing) {
        tx.update(schema.messages)
          .set({
            seen: item.message.seen,
            flagged: item.message.flagged,
            answered: item.message.answered,
          })
          .where(eq(schema.messages.id, existing.id))
          .run();
        continue;
      }

      const res = tx
        .insert(schema.messages)
        .values({ ...item.message, createdAt: now })
        .run();
      const id = Number(res.lastInsertRowid);
      inserted.push(id);

      if (item.attachments.length) {
        tx.insert(schema.attachments)
          .values(item.attachments.map((a) => ({ ...a, messageId: id })))
          .run();
      }
    }
  });

  return inserted;
}

export function updateFolderCounts(folderId: number): { total: number; unread: number } {
  const db = getDb();
  const row = db
    .select({
      total: sql<number>`count(*)`,
      unread: sql<number>`sum(case when ${schema.messages.seen} = 0 then 1 else 0 end)`,
    })
    .from(schema.messages)
    .where(and(eq(schema.messages.folderId, folderId), eq(schema.messages.deleted, 0)))
    .get();
  const total = row?.total ?? 0;
  const unread = row?.unread ?? 0;
  db.update(schema.folders)
    .set({ totalCount: total, unreadCount: unread, lastSyncAt: Date.now() })
    .where(eq(schema.folders.id, folderId))
    .run();
  return { total, unread };
}

/** Build a short plain-text snippet from a raw text/plain chunk. */
export function makeSnippet(raw: string | undefined | null, max = 200): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/\r\n|\r/g, '\n')
    .replace(/^>.*$/gm, '') // quoted lines
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
