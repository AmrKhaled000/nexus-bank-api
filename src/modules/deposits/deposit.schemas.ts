import { z } from 'zod';
import { paginationSchema } from '../../common/validation/pagination';
import { safeTextSchema } from '../../common/validation/schemas';
import { moneyInputSchema } from '../transfers/transfer.schemas';

const depositStatusSchema = z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);

export const createDepositSchema = z
  .object({
    walletId: z.string().cuid(),
    amount: moneyInputSchema,
    description: safeTextSchema(140).optional(),
    provider: z.enum(['SIMULATED', 'STRIPE']).optional(),
  })
  .strict();

export const depositQuerySchema = paginationSchema.extend({
  status: depositStatusSchema.optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  walletId: z.string().cuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

export const depositIdParamsSchema = z.object({ id: z.string().cuid() });

export const simulateDepositSchema = z
  .object({
    outcome: z.enum(['completed', 'failed']).default('completed'),
  })
  .strict()
  .default({ outcome: 'completed' });
