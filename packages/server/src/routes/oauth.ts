import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  oauthCompleteSchema,
  oauthConfigSchema,
  oauthProviderSchema,
  oauthStartSchema,
  type OAuthConfigInfo,
  type OAuthPendingStatus,
  type OAuthStartResult,
} from '@inbox/shared';
import { AppError } from '../errors';
import { completeAuthorization, configInfo, parseRedirectUrl, pendingStatus, saveClientConfig, startAuthorization } from '../oauth';
import { syncManager } from '../sync/SyncManager';
import { getDb, schema } from '../db';
import { eq } from 'drizzle-orm';

const providerParam = z.object({ provider: oauthProviderSchema });

/** Authenticated API surface (mounted under /api). */
export async function oauthApiRoutes(app: FastifyInstance) {
  app.get('/oauth/:provider/config', async (req): Promise<OAuthConfigInfo> => {
    const { provider } = providerParam.parse(req.params);
    return configInfo(provider);
  });

  app.put('/oauth/:provider/config', async (req): Promise<OAuthConfigInfo> => {
    const { provider } = providerParam.parse(req.params);
    const body = oauthConfigSchema.parse(req.body);
    saveClientConfig(provider, body);
    return configInfo(provider);
  });

  app.get('/oauth/:provider/start', async (req): Promise<OAuthStartResult> => {
    const { provider } = providerParam.parse(req.params);
    const q = oauthStartSchema.parse(req.query);
    if (q.accountId) {
      const acc = getDb().select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.id, q.accountId)).get();
      if (!acc) throw new AppError('NOT_FOUND', '账户不存在');
    }
    return startAuthorization(provider, { name: q.name, color: q.color, accountId: q.accountId });
  });

  /** Manual completion: the browser landed on a redirect URI we don't serve (e.g. localhost). */
  app.post('/oauth/:provider/complete', async (req) => {
    providerParam.parse(req.params);
    const body = oauthCompleteSchema.parse(req.body);
    const { code, state } = body.url ? parseRedirectUrl(body.url) : { code: body.code, state: body.state };
    if (!code || !state) throw new AppError('VALIDATION', '需要 url 或 code + state');
    const accountId = await completeAuthorization(state, code);
    syncManager.restartAccount(accountId);
    return { ok: true, accountId };
  });

  app.get('/oauth/status', async (req): Promise<OAuthPendingStatus> => {
    const { state } = z.object({ state: z.string().min(1).max(200) }).parse(req.query);
    return pendingStatus(state);
  });
}

/** Public callback (no /api prefix, no session): the provider redirects the browser here. */
export async function oauthCallbackRoutes(app: FastifyInstance) {
  app.get('/oauth/:provider/callback', async (req, reply) => {
    providerParam.parse(req.params);
    const q = req.query as Record<string, string | undefined>;
    if (q.error) {
      return reply.redirect(`/?oauth=error&message=${encodeURIComponent(`${q.error}: ${q.error_description ?? ''}`)}`);
    }
    if (!q.code || !q.state) {
      return reply.redirect('/?oauth=error&message=' + encodeURIComponent('缺少 code/state'));
    }
    try {
      const accountId = await completeAuthorization(q.state, q.code);
      syncManager.restartAccount(accountId);
      return reply.redirect(`/?oauth=done&account=${accountId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.redirect(`/?oauth=error&message=${encodeURIComponent(msg)}`);
    }
  });
}
