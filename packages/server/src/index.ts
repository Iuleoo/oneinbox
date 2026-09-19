import fs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { config } from './config';
import { logger } from './logger';
import { closeDb, openDb } from './db';
import { initCipher, loadMasterKey } from './crypto';
import { ensureInitialUser, purgeExpiredSessions } from './auth';
import { authPlugin } from './auth/plugin';
import { AppError } from './errors';
import { authRoutes } from './routes/auth';
import { accountRoutes } from './routes/accounts';
import { healthRoutes, providerRoutes } from './routes/misc';
import { eventRoutes } from './routes/events';
import { messageRoutes } from './routes/messages';
import { searchRoutes } from './routes/search';
import { settingsRoutes } from './routes/settings';
import { oauthApiRoutes, oauthCallbackRoutes } from './routes/oauth';
import { pruneBodyCache } from './sync/BodyCache';
import { syncManager } from './sync/SyncManager';

async function main() {
  // ── storage & secrets ──
  fs.mkdirSync(config.dataDir, { recursive: true });
  const key = loadMasterKey({
    envKey: config.MASTER_KEY,
    dataDir: config.dataDir,
    onGenerated: (file) =>
      logger.warn(
        `\n${'='.repeat(72)}\n  A new MASTER_KEY was generated at:\n  ${file}\n  BACK IT UP NOW. Losing it makes all stored mailbox credentials unrecoverable.\n${'='.repeat(72)}`,
      ),
  });
  initCipher(key);
  openDb();
  const init = await ensureInitialUser();
  if (init === 'created') logger.info({ username: config.INIT_USERNAME }, 'initial user created');
  if (init === 'skipped') logger.info('no user yet — open /setup in the browser to create one');

  // ── http ──
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      reply.code(err.status).send(err.toJSON());
      return;
    }
    if (err instanceof ZodError) {
      const msg = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      reply.code(400).send({ error: { code: 'VALIDATION', message: msg } });
      return;
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 429) {
      reply.code(429).send({ error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' } });
      return;
    }
    if (e.statusCode && e.statusCode < 500) {
      reply.code(e.statusCode).send({ error: { code: 'VALIDATION', message: e.message ?? 'Bad request' } });
      return;
    }
    logger.error({ err, url: req.url }, 'unhandled error');
    reply.code(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }
    // SPA fallback
    if (fs.existsSync(config.webDist)) {
      reply.sendFile('index.html');
      return;
    }
    reply.code(404).type('text/plain').send('Web UI not built. Run `pnpm build` or use the Vite dev server.');
  });

  await app.register(healthRoutes);
  await app.register(oauthCallbackRoutes);
  await app.register(
    async (api) => {
      api.addHook('onRequest', api.requireAuth);
      await api.register(authRoutes);
      await api.register(accountRoutes);
      await api.register(providerRoutes);
      await api.register(messageRoutes);
      await api.register(searchRoutes);
      await api.register(settingsRoutes);
      await api.register(oauthApiRoutes);
      await api.register(eventRoutes);
    },
    { prefix: '/api' },
  );

  if (fs.existsSync(config.webDist)) {
    // wildcard: true serves files dynamically (new asset hashes after a rebuild); misses fall through to the SPA handler.
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', wildcard: true, index: ['index.html'], maxAge: '1h', immutable: false });
    logger.info({ dir: config.webDist }, 'serving web UI');
  } else {
    logger.info({ dir: config.webDist }, 'web dist not found; API only');
  }

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, baseUrl: config.BASE_URL }, 'server listening');

  // ── background ──
  syncManager.startAll();
  const sessionTimer = setInterval(() => {
    const n = purgeExpiredSessions();
    if (n) logger.debug({ n }, 'purged expired sessions');
  }, 60 * 60 * 1000);
  const pruneSafe = () => {
    try {
      pruneBodyCache();
    } catch (err) {
      logger.warn({ err }, 'body cache prune failed');
    }
  };
  const pruneTimer = setInterval(pruneSafe, 6 * 60 * 60 * 1000);
  setTimeout(pruneSafe, 60 * 1000).unref();

  // ── shutdown ──
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(sessionTimer);
    clearInterval(pruneTimer);
    const timeout = setTimeout(() => {
      logger.warn('forced exit');
      process.exit(1);
    }, 8000);
    try {
      await app.close();
      await syncManager.stopAll();
      closeDb();
    } finally {
      clearTimeout(timeout);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
