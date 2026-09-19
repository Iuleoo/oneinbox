import { ProxyAgent, type Dispatcher } from 'undici';
import type { ProviderId } from '@inbox/shared';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Optional outbound proxy for providers that are unreachable from the server's network
 * (typically Google from mainland China). Configured via PROXY_URL + PROXY_FOR.
 * Applies to both HTTPS calls (OAuth token / userinfo) and IMAP connections.
 */

const proxied = new Set(
  (config.PROXY_FOR ?? 'gmail')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export function proxyUrlFor(provider: ProviderId): string | undefined {
  if (!config.PROXY_URL) return undefined;
  return proxied.has(provider) ? config.PROXY_URL : undefined;
}

let agent: Dispatcher | null = null;
function dispatcher(): Dispatcher | undefined {
  if (!config.PROXY_URL) return undefined;
  if (!agent) {
    // undici's ProxyAgent handles http(s):// proxies. socks:// is only supported for IMAP (imapflow).
    if (!/^https?:\/\//i.test(config.PROXY_URL)) {
      logger.warn({ proxy: config.PROXY_URL }, 'PROXY_URL is not http(s); HTTPS calls (OAuth) will go direct. Use an http proxy for full coverage.');
      return undefined;
    }
    agent = new ProxyAgent({ uri: config.PROXY_URL, connectTimeout: 20_000 });
    logger.info({ proxy: config.PROXY_URL.replace(/\/\/.*@/, '//***@'), providers: [...proxied] }, 'outbound proxy enabled');
  }
  return agent;
}

/** fetch() that goes through the proxy when the target provider is in PROXY_FOR. */
export function fetchFor(provider: ProviderId, url: string, init: RequestInit = {}): Promise<Response> {
  const d = proxyUrlFor(provider) ? dispatcher() : undefined;
  return fetch(url, d ? ({ ...init, dispatcher: d } as RequestInit) : init);
}
