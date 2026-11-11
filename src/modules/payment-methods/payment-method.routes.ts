import { Router } from 'express';
import type { TokenService } from '../auth/token.service';
import { authenticate, requireActiveAccount, requireEmailVerified } from '../../middleware/auth';
import { validateRequest } from '../../common/http/http';
import { asyncHandler } from '../../common/http/async-handler';
import type { PaymentMethodController } from './payment-method.controller';
import {
  createPaymentMethodSchema,
  paymentMethodIdParamsSchema,
} from './payment-method.schemas';

export function createPaymentMethodRouter(deps: {
  tokens: TokenService;
  controller: PaymentMethodController;
}): Router {
  const router = Router();
  router.use(authenticate(deps.tokens));

  router.get('/', asyncHandler(deps.controller.list));
  router.post(
    '/',
    requireActiveAccount(),
    requireEmailVerified(),
    validateRequest({ body: createPaymentMethodSchema }),
    asyncHandler(deps.controller.create),
  );
  router.patch(
    '/:id/default',
    requireActiveAccount(),
    requireEmailVerified(),
    validateRequest({ params: paymentMethodIdParamsSchema }),
    asyncHandler(deps.controller.setDefault),
  );
  router.delete(
    '/:id',
    requireActiveAccount(),
    requireEmailVerified(),
    validateRequest({ params: paymentMethodIdParamsSchema }),
    asyncHandler(deps.controller.remove),
  );

  return router;
}
