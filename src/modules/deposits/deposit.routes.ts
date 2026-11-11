import { Router } from 'express';
import type { TokenService } from '../auth/token.service';
import { authenticate, requireActiveAccount, requireEmailVerified } from '../../middleware/auth';
import { validateRequest } from '../../common/http/http';
import { asyncHandler } from '../../common/http/async-handler';
import type { RateLimiters } from '../../middleware/rate-limit';
import type { DepositController } from './deposit.controller';
import {
  createDepositSchema,
  depositIdParamsSchema,
  depositQuerySchema,
  simulateDepositSchema,
} from './deposit.schemas';

export function createDepositRouter(deps: {
  tokens: TokenService;
  controller: DepositController;
  limiters: RateLimiters;
}): Router {
  const router = Router();
  router.use(authenticate(deps.tokens));

  router.post(
    '/',
    requireActiveAccount(),
    requireEmailVerified(),
    deps.limiters.financial,
    validateRequest({ body: createDepositSchema }),
    asyncHandler(deps.controller.create),
  );
  router.get('/', validateRequest({ query: depositQuerySchema }), asyncHandler(deps.controller.list));
  router.get('/:id', validateRequest({ params: depositIdParamsSchema }), asyncHandler(deps.controller.get));
  router.post(
    '/:id/simulate',
    requireActiveAccount(),
    requireEmailVerified(),
    deps.limiters.financial,
    validateRequest({ params: depositIdParamsSchema, body: simulateDepositSchema }),
    asyncHandler(deps.controller.simulate),
  );

  return router;
}
