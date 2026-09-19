import iconv from 'iconv-lite';
import type { MessageStructureObject } from 'imapflow';

/** Normalise charset labels seen in the wild to something iconv-lite understands. */
function normaliseCharset(cs: string | undefined): string {
  const c = (cs ?? 'utf-8').toLowerCase().replace(/^"|"$/g, '').trim();
  if (c === 'gb2312' || c === 'gbk' || c === 'gb_2312' || c === 'gb-2312') return 'gb18030';
  if (c === 'ks_c_5601-1987') return 'cp949';
  if (c === 'us-ascii' || c === 'ascii' || c === 'iso-8859-1' || c === 'latin1') return c === 'us-ascii' || c === 'ascii' ? 'utf-8' : 'latin1';
  if (c === 'unicode-1-1-utf-7' || c === 'utf7') return 'utf-7';
  return c;
}

/** Decode raw transfer-encoded bytes. */
export function decodeTransfer(buf: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? '').toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(buf.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (enc === 'quoted-printable') {
    const str = buf.toString('latin1').replace(/=\r?\n/g, '');
    const out: number[] = [];
    for (let i = 0; i < str.length; i++) {
      const ch = str[i]!;
      if (ch === '=' && i + 2 < str.length + 1) {
        const hex = str.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      out.push(ch.charCodeAt(0) & 0xff);
    }
    return Buffer.from(out);
  }
  return buf;
}

/** Decode a text body part to a JS string using the node's transfer encoding and charset. */
export function decodeTextPart(buf: Buffer, node: MessageStructureObject): string {
  const bytes = decodeTransfer(buf, node.encoding);
  const charset = normaliseCharset(node.parameters?.charset);
  try {
    if (iconv.encodingExists(charset)) return iconv.decode(bytes, charset);
  } catch {
    /* fall through */
  }
  return bytes.toString('utf8');
}

/** Find the node for a given IMAP part id inside a BODYSTRUCTURE tree. */
export function findPart(root: MessageStructureObject, partId: string): MessageStructureObject | null {
  if ((root.part ?? '1') === partId && !(root.type ?? '').toLowerCase().startsWith('multipart/')) return root;
  for (const child of root.childNodes ?? []) {
    const f = findPart(child, partId);
    if (f) return f;
  }
  return null;
}

/** RFC 5987 Content-Disposition with both ASCII fallback and UTF-8 filename*. */
export function contentDisposition(type: 'attachment' | 'inline', filename: string | null): string {
  const name = (filename && filename.trim()) || 'attachment';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Turn plain text into safe HTML with clickable links (used only for text-only messages). */
export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/(https?:\/\/[^\s<>"']+)/g, (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`);
}
