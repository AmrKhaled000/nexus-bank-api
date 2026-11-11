import { z } from 'zod';
import { paginationSchema } from '../../common/validation/pagination';
import { pinSchema, safeTextSchema } from '../../common/validation/schemas';

export const moneyInputSchema = z
  .string()
  .trim()
  .regex(/^\d{1,15}(?:\.\d{1,6})?$/, 'Amount must be a positive decimal string');

export const createTransferSchema = z
  .object({
    sourceWalletId: z.string().cuid(),
    destinationWalletId: z.string().cuid(),
    amount: moneyInputSchema,
    description: safeTextSchema(140).optional(),
    pin: pinSchema,
  })
  .strict();

export const transferQuerySchema = paginationSchema.extend({
  direction: z.enum(['all', 'sent', 'received']).default('all'),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVERSED']).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

export const reverseTransferSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const transferIdParamsSchema = z.object({ id: z.string().cuid() });
