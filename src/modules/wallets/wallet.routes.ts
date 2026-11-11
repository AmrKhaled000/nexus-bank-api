import { Router } from 'express';
import type { TokenService } from '../auth/token.service';
import { authenticate, requireActiveAccount, requireEmailVerified } from '../../middleware/auth';
import { validateRequest } from '../../common/http/http';
import { asyncHandler } from '../../common/http/async-handler';
import type { WalletController } from './wallet.controller';
import {
  createWalletSchema,
  statementQuerySchema,
  updateWalletSchema,
  walletIdParamsSchema,
  walletTransactionQuerySchema,
} from './wallet.schemas';
import { transactionQuerySchema } from '../transactions/transaction.schemas';

export function createWalletRouter(deps: { tokens: TokenService; controller: WalletController }): Router {
  const { tokens, controller } = deps;
  const router = Router();
  router.use(authenticate(tokens));

  router.get('/', asyncHandler(controller.list));
  router.post(
    '/',
    requireActiveAccount(),
    requireEmailVerified(),
    validateRequest({ body: createWalletSchema }),
    asyncHandler(controller.create),
  );
  router.get(
    '/:id',
    validateRequest({ params: walletIdParamsSchema }),
    asyncHandler(controller.get),
  );
  router.patch(
    '/:id',
    requireActiveAccount(),
    validateRequest({ params: walletIdParamsSchema, body: updateWalletSchema }),
    asyncHandler(controller.update),
  );
  router.delete(
    '/:id',
    requireActiveAccount(),
    validateRequest({ params: walletIdParamsSchema }),
    asyncHandler(controller.close),
  );
  router.get(
    '/:id/transactions',
    validateRequest({ params: walletIdParamsSchema, query: transactionQuerySchema }),
    asyncHandler(controller.listTransactions),
  );
  router.get(
    '/:id/transactions/export',
    validateRequest({ params: walletIdParamsSchema, query: walletTransactionQuerySchema }),
    asyncHandler(controller.transactionExport),
  );
  router.get(
    '/:id/statement',
    validateRequest({ params: walletIdParamsSchema, query: statementQuerySchema }),
    asyncHandler(controller.statement),
  );

  return router;
}
