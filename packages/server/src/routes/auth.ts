import type { FastifyInstance } from 'fastify';
import type { AuthStatus } from '@inbox/shared';
import { credentialsSchema } from '@inbox/shared';
import { config } from '../config';
import { AppError } from '../errors';
import {
  SESSION_COOKIE,
  authenticate,
  createSession,
  createUser,
  destroySession,
  userCount,
} from '../auth';

export async function authRoutes(app: FastifyInstance) {
  app.get('/auth/status', async (req): Promise<AuthStatus> => ({
    needsSetup: userCount() === 0,
    authenticated: !!req.user,
    username: req.user?.username ?? null,
  }));

  app.post('/auth/setup', async (req, reply) => {
    if (userCount() > 0) throw new AppError('CONFLICT', '已存在用户，请直接登录');
    const body = credentialsSchema.parse(req.body);
    const id = await createUser(body.username, body.password);
    const s = createSession(id);
    setCookie(reply, s.token, s.expiresAt);
    return { ok: true };
  });

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = credentialsSchema.parse(req.body);
      const user = await authenticate(body.username, body.password);
      if (!user) throw new AppError('UNAUTHORIZED', '用户名或密码错误');
      const s = createSession(user.id);
      setCookie(reply, s.token, s.expiresAt);
      return { ok: true };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}

function setCookie(reply: import('fastify').FastifyReply, token: string, expiresAt: number) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.isProd && config.BASE_URL.startsWith('https://'),
    expires: new Date(expiresAt),
  });
}
