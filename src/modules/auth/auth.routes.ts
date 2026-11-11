import { Router } from 'express';
import type { AppConfig } from '../../config/env';
import { asyncHandler } from '../../common/http/async-handler';
import { validateRequest } from '../../common/http/http';
import { authenticate } from '../../middleware/auth';
import type { RateLimiters } from '../../middleware/rate-limit';
import type { AuthController } from './auth.controller';
import type { TokenService } from './token.service';
import {
  changePasswordSchema,
  changePinSchema,
  disableTwoFactorSchema,
  enableTwoFactorSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  setPinSchema,
  setupTwoFactorSchema,
  verifyEmailSchema,
  verifyTwoFactorSchema,
} from './auth.schemas';
import { z } from 'zod';

const sessionParamsSchema = z.object({ sessionId: z.string().cuid() });

export function createAuthRouter(deps: {
  config: AppConfig;
  controller: AuthController;
  tokens: TokenService;
  limiters: RateLimiters;
}): Router {
  const { config, controller, tokens, limiters } = deps;
  const router = Router();
  const auth = authenticate(tokens);

  router.post(
    '/register',
    limiters.registration,
    validateRequest({ body: registerSchema }),
    asyncHandler(controller.register),
  );
  router.post(
    '/verify-email',
    limiters.verification,
    validateRequest({ body: verifyEmailSchema }),
    asyncHandler(controller.verifyEmail),
  );
  router.post(
    '/resend-verification',
    limiters.verification,
    validateRequest({ body: resendVerificationSchema }),
    asyncHandler(controller.resendVerification),
  );
  router.post(
    '/login',
    limiters.login,
    validateRequest({ body: loginSchema }),
    asyncHandler(controller.login),
  );
  router.post(
    '/2fa/verify',
    limiters.login,
    validateRequest({ body: verifyTwoFactorSchema }),
    asyncHandler(controller.verifyTwoFactor),
  );
  router.post(
    '/refresh',
    limiters.verification,
    validateRequest({ body: refreshSchema }),
    asyncHandler(controller.refresh),
  );
  router.post('/logout', auth, asyncHandler(controller.logout));
  router.post('/logout-all', auth, asyncHandler(controller.logoutAll));
  router.get('/sessions', auth, asyncHandler(controller.listSessions));
  router.delete(
    '/sessions/:sessionId',
    auth,
    validateRequest({ params: sessionParamsSchema }),
    asyncHandler(controller.revokeSession),
  );
  router.post(
    '/forgot-password',
    limiters.passwordReset,
    validateRequest({ body: forgotPasswordSchema }),
    asyncHandler(controller.forgotPassword),
  );
  router.post(
    '/reset-password',
    limiters.passwordReset,
    validateRequest({ body: resetPasswordSchema }),
    asyncHandler(controller.resetPassword),
  );
  router.post(
    '/change-password',
    auth,
    limiters.passwordReset,
    validateRequest({ body: changePasswordSchema }),
    asyncHandler(controller.changePassword),
  );
  router.post(
    '/2fa/setup',
    auth,
    limiters.verification,
    validateRequest({ body: setupTwoFactorSchema }),
    asyncHandler(controller.setupTwoFactor),
  );
  router.post(
    '/2fa/enable',
    auth,
    limiters.verification,
    validateRequest({ body: enableTwoFactorSchema }),
    asyncHandler(controller.enableTwoFactor),
  );
  router.post(
    '/2fa/disable',
    auth,
    limiters.verification,
    validateRequest({ body: disableTwoFactorSchema }),
    asyncHandler(controller.disableTwoFactor),
  );
  router.put(
    '/pin',
    auth,
    limiters.verification,
    validateRequest({ body: setPinSchema }),
    asyncHandler(controller.setPin),
  );
  router.patch(
    '/pin',
    auth,
    limiters.verification,
    validateRequest({ body: changePinSchema }),
    asyncHandler(controller.changePin),
  );

  // Exposed for discoverability in generated API docs and smoke checks.
  router.get('/config', (_req, res) => {
    res.json({
      success: true,
      data: {
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        accessTokenTtlSeconds: config.JWT_ACCESS_TTL_SECONDS,
        refreshCookieName: config.REFRESH_COOKIE_NAME,
        refreshCookiePath: `${config.API_PREFIX}/auth`,
      },
    });
  });

  return router;
}
