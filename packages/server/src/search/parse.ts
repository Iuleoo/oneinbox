import type { ParsedFilters } from '@inbox/shared';

/**
 * Parse a user search string into structured filters plus free text.
 *   from:alice has:attachment is:unread is:starred account:QQ 发票
 * Quoted values are supported: from:"Epic Games".
 */
export function parseSearch(input: string): ParsedFilters {
  const out: ParsedFilters = { text: '' };
  const rest: string[] = [];
  const re = /(\w+):("([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m[1]) {
      const key = m[1].toLowerCase();
      const val = (m[3] ?? m[4] ?? '').trim();
      switch (key) {
        case 'from':
          out.from = val.toLowerCase();
          continue;
        case 'has':
          if (val.toLowerCase() === 'attachment' || val === '附件') out.hasAttachment = true;
          continue;
        case 'is':
          if (val.toLowerCase() === 'unread' || val === '未读') out.unread = true;
          else if (val.toLowerCase() === 'starred' || val.toLowerCase() === 'flagged' || val === '星标') out.starred = true;
          continue;
        case 'account':
          out.account = val;
          continue;
        case 'in':
        case 'folder':
          out.folder = val;
          continue;
        default:
          rest.push(m[0]);
          continue;
      }
    }
    rest.push(m[5] ?? m[6] ?? '');
  }
  out.text = rest.filter(Boolean).join(' ').trim();
  return out;
}

/**
 * Build an FTS5 MATCH expression for the trigram tokenizer. Each whitespace-separated term
 * becomes a quoted phrase; terms are ANDed. Returns null when no term is long enough for
 * trigram matching (< 3 chars), in which case the caller should fall back to LIKE.
 */
export function buildFtsMatch(text: string): string | null {
  const terms = text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => [...t].length >= 3);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}
