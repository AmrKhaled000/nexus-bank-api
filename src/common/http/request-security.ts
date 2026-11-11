import type { Request } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode } from '../errors/app-error';
import { idempotencyKeyHeaderSchema } from '../validation/schemas';
import { sha256, stableStringify } from '../crypto/crypto';

export function getIdempotencyKey(req: Request): string {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    throw new AppError(
      ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      'Idempotency-Key header is required for this financial operation',
      400,
    );
  }
  const parsed = idempotencyKeyHeaderSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(ErrorCode.IDEMPOTENCY_KEY_INVALID, 'Idempotency-Key header is invalid', 400, {
      details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}

/**
 * Fingerprints the semantic request payload. Secrets such as PINs and TOTP codes are excluded
 * so that a repeated request can be replayed without persisting PIN-derived material.
 */
export function fingerprintRequest(scope: string, body: unknown): string {
  const cloned = structuredClone(body ?? {});
  if (cloned && typeof cloned === 'object') {
    for (const key of ['pin', 'currentPin', 'newPin', 'totpCode', 'code', 'password']) {
      delete (cloned as Record<string, unknown>)[key];
    }
  }
  return sha256(`${scope}:${stableStringify(cloned)}`);
}

export function getAdminConfirmation(req: Request, expected: string): void {
  const raw = req.headers['x-admin-confirmation'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value !== expected) {
    throw new AppError(
      ErrorCode.CONFIRMATION_REQUIRED,
      `Administrative confirmation header X-Admin-Confirmation must equal "${expected}"`,
      428,
    );
  }
}

export function getReason(body: unknown): string {
  const parsed = z
    .object({ reason: z.string().trim().min(3).max(500) })
    .safeParse(body);
  if (!parsed.success) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'A reason is required for this operation', 400);
  }
  return parsed.data.reason;
}
