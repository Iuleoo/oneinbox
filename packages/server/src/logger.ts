import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { config } from './config';

/**
 * Logs go to stdout (docker logs) and, in production, also to DATA_DIR/logs/app.log so that
 * history survives container re-creation on deploy. When the file exceeds 50 MB it is rotated
 * once to app.prev.log at startup (enough for a single-user box).
 */
function fileDestination(): pino.DestinationStream | null {
  if (!config.isProd) return null;
  try {
    const dir = path.join(config.dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'app.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 50 * 1024 * 1024) {
      fs.renameSync(file, path.join(dir, 'app.prev.log'));
    }
    return pino.destination({ dest: file, sync: false, mkdir: true });
  } catch {
    return null;
  }
}

const redact = {
  paths: ['*.secret', '*.pass', '*.password', '*.accessToken', 'req.headers.cookie'],
  censor: '[redacted]',
};

const file = fileDestination();

export const logger = config.isProd
  ? pino({ level: config.LOG_LEVEL, redact }, file ? pino.multistream([{ stream: process.stdout }, { stream: file }]) : process.stdout)
  : pino({
      level: config.LOG_LEVEL,
      redact,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    });

export type Logger = typeof logger;
