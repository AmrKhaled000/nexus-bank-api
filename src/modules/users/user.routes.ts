import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from '../../common/http/async-handler';
import { sendSuccess, validatedBody, validatedQuery, validateRequest } from '../../common/http/http';
import { authenticate, requireActiveAccount } from '../../middleware/auth';
import type { TokenService } from '../auth/token.service';
import type { UserService } from './user.service';
import { updateProfileSchema, userSecurityEventsQuerySchema } from './user.schemas';

export function createUserRouter(deps: { tokens: TokenService; service: UserService }): Router {
  const { tokens, service } = deps;
  const router = Router();
  router.use(authenticate(tokens));

  router.get(
    '/me',
    asyncHandler(async (req: Request, res: Response) => {
      return sendSuccess(res, await service.getProfile(req.auth!.userId));
    }),
  );

  router.patch(
    '/me',
    requireActiveAccount(),
    validateRequest({ body: updateProfileSchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const body = validatedBody(req, updateProfileSchema);
      return sendSuccess(res, await service.updateProfile(req.auth!.userId, req.auth!.role, body));
    }),
  );

  router.delete(
    '/me',
    requireActiveAccount(),
    asyncHandler(async (req: Request, res: Response) => {
      await service.closeAccount(req.auth!.userId);
      return sendSuccess(res, { message: 'Account closed. All sessions have been revoked.' });
    }),
  );

  router.get(
    '/me/security-events',
    validateRequest({ query: userSecurityEventsQuerySchema }),
    asyncHandler(async (req: Request, res: Response) => {
      const query = validatedQuery(req, userSecurityEventsQuerySchema);
      return sendSuccess(res, await service.listSecurityEvents(req.auth!.userId, query.limit));
    }),
  );

  return router;
}
