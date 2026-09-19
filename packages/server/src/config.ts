import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Walk up from cwd looking for a .env file; returns its directory or null. */
function findEnvDir(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, '.env'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const envDir = findEnvDir(process.cwd());
if (envDir) dotenv.config({ path: path.join(envDir, '.env') });

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./data'),
  MASTER_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'MASTER_KEY must be 64 hex characters (32 bytes)')
      .optional(),
  ),
  BASE_URL: z.string().url().default('http://localhost:8080'),
  INIT_USERNAME: z.preprocess(emptyToUndefined, z.string().min(1).max(64).optional()),
  INIT_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(1).max(256).optional()),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** Outbound proxy for providers listed in PROXY_FOR, e.g. http://proxy.lan:7890 or socks5://proxy.lan:1080 */
  PROXY_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  /** Comma-separated provider ids that must go through PROXY_URL. Default: gmail. */
  PROXY_FOR: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Directory of the built web app to serve statically. Optional. */
  WEB_DIST: z.preprocess(emptyToUndefined, z.string().optional()),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const raw = parsed.data;
const baseDir = envDir ?? process.cwd();

export const config = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  dataDir: path.isAbsolute(raw.DATA_DIR) ? raw.DATA_DIR : path.resolve(baseDir, raw.DATA_DIR),
  webDist: raw.WEB_DIST
    ? path.resolve(baseDir, raw.WEB_DIST)
    : path.resolve(baseDir, 'packages/web/dist'),
  sessionTtlMs: raw.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
} as const;

export type Config = typeof config;
