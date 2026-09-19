import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { OAuthProvider, OAuthConfigInfo, ProviderId } from '@inbox/shared';
import { config } from '../config';
import { getCipher } from '../crypto';
import { getDb, schema } from '../db';
import { AppError } from '../errors';
import { logger } from '../logger';
import { PROVIDERS, type ProviderPreset } from '../providers';
import { fetchFor } from '../net/proxy';

const log = logger.child({ mod: 'oauth' });

// ─────────────────────────── provider endpoints ───────────────────────────

export function presetFor(provider: OAuthProvider): ProviderPreset & { oauth: NonNullable<ProviderPreset['oauth']> } {
  const id: ProviderId = provider === 'google' ? 'gmail' : 'outlook';
  const p = PROVIDERS[id];
  if (!p.oauth) throw new AppError('INTERNAL', `provider ${id} has no oauth config`);
  return p as ProviderPreset & { oauth: NonNullable<ProviderPreset['oauth']> };
}

export function providerIdFor(provider: OAuthProvider): ProviderId {
  return provider === 'google' ? 'gmail' : 'outlook';
}

export function defaultRedirectUri(provider: OAuthProvider): string {
  return `${config.BASE_URL.replace(/\/$/, '')}/oauth/${provider}/callback`;
}

// ─────────────────────────── client config (settings table, secret encrypted) ───────────────────────────

interface StoredConfig {
  clientId: string;
  secret: { enc: string; iv: string; tag: string };
  redirectUri?: string;
}

function settingsKey(provider: OAuthProvider) {
  return `oauth.${provider}`;
}

export function loadClientConfig(provider: OAuthProvider): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, settingsKey(provider))).get();
  if (!row) return null;
  try {
    const s = JSON.parse(row.value) as StoredConfig;
    const clientSecret = getCipher().decrypt({
      enc: Buffer.from(s.secret.enc, 'base64'),
      iv: Buffer.from(s.secret.iv, 'base64'),
      tag: Buffer.from(s.secret.tag, 'base64'),
    });
    return { clientId: s.clientId, clientSecret, redirectUri: s.redirectUri || defaultRedirectUri(provider) };
  } catch (err) {
    log.warn({ err, provider }, 'oauth config unreadable');
    return null;
  }
}

export function saveClientConfig(provider: OAuthProvider, input: { clientId: string; clientSecret?: string; redirectUri?: string }): void {
  const existing = loadClientConfig(provider);
  const secretPlain = input.clientSecret ?? existing?.clientSecret;
  if (!secretPlain) throw new AppError('VALIDATION', '首次配置必须提供 Client Secret');
  const e = getCipher().encrypt(secretPlain);
  const stored: StoredConfig = {
    clientId: input.clientId,
    secret: { enc: e.enc.toString('base64'), iv: e.iv.toString('base64'), tag: e.tag.toString('base64') },
    redirectUri: input.redirectUri || undefined,
  };
  const value = JSON.stringify(stored);
  getDb()
    .insert(schema.settings)
    .values({ key: settingsKey(provider), value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
}

export function configInfo(provider: OAuthProvider): OAuthConfigInfo {
  const c = loadClientConfig(provider);
  return {
    provider,
    configured: !!c,
    clientId: c?.clientId ?? null,
    redirectUri: c?.redirectUri ?? defaultRedirectUri(provider),
    defaultRedirectUri: defaultRedirectUri(provider),
  };
}

// ─────────────────────────── pending authorisations (in-memory, 15 min) ───────────────────────────

interface Pending {
  provider: OAuthProvider;
  codeVerifier: string;
  createdAt: number;
  name?: string;
  color?: string;
  accountId?: number;
  result?: { status: 'done'; accountId: number } | { status: 'error'; message: string };
}

const pending = new Map<string, Pending>();
const PENDING_TTL = 15 * 60_000;

function gc() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > PENDING_TTL) pending.delete(k);
}

const b64url = (b: Buffer) => b.toString('base64url');

export function startAuthorization(provider: OAuthProvider, opts: { name?: string; color?: string; accountId?: number }): { url: string; state: string; redirectUri: string } {
  gc();
  const cfg = loadClientConfig(provider);
  if (!cfg) throw new AppError('VALIDATION', '尚未配置该服务商的 OAuth 客户端');
  const preset = presetFor(provider);
  const state = b64url(crypto.randomBytes(24));
  const codeVerifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  pending.set(state, { provider, codeVerifier, createdAt: Date.now(), ...opts });

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    scope: preset.oauth.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  if (provider === 'google') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
    params.set('include_granted_scopes', 'true');
  } else {
    params.set('response_mode', 'query');
    params.set('prompt', 'select_account');
  }
  return { url: `${preset.oauth.authorizeUrl}?${params}`, state, redirectUri: cfg.redirectUri };
}

export function pendingStatus(state: string) {
  const p = pending.get(state);
  if (!p) return { status: 'unknown' } as const;
  return p.result ?? ({ status: 'pending' } as const);
}

// ─────────────────────────── token endpoint ───────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(provider: OAuthProvider, form: Record<string, string>): Promise<TokenResponse> {
  const preset = presetFor(provider);
  let res: Response | undefined;
  let lastErr: unknown;
  // Transient network failures (DNS blip, reset) must surface as NETWORK, not AUTH_FAILED,
  // otherwise the worker stops retrying and the account sits in "error" until a manual sync.
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    try {
      res = await fetchFor(preset.id, preset.oauth.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      lastErr = err;
      log.warn({ err: describeFetchError(err), attempt }, 'token endpoint unreachable');
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  if (!res) throw new AppError('NETWORK', `无法连接 ${provider === 'google' ? 'Google' : 'Microsoft'} 令牌服务：${describeFetchError(lastErr)}`);
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || data.error) {
    const msg = `${data.error ?? res.status}: ${data.error_description ?? ''}`.trim();
    if (data.error === 'invalid_grant') throw new AppError('AUTH_FAILED', `授权已失效，请重新授权（${msg}）`);
    throw new AppError('AUTH_FAILED', `令牌请求失败：${msg}`);
  }
  return data;
}

function describeFetchError(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  return [e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean).join(' / ') || String(err);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Resolve the mailbox address for the authorised user. */
async function resolveEmail(provider: OAuthProvider, tok: TokenResponse): Promise<string> {
  if (tok.id_token) {
    const p = decodeJwtPayload(tok.id_token);
    const email = (p.email ?? p.preferred_username ?? p.upn) as string | undefined;
    if (email && email.includes('@')) return email.toLowerCase();
  }
  if (provider === 'google') {
    const r = await fetchFor('gmail', 'https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(15_000) });
    const j = (await r.json().catch(() => ({}))) as { email?: string };
    if (j.email) return j.email.toLowerCase();
  }
  throw new AppError('AUTH_FAILED', '无法从授权结果中获取邮箱地址');
}

/**
 * Finish an authorisation: exchange the code, find the email, create or update the account.
 * Returns the account id.
 */
export async function completeAuthorization(state: string, code: string): Promise<number> {
  gc();
  const p = pending.get(state);
  if (!p) throw new AppError('VALIDATION', '授权已过期或 state 无效，请重新开始');
  if (p.result?.status === 'done') return p.result.accountId;
  const cfg = loadClientConfig(p.provider);
  if (!cfg) throw new AppError('VALIDATION', 'OAuth 客户端配置丢失');

  try {
    const tok = await tokenRequest(p.provider, {
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: p.codeVerifier,
    });
    if (!tok.refresh_token) {
      throw new AppError('AUTH_FAILED', p.provider === 'google' ? '未返回 refresh_token。请在 Google 账户的第三方应用权限里移除本应用后重试' : '未返回 refresh_token，请确认申请了 offline_access');
    }
    const email = await resolveEmail(p.provider, tok);
    const preset = presetFor(p.provider);
    const enc = getCipher().encrypt(tok.refresh_token);
    const db = getDb();
    const now = Date.now();

    let accountId: number;
    if (p.accountId) {
      const acc = db.select().from(schema.accounts).where(eq(schema.accounts.id, p.accountId)).get();
      if (!acc) throw new AppError('NOT_FOUND', '账户不存在');
      if (acc.email !== email) throw new AppError('VALIDATION', `授权的是 ${email}，与账户 ${acc.email} 不一致`);
      db.update(schema.accounts)
        .set({ secretEnc: enc.enc, secretIv: enc.iv, secretTag: enc.tag, status: 'idle', lastError: null, updatedAt: now })
        .where(eq(schema.accounts.id, acc.id))
        .run();
      accountId = acc.id;
    } else {
      const dup = db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.email, email)).get();
      if (dup) throw new AppError('CONFLICT', `${email} 已添加过`);
      const used = db.select({ color: schema.accounts.color }).from(schema.accounts).all().map((r) => r.color);
      const colors = ['blue', 'violet', 'pink', 'orange', 'amber', 'green', 'teal', 'slate'];
      const color = p.color ?? colors.find((c) => !used.includes(c)) ?? colors[used.length % colors.length]!;
      const res = db
        .insert(schema.accounts)
        .values({
          name: p.name || email.split('@')[0]!,
          email,
          provider: preset.id,
          color,
          imapHost: preset.imapHost,
          imapPort: preset.imapPort,
          imapTls: preset.imapTls ? 1 : 0,
          authType: 'oauth2',
          secretEnc: enc.enc,
          secretIv: enc.iv,
          secretTag: enc.tag,
          oauthClientId: cfg.clientId,
          enabled: 1,
          syncDays: 30,
          status: 'idle',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      accountId = Number(res.lastInsertRowid);
    }
    p.result = { status: 'done', accountId };
    log.info({ provider: p.provider, email, accountId }, 'oauth authorisation completed');
    return accountId;
  } catch (err) {
    p.result = { status: 'error', message: err instanceof Error ? err.message : String(err) };
    throw err;
  }
}

/** Parse `code` and `state` out of a pasted redirect URL. */
export function parseRedirectUrl(url: string): { code: string; state: string } {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new AppError('VALIDATION', '不是有效的 URL');
  }
  const err = u.searchParams.get('error');
  if (err) throw new AppError('AUTH_FAILED', `授权被拒绝：${err} ${u.searchParams.get('error_description') ?? ''}`.trim());
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  if (!code || !state) throw new AppError('VALIDATION', 'URL 中没有 code/state 参数');
  return { code, state };
}

// ─────────────────────────── access tokens for IMAP (cached per account) ───────────────────────────

const accessCache = new Map<number, { token: string; expiresAt: number }>();

export function invalidateAccessToken(accountId: number) {
  accessCache.delete(accountId);
}

/** Get a valid access token for an oauth2 account, refreshing via refresh_token when needed. */
export async function getAccessToken(accountId: number): Promise<string> {
  const cached = accessCache.get(accountId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;

  const db = getDb();
  const acc = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (!acc) throw new AppError('NOT_FOUND', 'account not found');
  const provider: OAuthProvider = acc.provider === 'gmail' ? 'google' : 'microsoft';
  const cfg = loadClientConfig(provider);
  if (!cfg) throw new AppError('AUTH_FAILED', 'OAuth 客户端未配置，无法刷新令牌');
  const refreshToken = getCipher().decrypt({ enc: acc.secretEnc, iv: acc.secretIv, tag: acc.secretTag });

  const tok = await tokenRequest(provider, {
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    ...(provider === 'microsoft' ? { scope: presetFor(provider).oauth.scope } : {}),
  });
  // Microsoft rotates refresh tokens; persist the new one when given.
  if (tok.refresh_token && tok.refresh_token !== refreshToken) {
    const enc = getCipher().encrypt(tok.refresh_token);
    db.update(schema.accounts).set({ secretEnc: enc.enc, secretIv: enc.iv, secretTag: enc.tag, updatedAt: Date.now() }).where(eq(schema.accounts.id, accountId)).run();
  }
  const expiresAt = Date.now() + (tok.expires_in ?? 3600) * 1000;
  accessCache.set(accountId, { token: tok.access_token, expiresAt });
  return tok.access_token;
}
