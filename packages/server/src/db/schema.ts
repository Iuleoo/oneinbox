import { sql } from 'drizzle-orm';
import { blob, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ─────────────────────────── App layer ───────────────────────────

export const appUser = sqliteTable('app_user', {
  id: integer('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    token: text('token').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_sessions_expires').on(t.expiresAt)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ─────────────────────────── Accounts ───────────────────────────

export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  provider: text('provider').notNull(),
  color: text('color').notNull(),
  imapHost: text('imap_host').notNull(),
  imapPort: integer('imap_port').notNull().default(993),
  imapTls: integer('imap_tls').notNull().default(1),
  allowInsecureTls: integer('allow_insecure_tls').notNull().default(0),
  authType: text('auth_type').notNull(),
  secretEnc: blob('secret_enc', { mode: 'buffer' }).notNull(),
  secretIv: blob('secret_iv', { mode: 'buffer' }).notNull(),
  secretTag: blob('secret_tag', { mode: 'buffer' }).notNull(),
  oauthClientId: text('oauth_client_id'),
  oauthClientSecretEnc: blob('oauth_client_secret_enc', { mode: 'buffer' }),
  oauthClientSecretIv: blob('oauth_client_secret_iv', { mode: 'buffer' }),
  oauthClientSecretTag: blob('oauth_client_secret_tag', { mode: 'buffer' }),
  enabled: integer('enabled').notNull().default(1),
  syncDays: integer('sync_days').notNull().default(30),
  status: text('status').notNull().default('idle'),
  lastSyncAt: integer('last_sync_at'),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const folders = sqliteTable(
  'folders',
  {
    id: integer('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    displayName: text('display_name').notNull(),
    specialUse: text('special_use'),
    delimiter: text('delimiter'),
    subscribed: integer('subscribed').notNull().default(0),
    uidvalidity: integer('uidvalidity'),
    uidnext: integer('uidnext'),
    highestModseq: integer('highest_modseq'),
    totalCount: integer('total_count').notNull().default(0),
    unreadCount: integer('unread_count').notNull().default(0),
    lastSyncAt: integer('last_sync_at'),
  },
  (t) => [uniqueIndex('uq_folders_account_path').on(t.accountId, t.path)],
);

// ─────────────────────────── Messages ───────────────────────────

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    folderId: integer('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    uid: integer('uid').notNull(),
    messageId: text('message_id'),
    threadId: text('thread_id'),
    fromName: text('from_name'),
    fromAddr: text('from_addr'),
    toJson: text('to_json').notNull().default('[]'),
    ccJson: text('cc_json').notNull().default('[]'),
    replyToAddr: text('reply_to_addr'),
    subject: text('subject'),
    snippet: text('snippet'),
    date: integer('date').notNull(),
    internalDate: integer('internal_date').notNull(),
    seen: integer('seen').notNull().default(0),
    flagged: integer('flagged').notNull().default(0),
    answered: integer('answered').notNull().default(0),
    deleted: integer('deleted').notNull().default(0),
    hasAttachments: integer('has_attachments').notNull().default(0),
    size: integer('size'),
    /** IMAP part ids for text/plain and text/html bodies, JSON {text?: string, html?: string}. */
    bodyParts: text('body_parts'),
    bodyState: text('body_state').notNull().default('none'),
    bodyHtml: text('body_html'),
    bodyText: text('body_text'),
    bodyFetchedAt: integer('body_fetched_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uq_messages_folder_uid').on(t.folderId, t.uid),
    index('idx_messages_unified').on(sql`${t.internalDate} DESC`, sql`${t.id} DESC`),
    index('idx_messages_folder').on(t.folderId, sql`${t.internalDate} DESC`, sql`${t.id} DESC`),
    index('idx_messages_account').on(t.accountId, sql`${t.internalDate} DESC`),
    index('idx_messages_unseen').on(t.folderId, t.seen),
    index('idx_messages_msgid').on(t.messageId),
  ],
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey(),
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    partId: text('part_id').notNull(),
    filename: text('filename'),
    contentType: text('content_type'),
    size: integer('size'),
    contentId: text('content_id'),
    isInline: integer('is_inline').notNull().default(0),
    cachePath: text('cache_path'),
  },
  (t) => [uniqueIndex('uq_attachments_message_part').on(t.messageId, t.partId)],
);

// ─────────────────────────── Pending write-back ops ───────────────────────────

export const pendingOps = sqliteTable(
  'pending_ops',
  {
    id: integer('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    op: text('op').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_pending_ops_account').on(t.accountId, t.createdAt)],
);

export type AccountRow = typeof accounts.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type NewAttachment = typeof attachments.$inferInsert;
