import { z } from 'zod';
import { paginationSchema } from '../../common/validation/pagination';
import { reasonSchema } from '../../common/validation/schemas';
import { moneyInputSchema } from '../transfers/transfer.schemas';

export const adminUserQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  role: z.enum(['CUSTOMER', 'SUPPORT', 'FINANCE_ADMIN', 'SUPER_ADMIN']).optional(),
  status: z.enum(['ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED', 'FROZEN', 'CLOSED']).optional(),
});

export const userIdParamsSchema = z.object({ id: z.string().cuid() });

export const updateUserStatusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'FROZEN']),
    reason: reasonSchema,
  })
  .strict();

export const updateUserRoleSchema = z
  .object({
    role: z.enum(['CUSTOMER', 'SUPPORT', 'FINANCE_ADMIN', 'SUPER_ADMIN']),
    reason: reasonSchema,
  })
  .strict();

export const adminLedgerQuerySchema = paginationSchema.extend({
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  accountType: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']).optional(),
});

export const journalQuerySchema = paginationSchema.extend({
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  transactionId: z.string().cuid().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

export const ledgerAdjustmentSchema = z
  .object({
    walletId: z.string().cuid(),
    direction: z.enum(['CREDIT', 'DEBIT']),
    amount: moneyInputSchema,
    reason: reasonSchema,
  })
  .strict();

export const auditLogQuerySchema = paginationSchema.extend({
  actorUserId: z.string().cuid().optional(),
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(100).optional(),
  entityId: z.string().trim().max(100).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});
