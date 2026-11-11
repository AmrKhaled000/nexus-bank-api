import { Router } from 'express';
import type { TokenService } from '../auth/token.service';
import { authenticate, requirePermission } from '../../middleware/auth';
import { Permission } from '../../common/security/permissions';
import { validateRequest } from '../../common/http/http';
import { asyncHandler } from '../../common/http/async-handler';
import type { RateLimiters } from '../../middleware/rate-limit';
import type { AdminController } from './admin.controller';
import {
  adminLedgerQuerySchema,
  adminUserQuerySchema,
  auditLogQuerySchema,
  journalQuerySchema,
  ledgerAdjustmentSchema,
  updateUserRoleSchema,
  updateUserStatusSchema,
  userIdParamsSchema,
} from './admin.schemas';
import {
  adminWithdrawalQuerySchema,
  approveWithdrawalSchema,
  rejectWithdrawalSchema,
  withdrawalIdParamsSchema,
} from '../withdrawals/withdrawal.schemas';
import { reverseTransferSchema, transferIdParamsSchema } from '../transfers/transfer.schemas';

export function createAdminRouter(deps: {
  tokens: TokenService;
  controller: AdminController;
  limiters: RateLimiters;
}): Router {
  const router = Router();
  router.use(authenticate(deps.tokens));

  router.get(
    '/users',
    requirePermission(Permission.ADMIN_READ),
    validateRequest({ query: adminUserQuerySchema }),
    asyncHandler(deps.controller.listUsers),
  );
  router.get(
    '/users/:id',
    requirePermission(Permission.ADMIN_READ),
    validateRequest({ params: userIdParamsSchema }),
    asyncHandler(deps.controller.getUser),
  );
  router.patch(
    '/users/:id/status',
    requirePermission(Permission.USERS_MANAGE),
    validateRequest({ params: userIdParamsSchema, body: updateUserStatusSchema }),
    asyncHandler(deps.controller.updateUserStatus),
  );
  router.patch(
    '/users/:id/role',
    requirePermission(Permission.ROLES_MANAGE),
    validateRequest({ params: userIdParamsSchema, body: updateUserRoleSchema }),
    asyncHandler(deps.controller.updateUserRole),
  );

  router.get(
    '/withdrawals',
    requirePermission(Permission.ADMIN_READ),
    validateRequest({ query: adminWithdrawalQuerySchema }),
    asyncHandler(deps.controller.listWithdrawals),
  );
  router.get(
    '/withdrawals/:id',
    requirePermission(Permission.ADMIN_READ),
    validateRequest({ params: withdrawalIdParamsSchema }),
    asyncHandler(deps.controller.getWithdrawal),
  );
  router.post(
    '/withdrawals/:id/approve',
    requirePermission(Permission.WITHDRAWALS_REVIEW),
    deps.limiters.financial,
    validateRequest({ params: withdrawalIdParamsSchema, body: approveWithdrawalSchema }),
    asyncHandler(deps.controller.approveWithdrawal),
  );
  router.post(
    '/withdrawals/:id/reject',
    requirePermission(Permission.WITHDRAWALS_REVIEW),
    deps.limiters.financial,
    validateRequest({ params: withdrawalIdParamsSchema, body: rejectWithdrawalSchema }),
    asyncHandler(deps.controller.rejectWithdrawal),
  );
  router.post(
    '/withdrawals/:id/retry-payout',
    requirePermission(Permission.WITHDRAWALS_REVIEW),
    deps.limiters.financial,
    validateRequest({ params: withdrawalIdParamsSchema }),
    asyncHandler(deps.controller.retryPayout),
  );

  router.post(
    '/transfers/:id/reverse',
    requirePermission(Permission.TRANSFERS_REVERSE),
    deps.limiters.financial,
    validateRequest({
      params: transferIdParamsSchema,
      body: reverseTransferSchema,
    }),
    asyncHandler(deps.controller.reverseTransfer),
  );

  router.get(
    '/ledger/accounts',
    requirePermission(Permission.LEDGER_READ),
    validateRequest({ query: adminLedgerQuerySchema }),
    asyncHandler(deps.controller.ledgerAccounts),
  );
  router.get(
    '/ledger/trial-balance',
    requirePermission(Permission.LEDGER_READ),
    asyncHandler(deps.controller.trialBalance),
  );
  router.get(
    '/ledger/journal-entries',
    requirePermission(Permission.LEDGER_READ),
    validateRequest({ query: journalQuerySchema }),
    asyncHandler(deps.controller.journalEntries),
  );
  router.post(
    '/ledger/adjustments',
    requirePermission(Permission.LEDGER_ADJUST),
    deps.limiters.financial,
    validateRequest({ body: ledgerAdjustmentSchema }),
    asyncHandler(deps.controller.adjustLedger),
  );

  router.get(
    '/reconciliation',
    requirePermission(Permission.LEDGER_READ),
    asyncHandler(deps.controller.reconciliation),
  );
  router.post(
    '/reconciliation/run',
    requirePermission(Permission.LEDGER_READ),
    asyncHandler(deps.controller.runReconciliation),
  );

  router.get(
    '/audit-logs',
    requirePermission(Permission.AUDIT_READ),
    validateRequest({ query: auditLogQuerySchema }),
    asyncHandler(deps.controller.auditLogs),
  );
  router.get(
    '/stats',
    requirePermission(Permission.ADMIN_READ),
    asyncHandler(deps.controller.stats),
  );

  return router;
}
