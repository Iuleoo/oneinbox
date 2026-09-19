import DOMPurify from 'isomorphic-dompurify';
import { eq } from 'drizzle-orm';
import type { MessageBody } from '@inbox/shared';
import { getDb, schema } from '../db';
import type { MessageRow } from '../db/schema';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { decodeTextPart, findPart } from './mime';
import { syncManager } from './SyncManager';

const log = logger.child({ mod: 'body' });
const inflight = new Map<number, Promise<MessageBody>>();

const REMOTE_URL = /^\s*(https?:)?\/\//i;

/** Minimal DOM element shape we touch inside DOMPurify hooks (server has no DOM lib). */
type El = { nodeName: string; setAttribute(name: string, value: string): void };

interface SanitizeResult {
  html: string;
  hasRemoteImages: boolean;
}

/**
 * Sanitise untrusted email HTML.
 *  - strips scripts, forms, iframes, event handlers, javascript: URLs
 *  - rewrites cid: references to our attachment endpoint
 *  - moves remote image URLs from src → data-src so the client decides whether to load them
 */
export function sanitizeHtml(raw: string, messageId: number, cidMap: Map<string, string>): SanitizeResult {
  let hasRemoteImages = false;

  const hook = (node: El, data: { attrName: string; attrValue: string; keepAttr: boolean }) => {
    const tag = node.nodeName.toLowerCase();
    const attr = data.attrName.toLowerCase();

    if (attr === 'src' || attr === 'poster' || attr === 'background' || (attr === 'srcset' && tag === 'img')) {
      const v = data.attrValue.trim();
      if (/^cid:/i.test(v)) {
        const cid = v.slice(4).replace(/^<|>$/g, '');
        const partId = cidMap.get(cid);
        data.attrValue = partId ? `/api/messages/${messageId}/parts/${encodeURIComponent(partId)}` : '';
        return;
      }
      if (REMOTE_URL.test(v)) {
        hasRemoteImages = true;
        node.setAttribute('data-src', v);
        data.keepAttr = false;
        return;
      }
      if (!/^data:image\//i.test(v)) {
        data.keepAttr = false;
      }
      return;
    }

    if (attr === 'style') {
      if (/url\s*\(\s*['"]?\s*(https?:)?\/\//i.test(data.attrValue)) {
        hasRemoteImages = true;
        data.attrValue = data.attrValue.replace(/url\s*\([^)]*\)/gi, 'none');
      }
      return;
    }

    if (tag === 'a' && attr === 'href') {
      if (!/^(https?:|mailto:|tel:|#)/i.test(data.attrValue.trim())) data.keepAttr = false;
    }
  };

  DOMPurify.addHook('uponSanitizeAttribute', hook as never);
  DOMPurify.addHook('afterSanitizeAttributes', ((node: El) => {
    if (node.nodeName.toLowerCase() === 'a') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }) as never);

  try {
    let html = DOMPurify.sanitize(raw, {
      WHOLE_DOCUMENT: false,
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'meta', 'link', 'base', 'video', 'audio'],
      FORBID_ATTR: ['onerror', 'onload', 'formaction', 'ping'],
      ALLOW_UNKNOWN_PROTOCOLS: false,
      ADD_ATTR: ['data-src', 'target'],
    }) as string;

    // <style> blocks: strip remote url() references too.
    html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css: string) => {
      if (/url\s*\(\s*['"]?\s*(https?:)?\/\//i.test(css)) {
        hasRemoteImages = true;
        return m.replace(css, css.replace(/url\s*\(\s*['"]?\s*(https?:)?\/\/[^)]*\)/gi, 'none'));
      }
      return m;
    });

    return { html, hasRemoteImages };
  } finally {
    DOMPurify.removeAllHooks();
  }
}

function toBody(row: MessageRow): MessageBody {
  return {
    html: row.bodyHtml,
    text: row.bodyText,
    hasRemoteImages: row.bodyHtml ? /data-src=/.test(row.bodyHtml) : false,
  };
}

/** Return the cached body, or fetch it from IMAP via the account worker, parse, sanitise and cache. */
export async function getMessageBody(messageId: number): Promise<MessageBody> {
  const db = getDb();
  const row = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!row) throw notFound('Message');
  if (row.bodyState === 'ready') return toBody(row);

  const existing = inflight.get(messageId);
  if (existing) return existing;

  const p = fetchAndStore(row).finally(() => inflight.delete(messageId));
  inflight.set(messageId, p);
  return p;
}

async function fetchAndStore(row: MessageRow): Promise<MessageBody> {
  const db = getDb();
  const worker = syncManager.getWorker(row.accountId);
  if (!worker) throw new AppError('NETWORK', '该账户未在同步，无法拉取正文');
  const folder = db.select().from(schema.folders).where(eq(schema.folders.id, row.folderId)).get();
  if (!folder) throw notFound('Folder');

  db.update(schema.messages).set({ bodyState: 'fetching' }).where(eq(schema.messages.id, row.id)).run();

  try {
    const parts = row.bodyParts ? (JSON.parse(row.bodyParts) as { text?: string; html?: string }) : {};
    const wanted = [parts.html, parts.text].filter((p): p is string => !!p);

    const result = await worker.withConnection(folder.path, async (client) => {
      const msg = await client.fetchOne(
        String(row.uid),
        { uid: true, bodyStructure: true, ...(wanted.length ? { bodyParts: wanted } : { source: true }) },
        { uid: true },
      );
      if (!msg) throw new AppError('NOT_FOUND', '邮件在服务器上已不存在');
      return msg;
    });

    let html: string | null = null;
    let text: string | null = null;
    const struct = result.bodyStructure;

    if (wanted.length && struct && result.bodyParts) {
      if (parts.html) {
        const node = findPart(struct, parts.html);
        const buf = result.bodyParts.get(parts.html);
        if (node && buf) html = decodeTextPart(buf, node);
      }
      if (parts.text) {
        const node = findPart(struct, parts.text);
        const buf = result.bodyParts.get(parts.text);
        if (node && buf) text = decodeTextPart(buf, node);
      }
    } else if (result.source) {
      // Fallback for exotic structures: parse the whole message.
      const { simpleParser } = await import('mailparser');
      const parsed = await simpleParser(result.source);
      html = typeof parsed.html === 'string' ? parsed.html : null;
      text = parsed.text ?? null;
    }

    let hasRemote = false;
    if (html) {
      const cidRows = db.select().from(schema.attachments).where(eq(schema.attachments.messageId, row.id)).all();
      const cidMap = new Map(cidRows.filter((a) => a.contentId).map((a) => [a.contentId!, a.partId]));
      const s = sanitizeHtml(html, row.id, cidMap);
      html = s.html;
      hasRemote = s.hasRemoteImages;
    }

    if (!row.snippet && text) {
      const { makeSnippet } = await import('./MessageStore');
      db.update(schema.messages).set({ snippet: makeSnippet(text) }).where(eq(schema.messages.id, row.id)).run();
    }

    db.update(schema.messages)
      .set({ bodyHtml: html, bodyText: text, bodyState: 'ready', bodyFetchedAt: Date.now() })
      .where(eq(schema.messages.id, row.id))
      .run();

    return { html, text, hasRemoteImages: hasRemote };
  } catch (err) {
    db.update(schema.messages).set({ bodyState: 'error' }).where(eq(schema.messages.id, row.id)).run();
    log.warn({ err, messageId: row.id }, 'body fetch failed');
    throw err;
  }
}
