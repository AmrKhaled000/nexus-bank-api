import { Router } from 'express';
import type { TokenService } from '../auth/token.service';
import { authenticate } from '../../middleware/auth';
import { validateRequest } from '../../common/http/http';
import { asyncHandler } from '../../common/http/async-handler';
import type { TransactionController } from './transaction.controller';
import { transactionIdParamsSchema, transactionQuerySchema } from './transaction.schemas';

export function createTransactionRouter(deps: {
  tokens: TokenService;
  controller: TransactionController;
}): Router {
  const router = Router();
  router.use(authenticate(deps.tokens));
  router.get(
    '/',
    validateRequest({ query: transactionQuerySchema }),
    asyncHandler(deps.controller.list),
  );
  router.get(
    '/:id',
    validateRequest({ params: transactionIdParamsSchema }),
    asyncHandler(deps.controller.get),
  );
  router.get(
    '/:id/receipt',
    validateRequest({ params: transactionIdParamsSchema }),
    asyncHandler(deps.controller.receipt),
  );
  return router;
}
