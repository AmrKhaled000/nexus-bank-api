import type { Request, Response } from 'express';
import { sendSuccess, validatedBody, validatedParams, validatedQuery } from '../../common/http/http';
import type { WalletService } from './wallet.service';
import type { StatementService } from '../reports/statement.service';
import type { TransactionService } from '../transactions/transaction.service';
import {
  createWalletSchema,
  statementQuerySchema,
  updateWalletSchema,
  walletIdParamsSchema,
  walletTransactionQuerySchema,
} from './wallet.schemas';
import { transactionQuerySchema } from '../transactions/transaction.schemas';

export class WalletController {
  constructor(
    private readonly wallets: WalletService,
    private readonly statements: StatementService,
    private readonly transactions: TransactionService,
  ) {}

  list = async (req: Request, res: Response): Promise<Response> => {
    return sendSuccess(res, await this.wallets.list(req.auth!.userId));
  };

  create = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, createWalletSchema);
    return sendSuccess(res, await this.wallets.create(req.auth!.userId, body), 201);
  };

  get = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, walletIdParamsSchema);
    return sendSuccess(res, await this.wallets.get(req.auth!.userId, id));
  };

  update = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, walletIdParamsSchema);
    const body = validatedBody(req, updateWalletSchema);
    return sendSuccess(res, await this.wallets.update(req.auth!.userId, id, body));
  };

  close = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, walletIdParamsSchema);
    await this.wallets.close(req.auth!.userId, id);
    return sendSuccess(res, { message: 'Wallet closed.' });
  };

  listTransactions = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, walletIdParamsSchema);
    await this.wallets.get(req.auth!.userId, id);
    const query = validatedQuery(req, transactionQuerySchema);
    const input = { ...query, walletId: id };
    const result = await this.transactions.listForUser(req.auth!.userId, input);
    if ('csv' in result) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="wallet-${id}-transactions.csv"`);
      return res.status(200).send(result.csv);
    }
    return sendSuccess(res, result.items, 200, result.meta as unknown as Record<string, unknown>);
  };

  statement = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, walletIdParamsSchema);
    const query = validatedQuery(req, statementQuerySchema);
    const result = await this.statements.generate(req.auth!.userId, id, query);
    if (result.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      return res.status(200).send(result.csv);
    }
    return sendSuccess(res, result.statement);
  };

  transactionExport = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, walletIdParamsSchema);
    await this.wallets.get(req.auth!.userId, id);
    const query = validatedQuery(req, walletTransactionQuerySchema);
    const result = await this.transactions.exportWalletCsv(req.auth!.userId, id);
    void query;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="wallet-${id}-transactions.csv"`);
    return res.status(200).send(result.csv);
  };
}
