import type { FastifyInstance } from 'fastify';
import { searchQuerySchema, type AccountColor, type MessageSummary, type SearchResult } from '@inbox/shared';
import { rawDb } from '../db';
import { AppError } from '../errors';
import { buildFtsMatch, parseSearch } from '../search/parse';

/**
 * Search uses an offset cursor (results are ranked, not time-ordered, so a keyset cursor
 * would not apply). Cursor = base64url(offset).
 */
function decodeOffset(c: string | undefined): number {
  if (!c) return 0;
  const n = Number(Buffer.from(c, 'base64url').toString());
  if (!Number.isInteger(n) || n < 0) throw new AppError('VALIDATION', 'bad cursor');
  return n;
}
const encodeOffset = (n: number) => Buffer.from(String(n)).toString('base64url');

interface Row {
  id: number;
  account_id: number;
  color: string;
  from_name: string | null;
  from_addr: string | null;
  subject: string | null;
  snippet: string | null;
  internal_date: number;
  seen: number;
  flagged: number;
  answered: number;
  has_attachments: number;
  thread_id: string | null;
}

function toSummary(r: Row): MessageSummary {
  return {
    id: r.id,
    accountId: r.account_id,
    accountColor: r.color as AccountColor,
    fromName: r.from_name,
    fromAddr: r.from_addr,
    subject: r.subject,
    snippet: r.snippet,
    internalDate: r.internal_date,
    seen: r.seen === 1,
    flagged: r.flagged === 1,
    answered: r.answered === 1,
    hasAttachments: r.has_attachments === 1,
    threadId: r.thread_id,
  };
}

export async function searchRoutes(app: FastifyInstance) {
  app.get('/search', async (req): Promise<SearchResult> => {
    const q = searchQuerySchema.parse(req.query);
    const filters = parseSearch(q.q);
    const offset = decodeOffset(q.cursor);
    const db = rawDb();

    const where: string[] = ['m.deleted = 0', 'a.enabled = 1'];
    const params: unknown[] = [];

    if (q.scope.startsWith('folder:')) {
      where.push('m.folder_id = ?');
      params.push(Number(q.scope.slice(7)));
    } else if (filters.folder) {
      const alias: Record<string, string> = { inbox: '\\Inbox', 收件箱: '\\Inbox', sent: '\\Sent', 已发送: '\\Sent', drafts: '\\Drafts', 草稿: '\\Drafts', junk: '\\Junk', spam: '\\Junk', 垃圾: '\\Junk', 垃圾邮件: '\\Junk', trash: '\\Trash', deleted: '\\Trash', 已删除: '\\Trash', archive: '\\Archive', 归档: '\\Archive' };
      const su = alias[filters.folder.toLowerCase()];
      if (su) { where.push('f.special_use = ?'); params.push(su); }
      else { where.push('(f.display_name LIKE ? OR f.path LIKE ?)'); params.push(`%${filters.folder}%`, `%${filters.folder}%`); }
      if (q.scope.startsWith('account:')) { where.push('m.account_id = ?'); params.push(Number(q.scope.slice(8))); }
    } else {
      where.push("f.special_use = '\\Inbox'");
      if (q.scope.startsWith('account:')) { where.push('m.account_id = ?'); params.push(Number(q.scope.slice(8))); }
    }
    if (filters.account) {
      where.push('(a.name LIKE ? OR a.email LIKE ?)');
      params.push(`%${filters.account}%`, `%${filters.account}%`);
    }
    if (filters.from) {
      where.push('(lower(m.from_addr) LIKE ? OR lower(m.from_name) LIKE ?)');
      params.push(`%${filters.from}%`, `%${filters.from}%`);
    }
    if (filters.hasAttachment) where.push('m.has_attachments = 1');
    if (filters.unread) where.push('m.seen = 0');
    if (filters.starred) where.push('m.flagged = 1');

    const cols = `m.id, m.account_id, a.color, m.from_name, m.from_addr, m.subject, m.snippet, m.internal_date,
                  m.seen, m.flagged, m.answered, m.has_attachments, m.thread_id`;
    const joins = `JOIN folders f ON f.id = m.folder_id JOIN accounts a ON a.id = m.account_id`;

    let sql: string;
    const match = filters.text ? buildFtsMatch(filters.text) : null;
    if (match) {
      // Ranked full-text search via the external-content FTS5 table.
      sql = `SELECT ${cols} FROM messages_fts fts JOIN messages m ON m.id = fts.rowid ${joins}
             WHERE messages_fts MATCH ? AND ${where.join(' AND ')}
             ORDER BY bm25(messages_fts), m.internal_date DESC LIMIT ? OFFSET ?`;
      params.unshift(match);
    } else if (filters.text) {
      // Terms too short for trigram: substring match on the cheap columns.
      const like = `%${filters.text}%`;
      where.push('(m.subject LIKE ? OR m.from_name LIKE ? OR m.from_addr LIKE ? OR m.snippet LIKE ?)');
      params.push(like, like, like, like);
      sql = `SELECT ${cols} FROM messages m ${joins} WHERE ${where.join(' AND ')}
             ORDER BY m.internal_date DESC, m.id DESC LIMIT ? OFFSET ?`;
    } else {
      sql = `SELECT ${cols} FROM messages m ${joins} WHERE ${where.join(' AND ')}
             ORDER BY m.internal_date DESC, m.id DESC LIMIT ? OFFSET ?`;
    }
    params.push(q.limit + 1, offset);

    let rows: Row[];
    try {
      rows = db.prepare(sql).all(...params) as Row[];
    } catch (err) {
      // FTS syntax errors from odd input should not 500.
      throw new AppError('VALIDATION', `搜索语法无效：${(err as Error).message}`);
    }
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map(toSummary);
    return { items, nextCursor: hasMore ? encodeOffset(offset + q.limit) : null, parsedFilters: filters };
  });
}
