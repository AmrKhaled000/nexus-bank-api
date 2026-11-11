import { Router } from 'express';
import type { TokenService } from '../auth/token.service';
import { authenticate, requireActiveAccount, requireEmailVerified } from '../../middleware/auth';
import { validateRequest } from '../../common/http/http';
import { asyncHandler } from '../../common/http/async-handler';
import type { RateLimiters } from '../../middleware/rate-limit';
import type { WithdrawalController } from './withdrawal.controller';
import {
  cancelWithdrawalSchema,
  createWithdrawalSchema,
  withdrawalIdParamsSchema,
  withdrawalQuerySchema,
} from './withdrawal.schemas';

export function createWithdrawalRouter(deps: {
  tokens: TokenService;
  controller: WithdrawalController;
  limiters: RateLimiters;
}): Router {
  const router = Router();
  router.use(authenticate(deps.tokens));

  router.post(
    '/',
    requireActiveAccount(),
    requireEmailVerified(),
    deps.limiters.financial,
    validateRequest({ body: createWithdrawalSchema }),
    asyncHandler(deps.controller.create),
  );
  router.get('/', validateRequest({ query: withdrawalQuerySchema }), asyncHandler(deps.controller.list));
  router.get(
    '/:id',
    validateRequest({ params: withdrawalIdParamsSchema }),
    asyncHandler(deps.controller.get),
  );
  router.post(
    '/:id/cancel',
    requireActiveAccount(),
    deps.limiters.financial,
    validateRequest({ params: withdrawalIdParamsSchema, body: cancelWithdrawalSchema }),
    asyncHandler(deps.controller.cancel),
  );

  return router;
}
