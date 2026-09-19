import type {
  Account,
  AccountCreate,
  AccountConnection,
  AccountPatch,
  AccountTestResult,
  ApiError,
  AuthStatus,
  Credentials,
  MessageBatch,
  MessageBatchResult,
  MessageBody,
  MessageDetail,
  MessageList,
  MessagePatch,
  MessageSummary,
  OAuthConfigInfo,
  OAuthConfigInput,
  OAuthPendingStatus,
  OAuthProvider,
  OAuthStartResult,
  PasswordChange,
  ProviderInfo,
  SearchResult,
  Settings,
  SettingsPatch,
} from '@inbox/shared';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function request<T>(method: string, url: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const err = (data as ApiError | null)?.error;
    if (res.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login')) {
      window.dispatchEvent(new CustomEvent('inbox:unauthorized'));
    }
    throw new HttpError(res.status, err?.code ?? 'INTERNAL', err?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  auth: {
    status: () => request<AuthStatus>('GET', '/api/auth/status'),
    login: (c: Credentials) => request<{ ok: true }>('POST', '/api/auth/login', c),
    setup: (c: Credentials) => request<{ ok: true }>('POST', '/api/auth/setup', c),
    logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
    changePassword: (p: PasswordChange) => request<{ ok: true }>('POST', '/api/auth/password', p),
  },
  accounts: {
    list: () => request<Account[]>('GET', '/api/accounts'),
    test: (c: AccountConnection) => request<AccountTestResult>('POST', '/api/accounts/test', c),
    create: (c: AccountCreate) => request<Account>('POST', '/api/accounts', c),
    patch: (id: number, p: AccountPatch) => request<Account>('PATCH', `/api/accounts/${id}`, p),
    remove: (id: number) => request<void>('DELETE', `/api/accounts/${id}`),
    sync: (id: number) => request<{ ok: true }>('POST', `/api/accounts/${id}/sync`),
    resync: (id: number) => request<{ ok: true }>('POST', `/api/accounts/${id}/resync`),
  },
  providers: () => request<ProviderInfo[]>('GET', '/api/providers'),
  oauth: {
    config: (p: OAuthProvider) => request<OAuthConfigInfo>('GET', `/api/oauth/${p}/config`),
    saveConfig: (p: OAuthProvider, c: OAuthConfigInput) => request<OAuthConfigInfo>('PUT', `/api/oauth/${p}/config`, c),
    start: (p: OAuthProvider, q: { name?: string; color?: string; accountId?: number }) => {
      const sp = new URLSearchParams();
      if (q.name) sp.set('name', q.name);
      if (q.color) sp.set('color', q.color);
      if (q.accountId) sp.set('accountId', String(q.accountId));
      return request<OAuthStartResult>('GET', `/api/oauth/${p}/start?${sp}`);
    },
    complete: (p: OAuthProvider, body: { url?: string; code?: string; state?: string }) => request<{ ok: true; accountId: number }>('POST', `/api/oauth/${p}/complete`, body),
    status: (state: string) => request<OAuthPendingStatus>('GET', `/api/oauth/status?state=${encodeURIComponent(state)}`),
  },
  settings: {
    get: () => request<Settings>('GET', '/api/settings'),
    patch: (p: SettingsPatch) => request<Settings>('PATCH', '/api/settings', p),
  },
  search: (q: string, scope: string, cursor?: string, limit = 50) => {
    const p = new URLSearchParams({ q, scope, limit: String(limit) });
    if (cursor) p.set('cursor', cursor);
    return request<SearchResult>('GET', `/api/search?${p}`);
  },
  messages: {
    list: (scope: string, cursor?: string, limit = 50) => {
      const q = new URLSearchParams({ scope, limit: String(limit) });
      if (cursor) q.set('cursor', cursor);
      return request<MessageList>('GET', `/api/messages?${q}`);
    },
    get: (id: number) => request<MessageDetail>('GET', `/api/messages/${id}`),
    body: (id: number) => request<MessageBody>('GET', `/api/messages/${id}/body`),
    patch: (id: number, p: MessagePatch) => request<MessageSummary>('PATCH', `/api/messages/${id}`, p),
    remove: (id: number) => request<void>('DELETE', `/api/messages/${id}`),
    batch: (b: MessageBatch) => request<MessageBatchResult>('POST', '/api/messages/batch', b),
    attachmentUrl: (id: number, attId: number, inline = false) =>
      `/api/messages/${id}/attachments/${attId}${inline ? '?inline=1' : ''}`,
  },
};
