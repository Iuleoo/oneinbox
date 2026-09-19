import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cipher, loadMasterKey } from './index';

describe('Cipher', () => {
  const key = crypto.randomBytes(32);
  const cipher = new Cipher(key);

  it('round-trips utf8 text', () => {
    const plain = '授权码 abcd1234 🔐';
    const enc = cipher.encrypt(plain);
    expect(enc.iv.length).toBe(12);
    expect(enc.tag.length).toBe(16);
    expect(cipher.decrypt(enc)).toBe(plain);
  });

  it('uses a fresh IV per call', () => {
    const a = cipher.encrypt('same');
    const b = cipher.encrypt('same');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.enc.equals(b.enc)).toBe(false);
  });

  it('rejects tampered ciphertext', () => {
    const enc = cipher.encrypt('hello');
    enc.enc[0] = enc.enc[0]! ^ 0xff;
    expect(() => cipher.decrypt(enc)).toThrow();
  });

  it('rejects wrong key', () => {
    const enc = cipher.encrypt('hello');
    const other = new Cipher(crypto.randomBytes(32));
    expect(() => other.decrypt(enc)).toThrow();
  });

  it('rejects wrong key length', () => {
    expect(() => new Cipher(Buffer.alloc(16))).toThrow();
  });
});

describe('loadMasterKey', () => {
  it('prefers env key', () => {
    const hex = crypto.randomBytes(32).toString('hex');
    const key = loadMasterKey({ envKey: hex, dataDir: os.tmpdir() });
    expect(key.toString('hex')).toBe(hex);
  });

  it('generates, persists and reloads a key file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-key-'));
    let generated: string | null = null;
    const k1 = loadMasterKey({ dataDir: dir, onGenerated: (f) => (generated = f) });
    expect(generated).toBe(path.join(dir, 'master.key'));
    const k2 = loadMasterKey({ dataDir: dir });
    expect(k1.equals(k2)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects invalid env key', () => {
    expect(() => loadMasterKey({ envKey: 'abcd', dataDir: os.tmpdir() })).toThrow();
  });
});
