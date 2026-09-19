import { eq, and } from 'drizzle-orm';
import type { ImapFlow, ListResponse } from 'imapflow';
import type { AccountStatus } from '@inbox/shared';
import { getDb, schema } from '../db';
import type { AccountRow, FolderRow } from '../db/schema';
import { getCipher } from '../crypto';
import { events } from '../events';
import { logger, type Logger } from '../logger';
import { getProvider, type ProviderPreset } from '../providers';
import { AppError } from '../errors';
import { ImapError, classifyImapError, connectImap } from './ImapClient';
import { getAccessToken, invalidateAccessToken } from '../oauth';
import { makeSnippet, parseFetchedMessage, updateFolderCounts, upsertEnvelopes, type ParsedEnvelope } from './MessageStore';

const BATCH_SIZE = 200;
const SNIPPET_BYTES = 512;
const SNIPPET_MAX_PART_SIZE = 8 * 1024;
const BACKOFF_STEPS_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000];
const THROTTLE_BACKOFF_MS = 60_000;
const POLL_INTERVAL_MS = 3 * 60_000;
/** Non-INBOX folders are re-checked at most this often (no IDLE on them). */
const OTHER_FOLDER_INTERVAL_MS = 5 * 60_000;
/** Special-use folders we never sync (Gmail virtual views that duplicate other folders). */
const SKIP_SPECIAL_USE = new Set(['\\All', '\\Flagged']);
/**
 * How long to sit in IDLE before breaking out to probe for new mail anyway.
 * Real-world finding (2026-09-18, QQ): the server accepts IDLE but never pushes EXISTS for new
 * mail, so IDLE alone is not a reliable signal. A 2-minute probe (one UID SEARCH) is cheap and
 * bounds the worst-case latency; providers that do push are still handled instantly.
 */
const IDLE_PROBE_MS = 2 * 60_000;

type WorkerState = 'stopped' | 'connecting' | 'initial_sync' | 'idle' | 'polling' | 'syncing' | 'backoff' | 'error';

const SPECIAL_USE_BY_NAME: [RegExp, string][] = [
  [/^inbox$/i, '\\Inbox'],
  [/^(sent|sent messages|sent items|已发送|已发送邮件|\[Gmail\]\/Sent Mail)$/i, '\\Sent'],
  [/^(drafts|草稿箱|草稿|\[Gmail\]\/Drafts)$/i, '\\Drafts'],
  [/^(trash|deleted messages|deleted items|已删除|已删除邮件|\[Gmail\]\/Trash)$/i, '\\Trash'],
  [/^(junk|spam|垃圾邮件|\[Gmail\]\/Spam)$/i, '\\Junk'],
  [/^(archive|归档|\[Gmail\]\/All Mail)$/i, '\\Archive'],
];

function inferSpecialUse(box: ListResponse): string | null {
  if (box.specialUse) return box.specialUse;
  const name = box.path;
  for (const [re, use] of SPECIAL_USE_BY_NAME) if (re.test(name)) return use;
  return null;
}

export class AccountWorker {
  readonly accountId: number;
  private readonly log: Logger;
  private preset: ProviderPreset;
  private client: ImapFlow | null = null;
  private state: WorkerState = 'stopped';
  private stopping = false;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private loopPromise: Promise<void> | null = null;
  private syncRequested = false;
  private idleBroken = false;
  private oauthRetried = false;
  private lastFullPollAt = 0;

  constructor(accountId: number) {
    this.accountId = accountId;
    this.log = logger.child({ mod: 'worker', accountId });
    const row = this.loadAccount();
    this.preset = getProvider(row.provider as ProviderPreset['id']);
  }

  // ─────────────────────────── lifecycle ───────────────────────────

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.loopPromise = this.runLoop().catch((err) => this.log.error({ err }, 'worker loop crashed'));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wake?.();
    await this.disconnect();
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = null;
    this.setState('stopped');
  }

  /** Ask the worker to run an incremental sync as soon as possible. */
  requestSync(): void {
    this.syncRequested = true;
    if (this.state === 'idle' || this.state === 'polling') {
      // Wake the sleeping loop.
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.wake?.();
    }
  }

  getState(): WorkerState {
    return this.state;
  }

  /**
   * Run an IMAP operation on this worker's live connection with the given mailbox selected.
   * Serialised against sync via the mailbox lock; breaks IDLE automatically (imapflow handles it).
   */
  async withConnection<T>(folderPath: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.client;
    if (!client || !client.usable) {
      throw new ImapError('NETWORK', '邮箱连接未就绪，请稍后重试');
    }
    const lock = await client.getMailboxLock(folderPath, { acquireTimeout: 30_000 });
    try {
      return await fn(client);
    } catch (err) {
      throw classifyImapError(err, this.preset);
    } finally {
      lock.release();
    }
  }

  /** Push locally-made flag changes (pending_ops) to the server. Called after each sync and on demand. */
  async flushPendingOps(): Promise<void> {
    const client = this.client;
    if (!client?.usable) return;
    const db = getDb();
    const ops = db
      .select({
        id: schema.pendingOps.id,
        op: schema.pendingOps.op,
        attempts: schema.pendingOps.attempts,
        messageId: schema.pendingOps.messageId,
        uid: schema.messages.uid,
        folderPath: schema.folders.path,
        folderSpecialUse: schema.folders.specialUse,
      })
      .from(schema.pendingOps)
      .innerJoin(schema.messages, eq(schema.messages.id, schema.pendingOps.messageId))
      .innerJoin(schema.folders, eq(schema.folders.id, schema.messages.folderId))
      .where(eq(schema.pendingOps.accountId, this.accountId))
      .orderBy(schema.pendingOps.createdAt)
      .all();
    if (!ops.length) return;

    for (const op of ops) {
      if (this.stopping) return;
      try {
        await this.withConnection(op.folderPath, async (c) => {
          const uid = String(op.uid);
          switch (op.op) {
            case 'set_seen':
              await c.messageFlagsAdd(uid, ['\Seen'], { uid: true, silent: true });
              break;
            case 'unset_seen':
              await c.messageFlagsRemove(uid, ['\Seen'], { uid: true, silent: true });
              break;
            case 'set_flagged':
              await c.messageFlagsAdd(uid, ['\Flagged'], { uid: true, silent: true });
              break;
            case 'unset_flagged':
              await c.messageFlagsRemove(uid, ['\Flagged'], { uid: true, silent: true });
              break;
            case 'delete': {
              const trash = this.getTrashPath();
              if (op.folderSpecialUse === '\\Trash') {
                // Already in Trash: this is a permanent delete.
                await c.messageDelete(uid, { uid: true });
              } else if (trash && trash !== op.folderPath) {
                await c.messageMove(uid, trash, { uid: true });
              } else {
                // No trash folder known: flag \Deleted + expunge (permanent). Log loudly so a
                // misconfigured special-use lookup is noticed instead of silently destroying mail.
                this.log.warn({ uid, folder: op.folderPath }, 'no \Trash folder; permanently expunging');
                await c.messageDelete(uid, { uid: true });
              }
              break;
            }
            default:
              this.log.warn({ op: op.op }, 'unknown pending op');
          }
        });
        if (op.op === 'delete') {
          // Gone from the server folder now; drop the local row (cascades attachments + this op).
          db.delete(schema.messages).where(eq(schema.messages.id, op.messageId)).run();
        } else {
          db.delete(schema.pendingOps).where(eq(schema.pendingOps.id, op.id)).run();
        }
      } catch (err) {
        const attempts = op.attempts + 1;
        const message = err instanceof Error ? err.message : String(err);
        if (attempts >= 5) {
          db.delete(schema.pendingOps).where(eq(schema.pendingOps.id, op.id)).run();
          if (op.op === 'delete') db.update(schema.messages).set({ deleted: 0 }).where(eq(schema.messages.id, op.messageId)).run();
          events.emit('message:op_failed', { messageId: op.messageId, op: op.op, error: message });
          this.log.warn({ op, err: message }, 'pending op dropped after 5 attempts');
        } else {
          db.update(schema.pendingOps).set({ attempts, lastError: message }).where(eq(schema.pendingOps.id, op.id)).run();
        }
        // Connection problems: stop trying this round; the loop will reconnect and retry.
        if (err instanceof ImapError && err.kind !== 'INTERNAL') return;
      }
    }
  }

  private wake: (() => void) | null = null;

  // ─────────────────────────── main loop ───────────────────────────

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.connect();
        this.failures = 0;
        this.oauthRetried = false;

        const inbox = await this.ensureFolders();
        if (!inbox) throw new ImapError('INTERNAL', '未找到 INBOX 文件夹');

        await this.flushPendingOps();
        await this.syncFolder(inbox);
        await this.syncOtherFolders();

        // Stay connected: IDLE (or poll) until something happens.
        while (!this.stopping && this.client?.usable) {
          this.syncRequested = false;
          const usePolling = this.preset.preferPolling || this.idleBroken || !this.client.capabilities.has('IDLE');
          if (usePolling) {
            this.setState('polling');
            await this.sleep(POLL_INTERVAL_MS);
          } else {
            this.setState('idle');
            await this.idleUntilEvent();
          }
          if (this.stopping) break;
          await this.flushPendingOps();
          const folder = this.getInboxFolder();
          if (folder) await this.syncFolder(folder);
          await this.syncOtherFolders(this.syncRequested);
        }
      } catch (err) {
        if (this.stopping) break;
        const imapErr = classifyImapError(err, this.preset);
        this.log.warn({ err: imapErr.message, kind: imapErr.kind }, 'worker error');
        await this.disconnect();

        if (imapErr.kind === 'AUTH_FAILED') {
          // OAuth: one retry with a freshly refreshed token before giving up (stale cached token).
          if (this.loadAccount().authType === 'oauth2' && !this.oauthRetried) {
            this.oauthRetried = true;
            invalidateAccessToken(this.accountId);
            this.log.info('oauth auth failed once; retrying with a refreshed token');
            await this.sleep(2000);
            continue;
          }
          this.persistStatus('error', imapErr.message);
          this.setState('error');
          // Do not retry auth failures; wait for the user to fix credentials.
          return;
        }

        this.persistStatus('error', imapErr.message);
        const delay =
          imapErr.kind === 'THROTTLED'
            ? THROTTLE_BACKOFF_MS
            : BACKOFF_STEPS_MS[Math.min(this.failures, BACKOFF_STEPS_MS.length - 1)]!;
        this.failures++;
        this.setState('backoff');
        this.log.info({ delay }, 'reconnecting after backoff');
        await this.sleep(delay);
      }
    }
    await this.disconnect();
  }

  // ─────────────────────────── connection ───────────────────────────

  private loadAccount(): AccountRow {
    const row = getDb().select().from(schema.accounts).where(eq(schema.accounts.id, this.accountId)).get();
    if (!row) throw new Error(`account ${this.accountId} not found`);
    return row;
  }

  private async connect(): Promise<void> {
    this.setState('connecting');
    const acc = this.loadAccount();
    this.preset = getProvider(acc.provider as ProviderPreset['id']);

    let auth: { pass: string } | { accessToken: string };
    if (acc.authType === 'oauth2') {
      try {
        auth = { accessToken: await getAccessToken(this.accountId) };
      } catch (err) {
        // Network trouble reaching the token endpoint → retry with backoff like any outage.
        // Only a genuine rejection (invalid_grant etc.) is an auth failure that waits for the user.
        const kind = err instanceof AppError && err.code === 'NETWORK' ? 'NETWORK' : 'AUTH_FAILED';
        throw new ImapError(kind, err instanceof Error ? err.message : String(err), err);
      }
    } else {
      auth = { pass: getCipher().decrypt({ enc: acc.secretEnc, iv: acc.secretIv, tag: acc.secretTag }) };
    }

    let client: ImapFlow;
    try {
      client = await connectImap({
        host: acc.imapHost,
        port: acc.imapPort,
        tls: acc.imapTls === 1,
        allowInsecureTls: acc.allowInsecureTls === 1,
        user: acc.email,
        ...auth,
        preset: this.preset,
        accountId: this.accountId,
      });
    } catch (err) {
      // A rejected access token may simply be stale; drop the cache so the next attempt refreshes.
      if (acc.authType === 'oauth2') invalidateAccessToken(this.accountId);
      throw err;
    }

    client.on('close', () => {
      this.log.debug('imap connection closed');
      this.wake?.();
    });
    client.on('error', (err: unknown) => {
      this.log.debug({ err }, 'imap error');
      this.wake?.();
    });

    this.client = client;
    this.persistStatus('connected', null);
    this.log.info('connected');
  }

  private async disconnect(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (!c) return;
    try {
      await Promise.race([c.logout(), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      /* ignore */
    }
    try {
      c.close();
    } catch {
      /* ignore */
    }
  }

  // ─────────────────────────── folders ───────────────────────────

  /** Sync every subscribed non-INBOX folder whose last sync is older than the interval. */
  private async syncOtherFolders(force = false): Promise<void> {
    const rows = getDb()
      .select()
      .from(schema.folders)
      .where(and(eq(schema.folders.accountId, this.accountId), eq(schema.folders.subscribed, 1)))
      .all()
      .filter((f) => f.specialUse !== '\\Inbox');
    const now = Date.now();
    for (const f of rows) {
      if (this.stopping || !this.client?.usable) return;
      // Folders that still need their initial sync (uidvalidity unset) are never throttled.
      if (!force && f.uidvalidity !== null && f.lastSyncAt && now - f.lastSyncAt < OTHER_FOLDER_INTERVAL_MS) continue;
      try {
        await this.syncFolder(f);
      } catch (err) {
        // One bad folder (e.g. permission denied) must not take the account down.
        this.log.warn({ err: err instanceof Error ? err.message : String(err), folder: f.path }, 'folder sync failed');
        if (err instanceof ImapError && err.kind !== 'INTERNAL') throw err;
      }
    }
  }

  private getTrashPath(): string | null {
    const row = getDb()
      .select({ path: schema.folders.path })
      .from(schema.folders)
      .where(and(eq(schema.folders.accountId, this.accountId), eq(schema.folders.specialUse, '\\Trash')))
      .get();
    return row?.path ?? null;
  }

  private getInboxFolder(): FolderRow | undefined {
    return getDb()
      .select()
      .from(schema.folders)
      .where(and(eq(schema.folders.accountId, this.accountId), eq(schema.folders.specialUse, '\\Inbox')))
      .get();
  }

  private async ensureFolders(): Promise<FolderRow | undefined> {
    const client = this.client!;
    const list = await client.list();
    const db = getDb();

    db.transaction((tx) => {
      const seen = new Set<string>();
      for (const box of list) {
        seen.add(box.path);
        const specialUse = inferSpecialUse(box);
        const flagsLower = new Set([...box.flags].map((x) => x.toLowerCase()));
        const selectable = !flagsLower.has('\\noselect') && !flagsLower.has('\\nonexistent');
        const subscribed = selectable && !(specialUse && SKIP_SPECIAL_USE.has(specialUse)) ? 1 : 0;
        const existing = tx
          .select()
          .from(schema.folders)
          .where(and(eq(schema.folders.accountId, this.accountId), eq(schema.folders.path, box.path)))
          .get();
        if (existing) {
          tx.update(schema.folders)
            .set({ displayName: box.name, specialUse, delimiter: box.delimiter ?? null, subscribed })
            .where(eq(schema.folders.id, existing.id))
            .run();
        } else {
          tx.insert(schema.folders)
            .values({
              accountId: this.accountId,
              path: box.path,
              displayName: box.name,
              specialUse,
              delimiter: box.delimiter ?? null,
              subscribed,
            })
            .run();
        }
      }
      // Folders deleted on the server: drop locally (cascades their messages).
      const local = tx.select({ id: schema.folders.id, path: schema.folders.path }).from(schema.folders).where(eq(schema.folders.accountId, this.accountId)).all();
      for (const f of local) if (!seen.has(f.path)) tx.delete(schema.folders).where(eq(schema.folders.id, f.id)).run();
    });

    return this.getInboxFolder();
  }

  // ─────────────────────────── sync ───────────────────────────

  private async syncFolder(folder: FolderRow): Promise<void> {
    const client = this.client!;
    const prevState = this.state;
    this.setState('syncing');

    const lock = await client.getMailboxLock(folder.path);
    this.log.debug({ folder: folder.path, prevState }, 'sync run');
    try {
      const mb = client.mailbox;
      if (!mb) throw new ImapError('INTERNAL', 'mailbox not selected');

      const uidvalidity = Number(mb.uidValidity);
      const uidnext = Number(mb.uidNext ?? 0);
      const highestModseq = mb.highestModseq !== undefined ? Number(mb.highestModseq) : null;

      const needInitial = folder.uidvalidity === null || folder.uidvalidity !== uidvalidity;

      // NOTE: `client.mailbox.uidNext` is a snapshot from the SELECT at connect time and is NOT
      // refreshed while the connection stays open, so it must not be used to detect new mail
      // on an established connection. Incremental sync probes the server with UID SEARCH instead.
      let nextUid: number;
      if (needInitial) {
        if (folder.uidvalidity !== null) {
          this.log.warn({ old: folder.uidvalidity, new: uidvalidity }, 'UIDVALIDITY changed, resetting folder');
          getDb().delete(schema.messages).where(eq(schema.messages.folderId, folder.id)).run();
        }
        nextUid = await this.initialSync(folder, uidvalidity, uidnext);
      } else {
        nextUid = await this.incrementalSync(folder, highestModseq);
      }

      getDb()
        .update(schema.folders)
        .set({ uidvalidity, uidnext: nextUid, highestModseq })
        .where(eq(schema.folders.id, folder.id))
        .run();
      const counts = updateFolderCounts(folder.id);
      getDb()
        .update(schema.accounts)
        .set({ lastSyncAt: Date.now(), status: 'connected', lastError: null, updatedAt: Date.now() })
        .where(eq(schema.accounts.id, this.accountId))
        .run();
      events.emit('account:status', { accountId: this.accountId, status: 'connected' });
      this.log.debug(counts, 'folder synced');
    } finally {
      lock.release();
      if (prevState === 'idle' || prevState === 'polling') this.setState(prevState);
    }
  }

  /** Returns the UIDNEXT to persist. */
  private async initialSync(folder: FolderRow, uidvalidity: number, serverUidnext: number): Promise<number> {
    const client = this.client!;
    this.setState('initial_sync');
    const acc = this.loadAccount();
    const since = new Date(Date.now() - acc.syncDays * 24 * 60 * 60 * 1000);

    this.log.info({ folder: folder.path, since }, 'initial sync started');
    getDb().update(schema.folders).set({ uidvalidity }).where(eq(schema.folders.id, folder.id)).run();

    let uids = (await client.search({ since }, { uid: true })) as number[] | false;
    if (!uids) uids = [];
    uids.sort((a, b) => b - a); // newest first

    const total = uids.length;
    let done = 0;
    events.emit('account:progress', { accountId: this.accountId, done, total });

    const maxUid = uids[0] ?? 0;
    for (let i = 0; i < uids.length; i += BATCH_SIZE) {
      if (this.stopping) return Math.max(serverUidnext, maxUid + 1);
      const batchUids = uids.slice(i, i + BATCH_SIZE);
      const parsed = await this.fetchEnvelopes(folder.id, batchUids);
      const inserted = upsertEnvelopes(parsed);
      done += batchUids.length;
      events.emit('account:progress', { accountId: this.accountId, done, total });
      if (inserted.length) {
        events.emit('message:new', { accountId: this.accountId, folderId: folder.id, specialUse: folder.specialUse, count: inserted.length, ids: inserted });
      }
    }
    this.log.info({ total }, 'initial sync finished');
    // SELECT just happened on a fresh connection, so serverUidnext is trustworthy here.
    return Math.max(serverUidnext, maxUid + 1, 1);
  }

  /** Returns the UIDNEXT to persist. */
  private async incrementalSync(folder: FolderRow, highestModseq: number | null): Promise<number> {
    const client = this.client!;
    const localUidnext = folder.uidnext ?? 1;
    let nextUid = localUidnext;

    // 1. New messages — probe with UID SEARCH; "N:*" also matches the newest message even if its UID < N, so filter.
    const probe = (await client.search({ uid: `${localUidnext}:*` }, { uid: true })) as number[] | false;
    const newUids = (probe || []).filter((u) => u >= localUidnext).sort((a, b) => a - b);
    this.log.debug({ localUidnext, newUids: newUids.length }, 'incremental probe');
    if (newUids.length) {
      const parsed = await this.fetchEnvelopes(folder.id, newUids);
      const inserted = upsertEnvelopes(parsed);
      nextUid = newUids[newUids.length - 1]! + 1;
      if (inserted.length) {
        this.log.info({ count: inserted.length }, 'new messages');
        events.emit('message:new', { accountId: this.accountId, folderId: folder.id, specialUse: folder.specialUse, count: inserted.length, ids: inserted });
      }
    }

    // 2. Flag changes (CONDSTORE if available, else compare recent 500)
    const db = getDb();
    const supportsCondstore = client.capabilities.has('CONDSTORE') && folder.highestModseq !== null && highestModseq !== null;
    const changedIds: number[] = [];

    const applyFlags = (uid: number, flags: Set<string>) => {
      const row = db
        .select({ id: schema.messages.id, seen: schema.messages.seen, flagged: schema.messages.flagged, answered: schema.messages.answered })
        .from(schema.messages)
        .where(and(eq(schema.messages.folderId, folder.id), eq(schema.messages.uid, uid)))
        .get();
      if (!row) return;
      const seen = flags.has('\\Seen') ? 1 : 0;
      const flagged = flags.has('\\Flagged') ? 1 : 0;
      const answered = flags.has('\\Answered') ? 1 : 0;
      if (row.seen !== seen || row.flagged !== flagged || row.answered !== answered) {
        db.update(schema.messages).set({ seen, flagged, answered }).where(eq(schema.messages.id, row.id)).run();
        changedIds.push(row.id);
      }
    };

    if (supportsCondstore && highestModseq! > folder.highestModseq!) {
      for await (const msg of client.fetch('1:*', { uid: true, flags: true }, { uid: true, changedSince: BigInt(folder.highestModseq!) })) {
        applyFlags(msg.uid, msg.flags ?? new Set());
      }
    } else if (!supportsCondstore) {
      const recent = db
        .select({ uid: schema.messages.uid })
        .from(schema.messages)
        .where(eq(schema.messages.folderId, folder.id))
        .orderBy(schema.messages.uid)
        .all()
        .map((r) => r.uid)
        .slice(-500);
      if (recent.length) {
        const range = `${recent[0]}:${recent[recent.length - 1]}`;
        for await (const msg of client.fetch(range, { uid: true, flags: true }, { uid: true })) {
          applyFlags(msg.uid, msg.flags ?? new Set());
        }
      }
    }

    // 3. Deletions: server UID set vs local
    const minLocal = db
      .select({ uid: schema.messages.uid })
      .from(schema.messages)
      .where(eq(schema.messages.folderId, folder.id))
      .orderBy(schema.messages.uid)
      .limit(1)
      .get()?.uid;
    if (minLocal !== undefined) {
      const serverUids = (await client.search({ uid: `${minLocal}:*` }, { uid: true })) as number[] | false;
      const localRows = db
        .select({ id: schema.messages.id, uid: schema.messages.uid })
        .from(schema.messages)
        .where(eq(schema.messages.folderId, folder.id))
        .all();
      // Guard against wiping the local cache on a bad/empty SEARCH reply (seen once in the wild:
      // a transient failure returned nothing and every local row was treated as deleted).
      // `false` = command failed; an empty list while the mailbox still has messages is equally suspect.
      const mailboxExists = client.mailbox ? client.mailbox.exists : 0;
      if (serverUids === false || (serverUids.length === 0 && mailboxExists > 0 && localRows.length > 0)) {
        this.log.warn({ folder: folder.path, mailboxExists, local: localRows.length, reply: serverUids === false ? 'false' : 'empty' }, 'deletion check skipped: implausible SEARCH reply');
        if (changedIds.length) events.emit('message:flags', { accountId: this.accountId, ids: changedIds });
        return nextUid;
      }
      const serverSet = new Set(serverUids);
      const gone = localRows.filter((r) => !serverSet.has(r.uid));
      // A second sanity check: mass removals (> 50 rows and > 50 %) are verified with a fresh
      // full SEARCH before anything is deleted.
      if (gone.length > 50 && gone.length > localRows.length / 2) {
        const recheck = (await client.search({ all: true }, { uid: true })) as number[] | false;
        if (!recheck || recheck.length === 0) {
          this.log.warn({ folder: folder.path, gone: gone.length }, 'deletion check skipped: mass removal not confirmed by re-check');
          if (changedIds.length) events.emit('message:flags', { accountId: this.accountId, ids: changedIds });
          return nextUid;
        }
        const confirmed = new Set(recheck);
        for (let i = gone.length - 1; i >= 0; i--) if (confirmed.has(gone[i]!.uid)) gone.splice(i, 1);
        this.log.warn({ folder: folder.path, gone: gone.length }, 'mass removal confirmed by re-check');
      }
      if (gone.length) {
        db.transaction((tx) => {
          for (const g of gone) tx.delete(schema.messages).where(eq(schema.messages.id, g.id)).run();
        });
        events.emit('message:removed', { accountId: this.accountId, ids: gone.map((g) => g.id) });
        this.log.info({ count: gone.length }, 'messages removed on server');
      }
    }

    if (changedIds.length) events.emit('message:flags', { accountId: this.accountId, ids: changedIds });
    return nextUid;
  }

  private async fetchEnvelopes(folderId: number, range: number[] | string): Promise<ParsedEnvelope[]> {
    const client = this.client!;
    const out: ParsedEnvelope[] = [];
    const isGmail = client.capabilities.has('X-GM-EXT-1');

    // First pass: envelope + structure.
    const raw: Array<{ msg: import('imapflow').FetchMessageObject; textPart?: string; textSize?: number }> = [];
    for await (const msg of client.fetch(
      range,
      { uid: true, flags: true, internalDate: true, size: true, envelope: true, bodyStructure: true, ...(isGmail ? { threadId: true } : {}) },
      { uid: true },
    )) {
      raw.push({ msg });
    }

    // Second pass: small snippets from text/plain parts (one FETCH per message keeps it simple & safe).
    for (const item of raw) {
      let snippet: string | null = null;
      const struct = item.msg.bodyStructure;
      const textNode = struct ? findTextPlain(struct) : null;
      if (textNode?.part && (textNode.size ?? 0) <= SNIPPET_MAX_PART_SIZE && (textNode.size ?? 0) > 0) {
        try {
          const res = await client.fetchOne(String(item.msg.uid), { bodyParts: [`${textNode.part}`] }, { uid: true });
          const part = res ? res.bodyParts?.get(textNode.part) : undefined;
          if (part) snippet = makeSnippet(decodePart(part, textNode));
        } catch (err) {
          this.log.debug({ err, uid: item.msg.uid }, 'snippet fetch failed');
        }
      }
      out.push(parseFetchedMessage(this.accountId, folderId, item.msg, snippet));
    }
    return out;
  }

  // ─────────────────────────── idle / sleep ───────────────────────────

  private async idleUntilEvent(): Promise<void> {
    const client = this.client!;
    const fallback = this.preset.idleProbeMs ?? IDLE_PROBE_MS;
    let resolved = false;

    await new Promise<void>((resolve) => {
      const finish = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve();
      };
      const onExists = () => { this.log.debug('idle: EXISTS'); finish(); };
      const onExpunge = () => { this.log.debug('idle: EXPUNGE'); finish(); };
      const onFlags = () => { this.log.debug('idle: FLAGS'); finish(); };
      client.on('exists', onExists);
      client.on('expunge', onExpunge);
      client.on('flags', onFlags);
      this.wake = finish;
      this.timer = setTimeout(finish, fallback);

      const cleanup = () => {
        client.off('exists', onExists);
        client.off('expunge', onExpunge);
        client.off('flags', onFlags);
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.wake = null;
      };

      client.idle().then(() => finish()).catch((err) => {
        this.log.debug({ err }, 'idle failed, switching to polling');
        this.idleBroken = true;
        finish();
      });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.wake = null;
        resolve();
      };
      this.timer = setTimeout(() => {
        this.timer = null;
        this.wake = null;
        resolve();
      }, ms);
    });
  }

  // ─────────────────────────── status ───────────────────────────

  private setState(s: WorkerState): void {
    this.state = s;
    this.log.trace({ state: s }, 'state');
  }

  private persistStatus(status: AccountStatus, error: string | null): void {
    getDb()
      .update(schema.accounts)
      .set({ status, lastError: error, updatedAt: Date.now() })
      .where(eq(schema.accounts.id, this.accountId))
      .run();
    events.emit('account:status', { accountId: this.accountId, status, ...(error ? { error } : {}) });
  }
}

// ─────────────────────────── helpers ───────────────────────────

function findTextPlain(node: import('imapflow').MessageStructureObject): import('imapflow').MessageStructureObject | null {
  const type = (node.type ?? '').toLowerCase();
  if (type === 'text/plain' && (node.disposition ?? '').toLowerCase() !== 'attachment') return node;
  for (const child of node.childNodes ?? []) {
    const found = findTextPlain(child);
    if (found) return found;
  }
  return null;
}

function decodePart(buf: Buffer, node: import('imapflow').MessageStructureObject): string {
  const encoding = (node.encoding ?? '').toLowerCase();
  const charset = ((node.parameters?.charset as string | undefined) ?? 'utf-8').toLowerCase();
  let bytes = buf;
  if (encoding === 'base64') {
    bytes = Buffer.from(buf.toString('ascii').replace(/\s+/g, ''), 'base64');
  } else if (encoding === 'quoted-printable') {
    bytes = Buffer.from(
      buf
        .toString('ascii')
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
      'latin1',
    );
  }
  try {
    return new TextDecoder(charset === 'gb2312' ? 'gbk' : charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}
