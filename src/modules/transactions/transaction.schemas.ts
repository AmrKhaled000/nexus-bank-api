import { z } from 'zod';
import { paginationSchema } from '../../common/validation/pagination';

export const transactionQuerySchema = paginationSchema.extend({
  type: z.enum(['DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'FEE', 'REFUND', 'REVERSAL', 'ADJUSTMENT']).optional(),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVERSED']).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  walletId: z.string().cuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  reference: z.string().trim().max(60).optional(),
  search: z.string().trim().max(100).optional(),
  minAmount: z.string().regex(/^\d{1,18}$/).optional(),
  maxAmount: z.string().regex(/^\d{1,18}$/).optional(),
  sortBy: z.enum(['createdAt', 'amount']).default('createdAt'),
  format: z.enum(['json', 'csv']).default('json'),
});

export const transactionIdParamsSchema = z.object({ id: z.string().cuid() });
