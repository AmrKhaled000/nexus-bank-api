import { z } from 'zod';
import { paginationSchema } from '../../common/validation/pagination';
import { pinSchema, reasonSchema, safeTextSchema } from '../../common/validation/schemas';
import { moneyInputSchema } from '../transfers/transfer.schemas';

const withdrawalStatusSchema = z.enum([
  'PENDING',
  'UNDER_REVIEW',
  'APPROVED',
  'PROCESSING',
  'COMPLETED',
  'REJECTED',
  'FAILED',
  'CANCELLED',
]);

export const createWithdrawalSchema = z
  .object({
    walletId: z.string().cuid(),
    payoutMethodId: z.string().cuid(),
    amount: moneyInputSchema,
    description: safeTextSchema(140).optional(),
    pin: pinSchema,
  })
  .strict();

export const withdrawalQuerySchema = paginationSchema.extend({
  status: withdrawalStatusSchema.optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  walletId: z.string().cuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

export const adminWithdrawalQuerySchema = withdrawalQuerySchema.extend({
  userId: z.string().cuid().optional(),
});

export const withdrawalIdParamsSchema = z.object({ id: z.string().cuid() });

export const approveWithdrawalSchema = z
  .object({
    note: safeTextSchema(300).optional(),
  })
  .strict()
  .default({});

export const rejectWithdrawalSchema = z
  .object({
    reason: reasonSchema,
  })
  .strict();

export const cancelWithdrawalSchema = z
  .object({
    reason: reasonSchema.optional(),
  })
  .strict()
  .default({});
