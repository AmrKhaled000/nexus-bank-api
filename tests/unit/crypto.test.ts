import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  generateSecureToken,
  hashIpAddress,
  hashPassword,
  hashPin,
  hmacSha256,
  pepperPin,
  sha256,
  stableStringify,
  verifyPassword,
  verifyPin,
} from '../../src/common/crypto/crypto';

const PEPPER = 'unit-test-pepper-that-is-at-least-thirty-two-bytes';
const ENCRYPTION_KEY = 'aa'.repeat(32);

describe('password hashing', () => {
  it('verifies the correct password with Argon2id', async () => {
    const hash = await hashPassword('Correct-Horse-Battery-Staple#1');
    expect(hash).toContain('argon2id');
    expect(await verifyPassword(hash, 'Correct-Horse-Battery-Staple#1')).toBe(true);
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  });

  it('produces different salts for identical passwords', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password-123!'), hashPassword('same-password-123!')]);
    expect(a).not.toBe(b);
  });

  it('fails closed on malformed hashes instead of throwing', async () => {
    expect(await verifyPassword('not-a-valid-hash', 'whatever')).toBe(false);
  });
});

describe('transaction PIN hashing', () => {
  it('peppers before hashing and verifies with the same pepper', async () => {
    const peppered = pepperPin('246810', PEPPER);
    expect(peppered).not.toContain('246810');
    expect(pepperPin('246810', PEPPER)).toBe(peppered); // deterministic

    const hash = await hashPin('246810', PEPPER);
    expect(await verifyPin(hash, '246810', PEPPER)).toBe(true);
    expect(await verifyPin(hash, '135790', PEPPER)).toBe(false);
    expect(await verifyPin(hash, '246810', 'different-pepper-that-is-at-least-32-bytes')).toBe(false);
  });
});

describe('digests and comparisons', () => {
  it('computes SHA-256', () => {
    expect(sha256('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('computes HMAC-SHA256 (RFC 4231 test case 2)', () => {
    expect(hmacSha256('what do ya want for nothing?', 'Jefe')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('compares values in constant time for equal-length inputs', () => {
    expect(constantTimeEqual('same-value', 'same-value')).toBe(true);
    expect(constantTimeEqual('same-value', 'diff-value')).toBe(false);
    expect(constantTimeEqual('short', 'much-longer-value')).toBe(false);
  });

  it('hashes IP addresses consistently and rejects missing input', () => {
    expect(hashIpAddress(undefined, 'secret')).toBeNull();
    const a = hashIpAddress('203.0.113.10', 'secret');
    const b = hashIpAddress('203.0.113.10', 'secret');
    const c = hashIpAddress('203.0.113.10', 'other-secret');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('generates high-entropy unique tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSecureToken(32)));
    expect(tokens.size).toBe(200);
    expect(generateSecureToken(32)).toHaveLength(43);
  });
});

describe('secret encryption', () => {
  it('round-trips AES-256-GCM ciphertext', () => {
    const ciphertext = encryptSecret('totp-secret-value', ENCRYPTION_KEY);
    expect(ciphertext.startsWith('v1.')).toBe(true);
    expect(ciphertext).not.toContain('totp-secret-value');
    expect(decryptSecret(ciphertext, ENCRYPTION_KEY)).toBe('totp-secret-value');
  });

  it('rejects tampered ciphertext and wrong keys', () => {
    const ciphertext = encryptSecret('sensitive', ENCRYPTION_KEY);
    expect(() => decryptSecret(ciphertext, 'bb'.repeat(32))).toThrow();

    const [version, iv, tag, body] = ciphertext.split('.');
    const tampered = [version, iv, tag, `${body!.slice(0, -1)}${body!.endsWith('A') ? 'B' : 'A'}`].join('.');
    expect(() => decryptSecret(tampered, ENCRYPTION_KEY)).toThrow();
  });

  it('rejects malformed encrypted values', () => {
    expect(() => decryptSecret('v2.invalid', ENCRYPTION_KEY)).toThrow(/Malformed/);
    expect(() => decryptSecret('', ENCRYPTION_KEY)).toThrow(/Malformed/);
  });
});

describe('stableStringify', () => {
  it('serializes objects with sorted keys regardless of insertion order', () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('omits undefined object properties but keeps them in arrays', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify([undefined, 1])).toBe('[null,1]');
  });
});

describe('HMAC signatures used for webhooks', () => {
  it('is deterministic and secret-dependent', () => {
    const value = '1700000000.payload';
    expect(createHmac('sha256', 's').update(value).digest('hex')).toBe(hmacSha256(value, 's'));
  });
});
