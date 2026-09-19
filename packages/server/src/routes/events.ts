import type { FastifyInstance } from 'fastify';
import { events, type EventName } from '../events';

export async function eventRoutes(app: FastifyInstance) {
  app.get('/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const send = (name: EventName, payload: unknown) => {
      reply.raw.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const off = events.onAny(send);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);

    const close = () => {
      clearInterval(ping);
      off();
    };
    req.raw.on('close', close);
    req.raw.on('error', close);

    // Keep the handler alive; the reply is hijacked so Fastify won't send anything itself.
    await new Promise<void>((resolve) => req.raw.on('close', () => resolve()));
  });
}
