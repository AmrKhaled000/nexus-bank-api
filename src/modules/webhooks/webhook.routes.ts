import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/http/async-handler';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { sendSuccess } from '../../common/http/http';
import type { PaymentWebhookService } from './payment-webhook.service';

const providerParamsSchema = z.object({
  provider: z.enum(['simulated', 'stripe']),
});

/**
 * Public, unauthenticated webhook surface. Authenticity comes from the provider signature
 * (verified over the exact raw bytes), never from network location or bearer tokens.
 */
export function createWebhookRouter(deps: { service: PaymentWebhookService }): Router {
  const router = Router();

  router.post(
    '/payments/:provider',
    asyncHandler(async (req, res) => {
      const parsed = providerParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        throw AppError.notFound(ErrorCode.NOT_FOUND, 'Unknown payment provider');
      }
      if (!Buffer.isBuffer(req.rawBody)) {
        throw AppError.badRequest(ErrorCode.INVALID_JSON, 'A raw webhook body is required');
      }
      const provider = parsed.data.provider === 'stripe' ? 'STRIPE' : 'SIMULATED';
      const result = await deps.service.process(
        provider,
        req.rawBody,
        req.headers as Record<string, string | string[] | undefined>,
      );
      return sendSuccess(res, result, result.status === 'failed' ? 422 : 200);
    }),
  );

  return router;
}
