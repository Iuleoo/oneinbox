import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface Encrypted {
  enc: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export class Cipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error(`Master key must be ${KEY_BYTES} bytes`);
    this.key = key;
  }

  encrypt(plain: string): Encrypted {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { enc, iv, tag };
  }

  decrypt(data: Encrypted): string {
    const decipher = crypto.createDecipheriv(ALGO, this.key, data.iv);
    decipher.setAuthTag(data.tag);
    const plain = Buffer.concat([decipher.update(data.enc), decipher.final()]);
    return plain.toString('utf8');
  }
}

export interface LoadKeyOptions {
  /** 64-char hex string from env; takes precedence. */
  envKey?: string;
  /** Directory holding master.key. */
  dataDir: string;
  /** Called when a brand-new key was generated so the operator can be warned. */
  onGenerated?: (file: string) => void;
}

/**
 * Resolve the master key: env var → data/master.key → generate new.
 */
export function loadMasterKey(opts: LoadKeyOptions): Buffer {
  if (opts.envKey) {
    const buf = Buffer.from(opts.envKey, 'hex');
    if (buf.length !== KEY_BYTES) throw new Error('MASTER_KEY must decode to 32 bytes');
    return buf;
  }

  const file = path.join(opts.dataDir, 'master.key');
  if (fs.existsSync(file)) {
    const hex = fs.readFileSync(file, 'utf8').trim();
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== KEY_BYTES) throw new Error(`${file} is corrupt (expected 64 hex chars)`);
    return buf;
  }

  fs.mkdirSync(opts.dataDir, { recursive: true });
  const buf = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(file, buf.toString('hex') + '\n', { mode: 0o600 });
  opts.onGenerated?.(file);
  return buf;
}

let instance: Cipher | null = null;

export function initCipher(key: Buffer): Cipher {
  instance = new Cipher(key);
  return instance;
}

export function getCipher(): Cipher {
  if (!instance) throw new Error('Cipher not initialised');
  return instance;
}
