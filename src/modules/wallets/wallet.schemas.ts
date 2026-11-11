import { z } from 'zod';
import { paginationSchema } from '../../common/validation/pagination';
import { safeTextSchema } from '../../common/validation/schemas';

export const createWalletSchema = z
  .object({
    name: safeTextSchema(60).pipe(z.string().min(1, 'Wallet name is required')),
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code'),
    type: z.enum(['PERSONAL', 'SAVINGS']).default('PERSONAL'),
    isPrimary: z.boolean().optional(),
  })
  .strict();

export const updateWalletSchema = z
  .object({
    name: safeTextSchema(60).pipe(z.string().min(1, 'Wallet name is required')),
  })
  .strict();

export const walletIdParamsSchema = z.object({ id: z.string().cuid() });

export const walletTransactionQuerySchema = paginationSchema.extend({
  type: z.enum(['DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'FEE', 'REFUND', 'REVERSAL', 'ADJUSTMENT']).optional(),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVERSED']).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

export const statementQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
