import type { Request, Response } from 'express';
import { sendSuccess, validatedBody, validatedParams, validatedQuery } from '../../common/http/http';
import { fingerprintRequest, getIdempotencyKey } from '../../common/http/request-security';
import type { TransferService } from './transfer.service';
import {
  createTransferSchema,
  transferIdParamsSchema,
  transferQuerySchema,
} from './transfer.schemas';

export class TransferController {
  constructor(private readonly transfers: TransferService) {}

  create = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, createTransferSchema);
    const key = getIdempotencyKey(req);
    const executed = await this.transfers.create(req.auth!.userId, body, {
      key,
      requestHash: fingerprintRequest('transfers.create', body),
    });
    return sendSuccess(res, executed.result, executed.statusCode, {
      idempotentReplay: executed.replayed,
    });
  };

  list = async (req: Request, res: Response): Promise<Response> => {
    const query = validatedQuery(req, transferQuerySchema);
    const result = await this.transfers.list(req.auth!.userId, query);
    return sendSuccess(res, result.items, 200, result.meta as unknown as Record<string, unknown>);
  };

  get = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, transferIdParamsSchema);
    return sendSuccess(res, await this.transfers.get(req.auth!.userId, id));
  };
}
