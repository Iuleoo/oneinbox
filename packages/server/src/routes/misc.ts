import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { HealthStatus, ProviderInfo } from '@inbox/shared';
import { getDb, schema } from '../db';
import { PROVIDERS, toProviderInfo } from '../providers';
import { loadClientConfig } from '../oauth';

export async function providerRoutes(app: FastifyInstance) {
  app.get('/providers', async (): Promise<ProviderInfo[]> =>
    Object.values(PROVIDERS).map((p) => toProviderInfo(p, p.oauth ? !!loadClientConfig(p.oauth.kind) : false)),
  );
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async (): Promise<HealthStatus> => {
    const rows = getDb()
      .select({ status: schema.accounts.status, n: sql<number>`count(*)` })
      .from(schema.accounts)
      .groupBy(schema.accounts.status)
      .all();
    const by = new Map(rows.map((r) => [r.status, r.n]));
    const total = rows.reduce((a, r) => a + r.n, 0);
    return {
      ok: true,
      accounts: { total, connected: by.get('connected') ?? 0, error: by.get('error') ?? 0 },
    };
  });
}
