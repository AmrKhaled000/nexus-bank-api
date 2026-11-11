import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('A valid email address is required')
  .max(254);

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((value) => /[a-z]/.test(value), 'Password must contain a lowercase letter')
  .refine((value) => /[A-Z]/.test(value), 'Password must contain an uppercase letter')
  .refine((value) => /\d/.test(value), 'Password must contain a digit')
  .refine((value) => /[^A-Za-z0-9]/.test(value), 'Password must contain a symbol');

export const nameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(100, 'Name must be at most 100 characters')
  .regex(/^[\p{L}\p{M}][\p{L}\p{M}\s'.-]*$/u, 'Name contains unsupported characters');

export const pinSchema = z
  .string()
  .regex(/^\d{6}$/, 'PIN must be exactly 6 digits')
  .refine((pin) => !/^(\d)\1{5}$/.test(pin), 'PIN cannot be a repeated digit')
  .refine(
    (pin) =>
      !['012345', '123456', '234567', '345678', '456789', '987654', '876543', '765432', '654321', '543210'].includes(
        pin,
      ),
    'PIN cannot be a sequential pattern',
  );

export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Authenticator code must be 6 digits');

export const otpTokenSchema = z.string().trim().min(32).max(200);

export const idParamSchema = z.object({
  id: z.string().cuid('Invalid identifier'),
});

export const idempotencyKeyHeaderSchema = z
  .string()
  .trim()
  .min(8, 'Idempotency-Key must be at least 8 characters')
  .max(128, 'Idempotency-Key must be at most 128 characters')
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key contains unsupported characters');

/* eslint-disable no-control-regex -- these patterns intentionally reject control characters in user input */
export const reasonSchema = z
  .string()
  .trim()
  .min(3)
  .max(500)
  .regex(/^[^\u0000-\u001f\u007f]*$/, 'Reason contains control characters');

export const deviceNameSchema = z.string().trim().min(1).max(100).optional();

export const safeTextSchema = (max = 255) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/, 'Text contains control characters');
/* eslint-enable no-control-regex */
