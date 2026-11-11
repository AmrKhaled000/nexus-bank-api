import type { Request, Response } from 'express';
import { sendSuccess, validatedBody, validatedParams, validatedQuery } from '../../common/http/http';
import { fingerprintRequest, getIdempotencyKey } from '../../common/http/request-security';
import type { WithdrawalService } from './withdrawal.service';
import {
  cancelWithdrawalSchema,
  createWithdrawalSchema,
  withdrawalIdParamsSchema,
  withdrawalQuerySchema,
} from './withdrawal.schemas';

export class WithdrawalController {
  constructor(private readonly withdrawals: WithdrawalService) {}

  create = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, createWithdrawalSchema);
    const key = getIdempotencyKey(req);
    const executed = await this.withdrawals.create(req.auth!.userId, body, {
      key,
      requestHash: fingerprintRequest('withdrawals.create', body),
    });
    return sendSuccess(res, executed.result, executed.statusCode, {
      idempotentReplay: executed.replayed,
    });
  };

  list = async (req: Request, res: Response): Promise<Response> => {
    const query = validatedQuery(req, withdrawalQuerySchema);
    const result = await this.withdrawals.listForUser(req.auth!.userId, query);
    return sendSuccess(res, result.items, 200, result.meta as unknown as Record<string, unknown>);
  };

  get = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, withdrawalIdParamsSchema);
    return sendSuccess(res, await this.withdrawals.getForUser(req.auth!.userId, id));
  };

  cancel = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, withdrawalIdParamsSchema);
    const body = validatedBody(req, cancelWithdrawalSchema);
    return sendSuccess(res, await this.withdrawals.cancel(req.auth!.userId, id, body.reason));
  };
}
