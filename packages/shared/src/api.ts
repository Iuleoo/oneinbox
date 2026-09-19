import { z } from 'zod';
import {
  accountColorSchema,
  authTypeSchema,
  providerIdSchema,
  type AccountStatus,
  type AccountColor,
  type AuthType,
  type ProviderId,
} from './providers';

// ─────────────────────────── Errors ───────────────────────────

export const ERROR_CODES = [
  'UNAUTHORIZED',
  'NOT_FOUND',
  'VALIDATION',
  'AUTH_FAILED',
  'NETWORK',
  'THROTTLED',
  'RATE_LIMITED',
  'CONFLICT',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  error: { code: ErrorCode; message: string };
}

// ─────────────────────────── Auth ───────────────────────────

export const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type Credentials = z.infer<typeof credentialsSchema>;

export interface AuthStatus {
  needsSetup: boolean;
  authenticated: boolean;
  username: string | null;
}

// ─────────────────────────── Accounts ───────────────────────────

export interface Account {
  id: number;
  name: string;
  email: string;
  provider: ProviderId;
  color: AccountColor;
  authType: AuthType;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  enabled: boolean;
  syncDays: number;
  status: AccountStatus;
  lastSyncAt: number | null;
  lastError: string | null;
  unreadCount: number;
  syncProgress?: { done: number; total: number };
  folders: FolderInfo[];
}

export interface FolderInfo {
  id: number;
  path: string;
  name: string;
  /** \Inbox \Sent \Drafts \Trash \Junk \Archive \All \Flagged or null */
  specialUse: string | null;
  /** Nesting depth derived from the delimiter (0 = top level). */
  depth: number;
  subscribed: boolean;
  totalCount: number;
  unreadCount: number;
}

export const accountConnectionSchema = z.object({
  email: z.string().trim().email(),
  provider: providerIdSchema,
  /** Leave empty to use the provider preset (inferred from provider + email domain). */
  imapHost: z.string().trim().max(255).optional(),
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapTls: z.boolean().default(true),
  authType: authTypeSchema.default('password'),
  /** Password / app-specific auth code. Required when authType = password. */
  secret: z.string().min(1).max(512),
  allowInsecureTls: z.boolean().default(false),
});
export type AccountConnection = z.infer<typeof accountConnectionSchema>;

export const accountCreateSchema = accountConnectionSchema.extend({
  name: z.string().trim().min(1).max(64),
  color: accountColorSchema.optional(),
  syncDays: z.number().int().min(1).max(3650).default(30),
});
export type AccountCreate = z.infer<typeof accountCreateSchema>;

export const accountPatchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  color: accountColorSchema.optional(),
  enabled: z.boolean().optional(),
  syncDays: z.number().int().min(1).max(3650).optional(),
  secret: z.string().min(1).max(512).optional(),
});
export type AccountPatch = z.infer<typeof accountPatchSchema>;

export interface AccountTestResult {
  ok: true;
  folders: number;
  capabilities: string[];
}

// ─────────────────────────── Health ───────────────────────────

export interface HealthStatus {
  ok: boolean;
  accounts: { total: number; connected: number; error: number };
}

// ─────────────────────────── Messages ───────────────────────────

export interface MessageSummary {
  id: number;
  accountId: number;
  accountColor: AccountColor;
  fromName: string | null;
  fromAddr: string | null;
  subject: string | null;
  snippet: string | null;
  internalDate: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  threadId: string | null;
}

export interface MessageAddress {
  name: string | null;
  address: string;
}

export interface AttachmentInfo {
  id: number;
  filename: string | null;
  contentType: string | null;
  size: number | null;
  isInline: boolean;
}

export type BodyState = 'none' | 'fetching' | 'ready' | 'error';

export interface MessageDetail extends MessageSummary {
  to: MessageAddress[];
  cc: MessageAddress[];
  replyTo: string | null;
  date: number;
  size: number | null;
  messageId: string | null;
  bodyState: BodyState;
  attachments: AttachmentInfo[];
  threadCount: number;
}

export interface MessageBody {
  html: string | null;
  text: string | null;
  hasRemoteImages: boolean;
}

export interface MessageList {
  items: MessageSummary[];
  nextCursor: string | null;
}

export const messageListQuerySchema = z.object({
  scope: z
    .string()
    .regex(/^(unified|account:\d+|folder:\d+)$/)
    .default('unified'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  unread: z.coerce.boolean().optional(),
});
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;

export const messagePatchSchema = z
  .object({
    seen: z.boolean().optional(),
    flagged: z.boolean().optional(),
  })
  .refine((v) => v.seen !== undefined || v.flagged !== undefined, 'nothing to update');
export type MessagePatch = z.infer<typeof messagePatchSchema>;

export const BATCH_ACTIONS = ['seen', 'unseen', 'flag', 'unflag', 'delete'] as const;
export type BatchAction = (typeof BATCH_ACTIONS)[number];
export const messageBatchSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
  action: z.enum(BATCH_ACTIONS),
});
export type MessageBatch = z.infer<typeof messageBatchSchema>;
export interface MessageBatchResult {
  ok: true;
  affected: number;
}

// ─────────────────────────── Search ───────────────────────────

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  scope: z
    .string()
    .regex(/^(unified|account:\d+|folder:\d+)$/)
    .default('unified'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export interface ParsedFilters {
  from?: string;
  hasAttachment?: boolean;
  unread?: boolean;
  starred?: boolean;
  account?: string;
  /** `in:` folder filter: inbox|sent|drafts|junk|trash|archive or a folder name substring. */
  folder?: string;
  /** Free-text remainder after filters were extracted. */
  text: string;
}

export interface SearchResult extends MessageList {
  parsedFilters: ParsedFilters;
}

// ─────────────────────────── Settings & password ───────────────────────────

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8, '新密码至少 8 位').max(256),
});
export type PasswordChange = z.infer<typeof passwordChangeSchema>;

export const settingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).default('system'),
  autoMarkReadMs: z.number().int().min(-1).max(60_000).default(1500),
  showRemoteImages: z.enum(['never', 'ask', 'always']).default('ask'),
  trustedSenders: z.array(z.string().max(320)).max(500).default([]),
  bodyCacheMaxMb: z.number().int().min(10).max(10_000).default(500),
});
export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

// ─────────────────────────── OAuth2 ───────────────────────────

export const OAUTH_PROVIDERS = ['google', 'microsoft'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export const oauthProviderSchema = z.enum(OAUTH_PROVIDERS);

export const oauthConfigSchema = z.object({
  clientId: z.string().trim().min(1).max(200),
  /** Omit to keep the existing secret. */
  clientSecret: z.string().min(1).max(500).optional(),
  /** Must match what is registered at the provider. Defaults to `${BASE_URL}/oauth/<provider>/callback`. */
  redirectUri: z.string().trim().url().max(500).optional(),
});
export type OAuthConfigInput = z.infer<typeof oauthConfigSchema>;

export interface OAuthConfigInfo {
  provider: OAuthProvider;
  configured: boolean;
  clientId: string | null;
  redirectUri: string;
  defaultRedirectUri: string;
}

export const oauthStartSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  color: accountColorSchema.optional(),
  /** Re-authorise an existing account instead of creating one. */
  accountId: z.coerce.number().int().positive().optional(),
});

export interface OAuthStartResult {
  url: string;
  state: string;
  redirectUri: string;
}

export const oauthCompleteSchema = z.object({
  /** Either the full redirected URL the browser landed on, or the raw code + state. */
  url: z.string().max(4000).optional(),
  code: z.string().max(2000).optional(),
  state: z.string().max(200).optional(),
});

export type OAuthPendingStatus = { status: 'pending' } | { status: 'done'; accountId: number } | { status: 'error'; message: string } | { status: 'unknown' };
