import { Router } from 'express';
import type { TokenService } from '../auth/token.service';
import { authenticate, requireActiveAccount, requireEmailVerified } from '../../middleware/auth';
import { validateRequest } from '../../common/http/http';
import { asyncHandler } from '../../common/http/async-handler';
import type { RateLimiters } from '../../middleware/rate-limit';
import type { TransferController } from './transfer.controller';
import {
  createTransferSchema,
  transferIdParamsSchema,
  transferQuerySchema,
} from './transfer.schemas';

export function createTransferRouter(deps: {
  tokens: TokenService;
  controller: TransferController;
  limiters: RateLimiters;
}): Router {
  const router = Router();
  router.use(authenticate(deps.tokens));

  router.post(
    '/',
    requireActiveAccount(),
    requireEmailVerified(),
    deps.limiters.financial,
    validateRequest({ body: createTransferSchema }),
    asyncHandler(deps.controller.create),
  );
  router.get(
    '/',
    validateRequest({ query: transferQuerySchema }),
    asyncHandler(deps.controller.list),
  );
  router.get(
    '/:id',
    validateRequest({ params: transferIdParamsSchema }),
    asyncHandler(deps.controller.get),
  );

  return router;
}
