import type { Request, Response } from 'express';
import { sendSuccess, validatedBody, validatedParams, validatedQuery } from '../../common/http/http';
import { fingerprintRequest, getAdminConfirmation, getIdempotencyKey } from '../../common/http/request-security';
import type { AdminService } from './admin.service';
import type { WithdrawalService } from '../withdrawals/withdrawal.service';
import type { TransferService } from '../transfers/transfer.service';
import { reverseTransferSchema, transferIdParamsSchema } from '../transfers/transfer.schemas';
import {
  adminLedgerQuerySchema,
  adminUserQuerySchema,
  auditLogQuerySchema,
  journalQuerySchema,
  ledgerAdjustmentSchema,
  updateUserRoleSchema,
  updateUserStatusSchema,
  userIdParamsSchema,
} from './admin.schemas';
import {
  adminWithdrawalQuerySchema,
  approveWithdrawalSchema,
  rejectWithdrawalSchema,
  withdrawalIdParamsSchema,
} from '../withdrawals/withdrawal.schemas';

export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly withdrawals: WithdrawalService,
    private readonly transfers: TransferService,
  ) {}

  listUsers = async (req: Request, res: Response): Promise<Response> => {
    const query = validatedQuery(req, adminUserQuerySchema);
    const result = await this.admin.listUsers(query);
    return sendSuccess(res, result.items, 200, result.meta as unknown as Record<string, unknown>);
  };

  getUser = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, userIdParamsSchema);
    return sendSuccess(res, await this.admin.getUser(id));
  };

  updateUserStatus = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, userIdParamsSchema);
    getAdminConfirmation(req, id);
    const body = validatedBody(req, updateUserStatusSchema);
    return sendSuccess(
      res,
      await this.admin.updateUserStatus({ userId: req.auth!.userId, role: req.auth!.role as never }, id, body),
    );
  };

  updateUserRole = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, userIdParamsSchema);
    getAdminConfirmation(req, id);
    const body = validatedBody(req, updateUserRoleSchema);
    return sendSuccess(
      res,
      await this.admin.updateUserRole({ userId: req.auth!.userId, role: req.auth!.role as never }, id, body),
    );
  };

  listWithdrawals = async (req: Request, res: Response): Promise<Response> => {
    const query = validatedQuery(req, adminWithdrawalQuerySchema);
    const result = await this.withdrawals.listForAdmin(query);
    return sendSuccess(res, result.items, 200, result.meta as unknown as Record<string, unknown>);
  };

  getWithdrawal = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, withdrawalIdParamsSchema);
    return sendSuccess(res, await this.withdrawals.getForAdmin(id));
  };

  approveWithdrawal = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, withdrawalIdParamsSchema);
    const body = validatedBody(req, approveWithdrawalSchema);
    return sendSuccess(
      res,
      await this.withdrawals.approve(
        { userId: req.auth!.userId, role: req.auth!.role as never },
        id,
        body.note,
      ),
    );
  };

  rejectWithdrawal = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, withdrawalIdParamsSchema);
    const body = validatedBody(req, rejectWithdrawalSchema);
    return sendSuccess(
      res,
      await this.withdrawals.reject({ userId: req.auth!.userId, role: req.auth!.role as never }, id, body.reason),
    );
  };

  retryPayout = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, withdrawalIdParamsSchema);
    return sendSuccess(
      res,
      await this.withdrawals.retryPayout({ userId: req.auth!.userId, role: req.auth!.role as never }, id),
    );
  };

  reverseTransfer = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, transferIdParamsSchema);
    getAdminConfirmation(req, id);
    const body = validatedBody(req, reverseTransferSchema);
    const key = getIdempotencyKey(req);
    const executed = await this.transfers.reverse(
      { userId: req.auth!.userId, role: req.auth!.role as never },
      id,
      body.reason,
      { key, requestHash: fingerprintRequest('transfers.reverse', body) },
    );
    return sendSuccess(res, executed.result, executed.statusCode, {
      idempotentReplay: executed.replayed,
    });
  };

  ledgerAccounts = async (req: Request, res: Response): Promise<Response> => {
    const query = validatedQuery(req, adminLedgerQuerySchema);
    return sendSuccess(res, await this.admin.listLedgerAccounts(query));
  };

  trialBalance = async (_req: Request, res: Response): Promise<Response> => {
    return sendSuccess(res, await this.admin.trialBalance());
  };

  journalEntries = async (req: Request, res: Response): Promise<Response> => {
    const query = validatedQuery(req, journalQuerySchema);
    const result = await this.admin.listJournalEntries(query);
    return sendSuccess(res, result.items, 200, result.meta as unknown as Record<string, unknown>);
  };

  adjustLedger = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, ledgerAdjustmentSchema);
    getAdminConfirmation(req, body.walletId);
    const key = getIdempotencyKey(req);
    const executed = await this.admin.adjustLedger(
      { userId: req.auth!.userId, role: req.auth!.role as never },
      body,
      { key, requestHash: fingerprintRequest('admin.ledger.adjust', body) },
    );
    return sendSuccess(res, executed.result, executed.statusCode, {
      idempotentReplay: executed.replayed,
    });
  };

  reconciliation = async (_req: Request, res: Response): Promise<Response> => {
    return sendSuccess(res, await this.admin.reconcile());
  };

  runReconciliation = async (req: Request, res: Response): Promise<Response> => {
    return sendSuccess(
      res,
      await this.admin.reconcile({ userId: req.auth!.userId, role: req.auth!.role as never }),
    );
  };

  auditLogs = async (req: Request, res: Response): Promise<Response> => {
    const query = validatedQuery(req, auditLogQuerySchema);
    const result = await this.admin.listAuditLogs(query);
    return sendSuccess(res, result.items, 200, result.meta as unknown as Record<string, unknown>);
  };

  stats = async (_req: Request, res: Response): Promise<Response> => {
    return sendSuccess(res, await this.admin.stats());
  };
}
