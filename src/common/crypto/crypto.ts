import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Algorithm, hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password, { algorithm: Algorithm.Argon2id });
  } catch {
    return false;
  }
}

/**
 * Transaction PINs are low entropy. They are first HMAC-peppered with a server-side secret
 * and then Argon2id hashed, so database leakage alone is not sufficient for an offline attack.
 */
export function pepperPin(pin: string, pepper: string): string {
  return createHmac('sha256', pepper).update(pin, 'utf8').digest('base64url');
}

export async function hashPin(pin: string, pepper: string): Promise<string> {
  return argonHash(pepperPin(pin, pepper), ARGON2_OPTIONS);
}

export async function verifyPin(hash: string, pin: string, pepper: string): Promise<boolean> {
  try {
    return await argonVerify(hash, pepperPin(pin, pepper), { algorithm: Algorithm.Argon2id });
  } catch {
    return false;
  }
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256(value: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function generateSecureToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashIpAddress(ip: string | undefined, secret: string): string | null {
  if (!ip) return null;
  return createHmac('sha256', secret).update(ip).digest('hex');
}

export interface EncryptedValue {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function encryptSecret(plaintext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(encrypted: string, hexKey: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = encrypted.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('Malformed encrypted secret');
  }
  const key = Buffer.from(hexKey, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Stable JSON stringification with sorted object keys for idempotency fingerprints. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}
