import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { SESSION_COOKIE, resolveSession } from './index';
import { unauthorized } from '../errors';

declare module 'fastify' {
  interface FastifyRequest {
    user: { userId: number; username: string } | null;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** Public routes that never require a session. */
const PUBLIC_PREFIXES = ['/api/auth/status', '/api/auth/login', '/api/auth/setup', '/healthz'];

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    req.user = token ? resolveSession(token) : null;
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (req.user) return;
    if (PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) return;
    throw unauthorized();
  });
});
