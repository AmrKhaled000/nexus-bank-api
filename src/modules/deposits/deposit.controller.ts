import type { Request, Response } from 'express';
import { sendSuccess, validatedBody, validatedParams, validatedQuery } from '../../common/http/http';
import { fingerprintRequest, getIdempotencyKey } from '../../common/http/request-security';
import type { DepositService } from './deposit.service';
import type { PaymentWebhookService } from '../webhooks/payment-webhook.service';
import {
  createDepositSchema,
  depositIdParamsSchema,
  depositQuerySchema,
  simulateDepositSchema,
} from './deposit.schemas';

export class DepositController {
  constructor(
    private readonly deposits: DepositService,
    private readonly webhooks: PaymentWebhookService,
  ) {}

  create = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, createDepositSchema);
    const key = getIdempotencyKey(req);
    const executed = await this.deposits.create(req.auth!.userId, body, {
      key,
      requestHash: fingerprintRequest('deposits.create', body),
    });
    return sendSuccess(res, executed.result, executed.statusCode, {
      idempotentReplay: executed.replayed,
    });
  };

  list = async (req: Request, res: Response): Promise<Response> => {
    const query = validatedQuery(req, depositQuerySchema);
    const result = await this.deposits.list(req.auth!.userId, query);
    return sendSuccess(res, result.items, 200, result.meta as unknown as Record<string, unknown>);
  };

  get = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, depositIdParamsSchema);
    return sendSuccess(res, await this.deposits.get(req.auth!.userId, id));
  };

  simulate = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, depositIdParamsSchema);
    const { outcome } = validatedBody(req, simulateDepositSchema);
    const result = await this.webhooks.simulateDeposit(req.auth!.userId, id, outcome);
    return sendSuccess(res, result, result.status === 'failed' ? 422 : 200);
  };
}
