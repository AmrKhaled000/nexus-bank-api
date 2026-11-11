import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode } from '../../common/errors/app-error';

const SIGNATURE_PATTERN = /^t=(\d{10,13}),v1=([a-f0-9]{64})$/i;

export function signWebhookPayload(rawBody: Buffer | string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

/**
 * Verifies `X-Nexus-Signature: t=<unix seconds>,v1=<hex hmac>` with replay tolerance.
 * Comparison is constant-time; a malformed header and a wrong digest are indistinguishable.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  toleranceSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  const match = header?.match(SIGNATURE_PATTERN);
  if (!match) {
    throw AppError.unauthorized(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Webhook signature is missing or malformed');
  }
  const timestamp = Number(match[1]);
  const provided = match[2]!.toLowerCase();
  const age = Math.abs(nowSeconds - timestamp);
  if (!Number.isFinite(timestamp) || age > toleranceSeconds) {
    throw AppError.unauthorized(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Webhook timestamp is outside the tolerance window');
  }
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest('hex');
  const left = Buffer.from(provided, 'hex');
  const right = Buffer.from(expected, 'hex');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw AppError.unauthorized(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Webhook signature verification failed');
  }
}
