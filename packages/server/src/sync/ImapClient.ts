import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { ErrorCode } from '@inbox/shared';
import { AppError } from '../errors';
import { CLIENT_INFO, type ProviderPreset } from '../providers';
import { logger, type Logger } from '../logger';
import { proxyUrlFor } from '../net/proxy';

export interface ImapConnectionParams {
  host: string;
  port: number;
  tls: boolean;
  allowInsecureTls?: boolean;
  user: string;
  /** Password / auth code (auth_type = password). */
  pass?: string;
  /** OAuth2 access token (auth_type = oauth2). */
  accessToken?: string;
  preset: ProviderPreset;
  /** Used for log context. */
  accountId?: number;
}

export type ImapErrorKind = Extract<ErrorCode, 'AUTH_FAILED' | 'NETWORK' | 'THROTTLED' | 'INTERNAL'>;

export class ImapError extends AppError {
  readonly kind: ImapErrorKind;
  constructor(kind: ImapErrorKind, message: string, cause?: unknown) {
    super(kind, message, { cause });
    this.name = 'ImapError';
    this.kind = kind;
  }
}

const AUTH_PATTERNS = [
  /authenticat/i,
  /login (failed|error|incorrect)/i,
  /invalid credentials/i,
  /\[AUTHENTICATIONFAILED\]/i,
  /\[AUTHORIZATIONFAILED\]/i,
  /LOGIN Login error/i,
  /password/i,
  /invalid_grant/i,
  /AUTHENTICATE failed/i,
];
const THROTTLE_PATTERNS = [
  /\[THROTTLED\]/i,
  /too many (simultaneous )?connections/i,
  /rate limit/i,
  /Unsafe Login/i, // NetEase without ID command – treated as retryable after fix
  /\[UNAVAILABLE\]/i,
  /connection limit/i,
];
const NETWORK_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /EPIPE/i,
  /socket hang up/i,
  /timeout/i,
  /Connection (closed|not available)/i,
  /certificate/i,
  /self.signed/i,
  /TLS/,
];

export function classifyImapError(err: unknown, preset?: ProviderPreset): ImapError {
  if (err instanceof ImapError) return err;
  const e = err as { message?: string; responseText?: string; code?: string; authenticationFailed?: boolean };
  const text = [e?.message, e?.responseText, e?.code].filter(Boolean).join(' | ');

  // Microsoft: token accepted but the mailbox is not reachable over IMAP.
  if (/authenticated but not connected/i.test(text)) {
    return new ImapError(
      'AUTH_FAILED',
      'Microsoft 接受了授权，但该邮箱无法通过 IMAP 访问（"User is authenticated but not connected"）。请用这个账户登录一次 outlook.live.com，在 设置 → 邮件 → 同步电子邮件 中开启 IMAP，并确认添加时用的是主邮箱地址而不是别名；企业账户则需管理员启用 IMAP。',
      err,
    );
  }
  if (e?.authenticationFailed || AUTH_PATTERNS.some((p) => p.test(text))) {
    return new ImapError('AUTH_FAILED', preset?.friendlyAuthError ?? 'IMAP 登录失败，请检查凭据。', err);
  }
  if (THROTTLE_PATTERNS.some((p) => p.test(text))) {
    return new ImapError('THROTTLED', `服务器拒绝连接（限流或连接数过多）：${text}`, err);
  }
  if (NETWORK_PATTERNS.some((p) => p.test(text))) {
    return new ImapError('NETWORK', `无法连接 IMAP 服务器：${text}`, err);
  }
  return new ImapError('INTERNAL', `IMAP 错误：${text || 'unknown'}`, err);
}

export function buildImapOptions(p: ImapConnectionParams): ImapFlowOptions {
  const auth: ImapFlowOptions['auth'] = p.accessToken
    ? { user: p.user, accessToken: p.accessToken }
    : { user: p.user, pass: p.pass ?? '' };

  return {
    host: p.host,
    port: p.port,
    secure: p.tls,
    auth,
    clientInfo: { ...CLIENT_INFO },
    logger: false,
    emitLogs: false,
    // 30s for CJK providers on far-away networks; imapflow defaults are lower.
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 5 * 60_000,
    tls: p.allowInsecureTls ? { rejectUnauthorized: false } : { minVersion: 'TLSv1.2' },
    // Never let imapflow silently retry auth — we handle reconnects ourselves.
    maxIdleTime: 25 * 60_000,
    disableAutoIdle: true,
    // imapflow supports http(s):// CONNECT and socks(4|5):// proxies.
    ...(proxyUrlFor(p.preset.id) ? { proxy: proxyUrlFor(p.preset.id) } : {}),
  };
}

/** Open a connection and log in. Throws ImapError on failure. */
export async function connectImap(p: ImapConnectionParams): Promise<ImapFlow> {
  const log: Logger = logger.child({ mod: 'imap', accountId: p.accountId, host: p.host });
  const client = new ImapFlow(buildImapOptions(p));
  // Swallow async errors here; callers attach their own 'error'/'close' listeners.
  client.on('error', (err: unknown) => log.debug({ err }, 'imap client error event'));
  try {
    await client.connect();
    log.debug({ capabilities: [...client.capabilities.keys()] }, 'imap connected');
    return client;
  } catch (err) {
    try {
      client.close();
    } catch {
      /* ignore */
    }
    throw classifyImapError(err, p.preset);
  }
}

/**
 * Quick connectivity test: connect, LIST, logout.
 */
export async function testImapConnection(
  p: ImapConnectionParams,
): Promise<{ folders: number; capabilities: string[] }> {
  const client = await connectImap(p);
  try {
    const list = await client.list();
    // NetEase returns "Unsafe Login" on SELECT if ID was not sent; verify INBOX selects fine.
    const lock = await client.getMailboxLock('INBOX');
    lock.release();
    return { folders: list.length, capabilities: [...client.capabilities.keys()] };
  } catch (err) {
    throw classifyImapError(err, p.preset);
  } finally {
    await client.logout().catch(() => client.close());
  }
}
