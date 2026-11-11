import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/app-error';
import { signWebhookPayload, verifyWebhookSignature } from '../../src/infrastructure/payments/webhook-signature';

const SECRET = 'unit-test-webhook-secret-at-least-32-bytes';
const BODY = Buffer.from(JSON.stringify({ id: 'evt_test_123', type: 'deposit.completed' }));
const NOW = 1_700_000_000;

function headerFor(timestamp: number, secret = SECRET, body: Buffer | string = BODY): string {
  return signWebhookPayload(body, secret, timestamp);
}

describe('signWebhookPayload', () => {
  it('produces the expected t=...,v1=... envelope', () => {
    expect(headerFor(NOW)).toMatch(/^t=\d{10,13},v1=[a-f0-9]{64}$/);
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed payload', () => {
    expect(() => verifyWebhookSignature(BODY, headerFor(NOW), SECRET, 300, NOW)).not.toThrow();
  });

  it('accepts a webhook signed over a string body', () => {
    const body = BODY.toString('utf8');
    expect(() => verifyWebhookSignature(body, headerFor(NOW, SECRET, body), SECRET, 300, NOW)).not.toThrow();
  });

  it('accepts timestamps exactly at the tolerance boundary', () => {
    expect(() => verifyWebhookSignature(BODY, headerFor(NOW - 300), SECRET, 300, NOW)).not.toThrow();
    expect(() => verifyWebhookSignature(BODY, headerFor(NOW + 300), SECRET, 300, NOW)).not.toThrow();
  });

  it('rejects stale timestamps outside the tolerance window', () => {
    expect(() => verifyWebhookSignature(BODY, headerFor(NOW - 301), SECRET, 300, NOW)).toThrow(AppError);
    expect(() => verifyWebhookSignature(BODY, headerFor(NOW + 301), SECRET, 300, NOW)).toThrow(AppError);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ id: 'evt_test_123', type: 'deposit.failed' }));
    expect(() => verifyWebhookSignature(tampered, headerFor(NOW), SECRET, 300, NOW)).toThrow(
      /signature verification failed/i,
    );
  });

  it('rejects the wrong secret', () => {
    expect(() => verifyWebhookSignature(BODY, headerFor(NOW, 'different-unit-test-secret-at-least-32-bytes'), SECRET, 300, NOW)).toThrow(
      /signature verification failed/i,
    );
  });

  it('rejects missing or malformed signature headers with the same error', () => {
    const malformed = [
      undefined,
      '',
      't=1700000000',
      'v1=' + 'a'.repeat(64),
      't=notanumber,v1=' + 'a'.repeat(64),
      't=170000000,v1=' + 'a'.repeat(64),
      't=1700000000,v1=' + 'g'.repeat(64),
      't=1700000000;v1=' + 'a'.repeat(64),
    ];
    for (const header of malformed) {
      try {
        verifyWebhookSignature(BODY, header, SECRET, 300, NOW);
        throw new Error(`expected ${JSON.stringify(header)} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('WEBHOOK_SIGNATURE_INVALID');
        expect((error as AppError).statusCode).toBe(401);
      }
    }
  });

  it('does not leak which failure occurred (missing vs mismatch)', () => {
    const errors: string[] = [];
    for (const header of [undefined, headerFor(NOW, 'different-unit-test-secret-at-least-32-bytes')]) {
      try {
        verifyWebhookSignature(BODY, header, SECRET, 300, NOW);
      } catch (error) {
        errors.push((error as AppError).message);
      }
    }
    expect(errors).toHaveLength(2);
  });
});
