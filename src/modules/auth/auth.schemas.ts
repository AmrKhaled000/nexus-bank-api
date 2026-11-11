import { z } from 'zod';
import {
  emailSchema,
  idempotencyKeyHeaderSchema,
  nameSchema,
  otpTokenSchema,
  passwordSchema,
  pinSchema,
  reasonSchema,
  safeTextSchema,
  totpCodeSchema,
} from '../../common/validation/schemas';

export const registerSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(128),
    deviceName: safeTextSchema(100).optional(),
  })
  .strict();

export const verifyEmailSchema = z.object({ token: otpTokenSchema }).strict();
export const resendVerificationSchema = z.object({ email: emailSchema }).strict();
export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z
  .object({
    token: otpTokenSchema,
    newPassword: passwordSchema,
  })
  .strict();

export const refreshSchema = z
  .object({
    refreshToken: z.string().min(32).max(500).optional(),
  })
  .strict()
  .optional();

export const verifyTwoFactorSchema = z
  .object({
    mfaToken: z.string().min(32).max(2_000),
    code: totpCodeSchema,
    deviceName: safeTextSchema(100).optional(),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: passwordSchema,
  })
  .strict();

export const setupTwoFactorSchema = z.object({ password: z.string().min(1).max(128) }).strict();
export const enableTwoFactorSchema = z.object({ code: totpCodeSchema }).strict();
export const disableTwoFactorSchema = z
  .object({ password: z.string().min(1).max(128), code: totpCodeSchema })
  .strict();

export const setPinSchema = z
  .object({ password: z.string().min(1).max(128), pin: pinSchema })
  .strict();

export const changePinSchema = z
  .object({
    password: z.string().min(1).max(128),
    currentPin: pinSchema,
    newPin: pinSchema,
  })
  .strict();

export const idempotencyHeader = z.object({
  'idempotency-key': idempotencyKeyHeaderSchema,
});

export const adminConfirmationSchema = reasonSchema;
