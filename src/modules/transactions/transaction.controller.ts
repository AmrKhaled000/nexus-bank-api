import type { Request, Response } from 'express';
import { sendSuccess, validatedParams, validatedQuery } from '../../common/http/http';
import type { TransactionService } from './transaction.service';
import { transactionIdParamsSchema, transactionQuerySchema } from './transaction.schemas';

export class TransactionController {
  constructor(private readonly transactions: TransactionService) {}

  list = async (req: Request, res: Response): Promise<Response> => {
    const query = validatedQuery(req, transactionQuerySchema);
    const result = await this.transactions.listForUser(req.auth!.userId, query);
    if ('csv' in result) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
      return res.status(200).send(result.csv);
    }
    return sendSuccess(res, result.items, 200, result.meta as unknown as Record<string, unknown>);
  };

  get = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, transactionIdParamsSchema);
    return sendSuccess(res, await this.transactions.getForUser(req.auth!.userId, id));
  };

  receipt = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, transactionIdParamsSchema);
    return sendSuccess(res, await this.transactions.receipt(req.auth!.userId, id));
  };
}
