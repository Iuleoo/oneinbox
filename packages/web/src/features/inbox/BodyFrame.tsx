import { useEffect, useMemo, useRef, useState } from 'react';
import { isDark, useUi } from '@/lib/store';

/**
 * Renders sanitised email HTML inside a sandboxed iframe so that email CSS cannot leak
 * into the app. Height follows content. Remote images are only loaded when allowed
 * (server moved them to data-src).
 */
export function BodyFrame({ html, text, showRemoteImages }: { html: string | null; text: string | null; showRemoteImages: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const theme = useUi((s) => s.theme);
  const dark = useMemo(() => isDark(), [theme]);

  const srcDoc = useMemo(() => {
    const fg = dark ? 'oklch(93% 0.005 260)' : 'oklch(20% 0.02 260)';
    const link = dark ? 'oklch(68% 0.17 255)' : 'oklch(55% 0.19 255)';
    const inner = html ?? (text ? `<pre style="white-space:pre-wrap;font:inherit;margin:0">${escapeHtml(text)}</pre>` : '<p style="color:#888">（无正文）</p>');
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' https: http: data: cid:; style-src 'unsafe-inline'; font-src https: data:;">
<base target="_blank">
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  html, body { margin:0; padding:0; background: transparent; }
  body { font: 15px/1.6 'Inter Variable', Inter, -apple-system, 'PingFang SC', 'Microsoft YaHei UI', system-ui, sans-serif; color:${fg}; word-break: break-word; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  img[data-src]:not([src]) { opacity: 0; }
  #__wrap { transform-origin: 0 0; }
  a { color: ${link}; }
  table { max-width: 100% !important; }
  pre { white-space: pre-wrap; }
  blockquote { border-left: 3px solid #ccc; margin: 0.5em 0; padding-left: 1em; color: #777; }
  ${dark ? 'body.invert-mode { filter: invert(0.92) hue-rotate(180deg); background:#fff; } body.invert-mode img { filter: invert(1) hue-rotate(180deg); }' : ''}
</style></head><body><div id="__wrap">${inner}</div></body></html>`;
  }, [html, text, dark]);

  // Resize + remote image toggle via same-origin DOM access (srcdoc inherits origin).
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro: ResizeObserver | null = null;
    let cleanupWin: (() => void) | null = null;
    const apply = () => {
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      doc.querySelectorAll<HTMLElement>('[data-src]').forEach((el) => {
        const url = el.getAttribute('data-src');
        if (!url) return;
        if (showRemoteImages) {
          if (el.tagName === 'IMG') el.setAttribute('src', url);
        } else if (el.tagName === 'IMG') {
          el.removeAttribute('src');
        }
      });
      // Dark mode: emails that force a white background get an inversion pass.
      if (dark && html) {
        const bg = getComputedStyle(doc.body).backgroundColor;
        const forcesLight = /rgb\(2[3-5]\d, 2[3-5]\d, 2[3-5]\d\)/.test(bg) || /bgcolor=["']?#?(fff|ffffff|white)/i.test(html) || /background(-color)?:\s*#?(fff|ffffff|white)/i.test(html);
        doc.body.classList.toggle('invert-mode', forcesLight);
      }
      fit(doc);
    };
    const fit = (doc: Document) => {
      const wrap = doc.getElementById('__wrap');
      if (!wrap) return;
      wrap.style.transform = '';
      wrap.style.width = '';
      const avail = frame.clientWidth;
      const natural = wrap.scrollWidth;
      let scale = 1;
      if (natural > avail + 2) {
        scale = avail / natural;
        wrap.style.width = `${natural}px`;
        wrap.style.transform = `scale(${scale})`;
      }
      const h = wrap.scrollHeight * scale;
      setHeight(Math.min(20000, Math.ceil(h) + 8));
    };
    const onLoad = () => {
      apply();
      const doc = frame.contentDocument;
      if (doc?.body && 'ResizeObserver' in window) {
        ro = new ResizeObserver(() => fit(doc));
        ro.observe(doc.body);
        const onWin = () => fit(doc);
        window.addEventListener('resize', onWin);
        cleanupWin = () => window.removeEventListener('resize', onWin);
      }
      doc?.querySelectorAll('img').forEach((img) => img.addEventListener('load', apply));
    };
    frame.addEventListener('load', onLoad);
    if (frame.contentDocument?.readyState === 'complete' && frame.contentDocument.body) onLoad();
    return () => {
      frame.removeEventListener('load', onLoad);
      ro?.disconnect();
      cleanupWin?.();
    };
  }, [srcDoc, showRemoteImages, dark, html]);

  return (
    <iframe
      ref={ref}
      title="邮件正文"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      style={{ height, width: '100%', border: 0, display: 'block', colorScheme: dark ? 'dark' : 'light' }}
    />
  );
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(https?:\/\/[^\s<>"']+)/g, (m) => `<a href="${m}">${m}</a>`);
}
