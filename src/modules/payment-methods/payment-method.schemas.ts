import { z } from 'zod';
import { paginationSchema } from '../../common/validation/pagination';

export const createPaymentMethodSchema = z
  .object({
    bankName: z.string().trim().min(2).max(120),
    accountLast4: z.string().regex(/^\d{4}$/, 'Account last4 must be exactly four digits'),
    isDefault: z.boolean().default(false),
  })
  .strict();

export const paymentMethodIdParamsSchema = z.object({ id: z.string().cuid() });

export const paymentMethodQuerySchema = paginationSchema;
