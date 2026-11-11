import { Router } from 'express';
import type { TokenService } from '../auth/token.service';
import { authenticate } from '../../middleware/auth';
import { validateRequest } from '../../common/http/http';
import { asyncHandler } from '../../common/http/async-handler';
import type { NotificationController } from './notification.controller';
import { notificationIdParamsSchema, notificationQuerySchema } from './notification.schemas';

export function createNotificationRouter(deps: {
  tokens: TokenService;
  controller: NotificationController;
}): Router {
  const router = Router();
  router.use(authenticate(deps.tokens));

  router.get(
    '/',
    validateRequest({ query: notificationQuerySchema }),
    asyncHandler(deps.controller.list),
  );
  router.post('/read-all', asyncHandler(deps.controller.markAllRead));
  router.patch(
    '/:id/read',
    validateRequest({ params: notificationIdParamsSchema }),
    asyncHandler(deps.controller.markRead),
  );

  return router;
}
