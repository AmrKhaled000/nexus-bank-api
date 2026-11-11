import type { PrismaClient, UserRole } from '@prisma/client';
import type { z } from 'zod';
import type { AppConfig } from '../../config/env';
import { config } from '../../config/env';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { assertPermission, Permission } from '../../common/security/permissions';
import { parseAmountToMinor } from '../../common/money/money';
import { publicReference } from '../../common/ids/reference';
import { logger } from '../../infrastructure/logging/logger';
import { prisma, type TransactionClient } from '../../infrastructure/database/prisma';
import type { PayoutGateway, PayoutResult } from '../../infrastructure/payments/types';
import { createPayoutGateway } from '../../infrastructure/payments/gateway-factory';
import type { PayoutQueue } from '../../infrastructure/queue/queues';
import { LedgerService } from '../ledger/ledger.service';
import type { WalletRepository} from '../wallets/wallet.repository';
import { walletRepository } from '../wallets/wallet.repository';
import type { FeeService, LimitService} from '../limits/limit.service';
import { feeService, limitService } from '../limits/limit.service';
import type {
  IdempotencyService} from '../idempotency/idempotency.service';
import {
  idempotencyService,
  type IdempotentExecution,
} from '../idempotency/idempotency.service';
import type { NotificationService} from '../notifications/notification.service';
import { notificationService } from '../notifications/notification.service';
import { SecurityEventService } from '../security/security-event.service';
import { AuditService } from '../audit/audit.service';
import { PinService } from '../security/pin.service';
import { toWithdrawalDto } from './withdrawal.dto';
import type {
  adminWithdrawalQuerySchema,
  createWithdrawalSchema,
  withdrawalQuerySchema,
} from './withdrawal.schemas';
import { paginationMeta } from '../../common/validation/pagination';

type ActiveWithdrawalStatus = 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'PROCESSING';
type WithdrawalStatusValue = ActiveWithdrawalStatus | 'COMPLETED' | 'REJECTED' | 'FAILED' | 'CANCELLED';

interface WithdrawalResult {
  withdrawal: ReturnType<typeof toWithdrawalDto>;
}

const withdrawalInclude = {
  transaction: true,
  currency: true,
  wallet: { select: { id: true, name: true } },
  payoutMethod: {
    select: { id: true, bankName: true, accountLast4: true, isDefault: true },
  },
} as const;

export class WithdrawalService {
  constructor(
    private readonly client: PrismaClient = prisma,
    private readonly ledger: LedgerService = new LedgerService(),
    private readonly wallets: WalletRepository = walletRepository,
    private readonly limits: LimitService = limitService,
    private readonly fees: FeeService = feeService,
    private readonly idempotency: IdempotencyService = idempotencyService,
    private readonly notifications: NotificationService = notificationService,
    private readonly securityEvents: SecurityEventService = new SecurityEventService(),
    private readonly audit: AuditService = new AuditService(),
    private readonly pins: PinService = new PinService(config, new SecurityEventService()),
    private readonly settings: AppConfig = config,
    private readonly payout: PayoutGateway = createPayoutGateway(config),
    private readonly payoutQueue: PayoutQueue | null = null,
  ) {}

  async create(
    userId: string,
    input: z.infer<typeof createWithdrawalSchema>,
    idempotency: { key: string; requestHash: string },
  ): Promise<IdempotentExecution<WithdrawalResult>> {
    await this.pins.verifyForTransaction(userId, input.pin);
    const context = {
      userId,
      scope: 'withdrawals.create',
      key: idempotency.key,
      requestHash: idempotency.requestHash,
    };
    const replay = await this.idempotency.preview<WithdrawalResult>(context);
    if (replay) return replay;

    const execution = await this.idempotency.run<WithdrawalResult>(context, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, status: true, emailVerifiedAt: true },
      });
      if (!user) throw AppError.unauthorized();
      if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
        throw AppError.forbidden(
          ErrorCode.ACCOUNT_SUSPENDED,
          'An active, verified account is required for withdrawals',
        );
      }

      const wallet = await tx.wallet.findFirst({
        where: { id: input.walletId, userId },
        include: { currency: true },
      });
      if (!wallet) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
      if (wallet.status !== 'ACTIVE') {
        throw AppError.unprocessable(ErrorCode.WALLET_NOT_ACTIVE, 'Wallet is not active');
      }
      const payoutMethod = await tx.paymentMethodReference.findFirst({
        where: { id: input.payoutMethodId, userId, deletedAt: null },
      });
      if (!payoutMethod) {
        throw AppError.notFound(ErrorCode.PAYMENT_METHOD_NOT_FOUND, 'Payout method not found');
      }

      const amountMinor = parseAmountToMinor(input.amount, wallet.currency.exponent);
      const fee = await this.fees.quote('WITHDRAWAL', amountMinor, wallet.currencyCode);
      const totalMinor = amountMinor + fee.feeMinor;

      await this.wallets.lockUsersAdvisory(tx, [userId]);
      const locked = await this.wallets.lockWallets(tx, [input.walletId]);
      const walletLock = locked[0];
      if (!walletLock) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
      if (walletLock.status !== 'ACTIVE') {
        throw AppError.unprocessable(ErrorCode.WALLET_NOT_ACTIVE, 'Wallet is not active');
      }

      await this.limits.assertWithinLimits(tx, {
        scope: 'WITHDRAWAL',
        currencyCode: wallet.currencyCode,
        userId,
        amountMinor,
      });

      const available = walletLock.balanceMinor - walletLock.heldMinor;
      if (available < totalMinor) {
        throw AppError.unprocessable(ErrorCode.INSUFFICIENT_FUNDS, 'Insufficient available balance', {
          availableMinor: available.toString(),
          requiredMinor: totalMinor.toString(),
        });
      }

      const requiresReview =
        !this.settings.AUTO_APPROVE_WITHDRAWALS ||
        amountMinor >= BigInt(this.settings.WITHDRAWAL_REVIEW_THRESHOLD_MINOR);
      const status = requiresReview
        ? amountMinor >= BigInt(this.settings.WITHDRAWAL_REVIEW_THRESHOLD_MINOR)
          ? 'UNDER_REVIEW'
          : 'PENDING'
        : 'APPROVED';
      const reference = publicReference('WD');
      const transaction = await tx.financialTransaction.create({
        data: {
          reference,
          type: 'WITHDRAWAL',
          status: requiresReview ? 'PENDING' : 'PROCESSING',
          amountMinor,
          feeMinor: fee.feeMinor,
          currencyCode: wallet.currencyCode,
          initiatorUserId: userId,
          sourceWalletId: wallet.id,
          description: input.description ?? 'Wallet withdrawal',
        },
      });
      const withdrawal = await tx.withdrawal.create({
        data: {
          transactionId: transaction.id,
          userId,
          walletId: wallet.id,
          currencyCode: wallet.currencyCode,
          amountMinor,
          feeMinor: fee.feeMinor,
          status,
          payoutMethodId: payoutMethod.id,
          payoutAttempts: 0,
        },
        include: withdrawalInclude,
      });

      await tx.walletHold.create({
        data: {
          walletId: wallet.id,
          transactionId: transaction.id,
          amountMinor: totalMinor,
          status: 'ACTIVE',
        },
      });
      const held = await tx.$executeRaw`
        UPDATE "wallet_accounts"
        SET "heldMinor" = "heldMinor" + ${totalMinor},
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE "id" = ${walletLock.walletAccountId}
          AND "balanceMinor" - "heldMinor" >= ${totalMinor}
      `;
      if (held !== 1) {
        throw AppError.unprocessable(ErrorCode.INSUFFICIENT_FUNDS, 'Insufficient available balance');
      }

      if (amountMinor >= BigInt(this.settings.SUSPICIOUS_AMOUNT_MINOR)) {
        await this.securityEvents.record(
          {
            userId,
            type: 'SUSPICIOUS_TRANSACTION',
            severity: 'HIGH',
            metadata: {
              reason: 'large_withdrawal',
              reference,
              amountMinor: amountMinor.toString(),
              currency: wallet.currencyCode,
            },
          },
          tx,
        );
      }
      await this.audit.record(
        {
          actorUserId: userId,
          actorRole: 'CUSTOMER',
          action: 'WITHDRAWAL_REQUESTED',
          entityType: 'Withdrawal',
          entityId: withdrawal.id,
          afterState: {
            reference,
            status,
            amountMinor: amountMinor.toString(),
            feeMinor: fee.feeMinor.toString(),
            currency: wallet.currencyCode,
            payoutMethodId: payoutMethod.id,
          },
        },
        tx,
      );

      return {
        data: { withdrawal: toWithdrawalDto(withdrawal) },
        statusCode: 201,
        resourceType: 'withdrawal',
        resourceId: withdrawal.id,
      };
    });

    if (!execution.replayed && execution.result.withdrawal.status === 'APPROVED') {
      try {
        await this.dispatchPayout(execution.result.withdrawal.id);
      } catch (error) {
        logger.error(
          {
            withdrawalId: execution.result.withdrawal.id,
            error: error instanceof Error ? error.message : 'unknown',
          },
          'Auto-approved withdrawal could not be dispatched; it remains approved for retry',
        );
      }
    }
    return execution;
  }

  async listForUser(userId: string, input: z.infer<typeof withdrawalQuerySchema>) {
    return this.list({ ...input, userId });
  }

  async listForAdmin(input: z.infer<typeof adminWithdrawalQuerySchema>) {
    return this.list(input);
  }

  private async list(input: {
    page: number;
    pageSize: number;
    sortOrder: 'asc' | 'desc';
    status?: WithdrawalStatusValue;
    currency?: string;
    walletId?: string;
    userId?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const where = {
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.currency ? { currencyCode: input.currency } : {}),
      ...(input.walletId ? { walletId: input.walletId } : {}),
      ...(input.dateFrom || input.dateTo
        ? {
            createdAt: {
              ...(input.dateFrom ? { gte: new Date(input.dateFrom) } : {}),
              ...(input.dateTo ? { lte: new Date(input.dateTo) } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.client.withdrawal.findMany({
        where,
        include: withdrawalInclude,
        orderBy: [{ createdAt: input.sortOrder }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.client.withdrawal.count({ where }),
    ]);
    return {
      items: items.map(toWithdrawalDto),
      meta: paginationMeta(input.page, input.pageSize, total),
    };
  }

  async getForUser(userId: string, withdrawalId: string) {
    const withdrawal = await this.client.withdrawal.findFirst({
      where: { id: withdrawalId, userId },
      include: withdrawalInclude,
    });
    if (!withdrawal) throw AppError.notFound(ErrorCode.WITHDRAWAL_NOT_FOUND, 'Withdrawal not found');
    return toWithdrawalDto(withdrawal);
  }

  async getForAdmin(withdrawalId: string) {
    const withdrawal = await this.client.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: withdrawalInclude,
    });
    if (!withdrawal) throw AppError.notFound(ErrorCode.WITHDRAWAL_NOT_FOUND, 'Withdrawal not found');
    return toWithdrawalDto(withdrawal);
  }

  async approve(
    actor: { userId: string; role: UserRole },
    withdrawalId: string,
    note?: string,
  ): Promise<ReturnType<typeof toWithdrawalDto>> {
    assertPermission(actor.role, Permission.WITHDRAWALS_REVIEW);
    await this.client.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
        include: withdrawalInclude,
      });
      if (!withdrawal) throw AppError.notFound(ErrorCode.WITHDRAWAL_NOT_FOUND, 'Withdrawal not found');
      if (withdrawal.status !== 'PENDING' && withdrawal.status !== 'UNDER_REVIEW') {
        throw AppError.conflict(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Withdrawal in status ${withdrawal.status} cannot be approved`,
        );
      }
      await this.wallets.lockUsersAdvisory(tx, [withdrawal.userId]);
      const [walletLock] = await this.wallets.lockWallets(tx, [withdrawal.walletId]);
      if (!walletLock || walletLock.status !== 'ACTIVE') {
        throw AppError.unprocessable(ErrorCode.WALLET_NOT_ACTIVE, 'Wallet is not active');
      }
      const updated = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: { in: ['PENDING', 'UNDER_REVIEW'] } },
        data: {
          status: 'APPROVED',
          reviewedById: actor.userId,
          reviewedAt: new Date(),
          reviewNote: note ?? null,
        },
      });
      if (updated.count === 0) {
        throw AppError.conflict(ErrorCode.INVALID_STATE_TRANSITION, 'Withdrawal was already reviewed');
      }
      await tx.financialTransaction.update({
        where: { id: withdrawal.transactionId },
        data: { status: 'PROCESSING' },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'WITHDRAWAL_APPROVED',
          entityType: 'Withdrawal',
          entityId: withdrawalId,
          beforeState: { status: withdrawal.status },
          afterState: { status: 'APPROVED' },
          reason: note ?? 'Approved by reviewer',
        },
        tx,
      );
    });

    await this.notifications.createSafely({
      userId: (await this.getReviewOwner(withdrawalId)).userId,
      type: 'WITHDRAWAL_UPDATE',
      title: 'Withdrawal approved',
      body: 'Your withdrawal was approved and is being processed.',
      data: { withdrawalId },
    });

    try {
      await this.dispatchPayout(withdrawalId);
    } catch (error) {
      logger.error(
        { withdrawalId, error: error instanceof Error ? error.message : 'unknown' },
        'Approved withdrawal payout dispatch failed; withdrawal remains in progress for retry',
      );
    }
    return this.getForAdmin(withdrawalId);
  }

  async reject(
    actor: { userId: string; role: UserRole },
    withdrawalId: string,
    reason: string,
  ): Promise<ReturnType<typeof toWithdrawalDto>> {
    assertPermission(actor.role, Permission.WITHDRAWALS_REVIEW);
    const result = await this.client.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
        include: withdrawalInclude,
      });
      if (!withdrawal) throw AppError.notFound(ErrorCode.WITHDRAWAL_NOT_FOUND, 'Withdrawal not found');
      if (withdrawal.status !== 'PENDING' && withdrawal.status !== 'UNDER_REVIEW') {
        throw AppError.conflict(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Withdrawal in status ${withdrawal.status} cannot be rejected`,
        );
      }
      await this.wallets.lockUsersAdvisory(tx, [withdrawal.userId]);
      await this.wallets.lockWallets(tx, [withdrawal.walletId]);
      await this.releaseHold(tx, withdrawal.walletId, withdrawal.transactionId);
      const updated = await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: 'REJECTED',
          reviewedById: actor.userId,
          reviewedAt: new Date(),
          rejectionReason: reason,
        },
        include: withdrawalInclude,
      });
      await tx.financialTransaction.update({
        where: { id: withdrawal.transactionId },
        data: {
          status: 'CANCELLED',
          failureCode: 'REVIEW_REJECTED',
          failureReason: reason,
        },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'WITHDRAWAL_REJECTED',
          entityType: 'Withdrawal',
          entityId: withdrawalId,
          beforeState: { status: withdrawal.status },
          afterState: { status: 'REJECTED' },
          reason,
        },
        tx,
      );
      return { dto: toWithdrawalDto(updated), userId: withdrawal.userId };
    });

    await this.notifications.createSafely({
      userId: result.userId,
      type: 'WITHDRAWAL_UPDATE',
      title: 'Withdrawal rejected',
      body: `Your withdrawal was rejected. Reason: ${reason}`,
      data: { withdrawalId },
    });
    return result.dto;
  }

  async cancel(
    userId: string,
    withdrawalId: string,
    reason?: string,
  ): Promise<ReturnType<typeof toWithdrawalDto>> {
    const result = await this.client.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findFirst({
        where: { id: withdrawalId, userId },
        include: withdrawalInclude,
      });
      if (!withdrawal) throw AppError.notFound(ErrorCode.WITHDRAWAL_NOT_FOUND, 'Withdrawal not found');
      if (!['PENDING', 'UNDER_REVIEW'].includes(withdrawal.status)) {
        throw AppError.conflict(
          ErrorCode.INVALID_STATE_TRANSITION,
          'Only withdrawals that have not been approved can be cancelled',
        );
      }
      await this.wallets.lockUsersAdvisory(tx, [userId]);
      await this.wallets.lockWallets(tx, [withdrawal.walletId]);
      await this.releaseHold(tx, withdrawal.walletId, withdrawal.transactionId);
      const updated = await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: 'CANCELLED',
          failureReason: reason ?? 'Cancelled by customer',
        },
        include: withdrawalInclude,
      });
      await tx.financialTransaction.update({
        where: { id: withdrawal.transactionId },
        data: {
          status: 'CANCELLED',
          failureCode: 'CUSTOMER_CANCELLED',
          failureReason: reason ?? 'Cancelled by customer',
        },
      });
      await this.audit.record(
        {
          actorUserId: userId,
          actorRole: 'CUSTOMER',
          action: 'WITHDRAWAL_CANCELLED',
          entityType: 'Withdrawal',
          entityId: withdrawalId,
          beforeState: { status: withdrawal.status },
          afterState: { status: 'CANCELLED' },
          reason: reason ?? 'Cancelled by customer',
        },
        tx,
      );
      return toWithdrawalDto(updated);
    });
    return result;
  }

  /**
   * Moves an APPROVED withdrawal into PROCESSING, then calls the payout provider strictly
   * outside any database transaction or lock. Provider success/failure is settled separately.
   */
  async processPayout(withdrawalId: string): Promise<ReturnType<typeof toWithdrawalDto>> {
    const claimed = await this.client.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
        include: withdrawalInclude,
      });
      if (!withdrawal) throw AppError.notFound(ErrorCode.WITHDRAWAL_NOT_FOUND, 'Withdrawal not found');
      if (withdrawal.status === 'COMPLETED' || withdrawal.status === 'FAILED' || withdrawal.status === 'REJECTED' || withdrawal.status === 'CANCELLED') {
        return { shouldProcess: false, withdrawal };
      }
      if (withdrawal.status === 'PROCESSING') {
        return { shouldProcess: true, withdrawal };
      }
      if (withdrawal.status !== 'APPROVED') {
        throw AppError.conflict(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Withdrawal in status ${withdrawal.status} cannot be paid out`,
        );
      }
      const updated = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: 'APPROVED' },
        data: { status: 'PROCESSING', payoutAttempts: { increment: 1 }, lastPayoutError: null },
      });
      if (updated.count === 0) return { shouldProcess: false, withdrawal };
      await tx.financialTransaction.update({
        where: { id: withdrawal.transactionId },
        data: { status: 'PROCESSING' },
      });
      return {
        shouldProcess: true,
        withdrawal: { ...withdrawal, status: 'PROCESSING' as const },
      };
    });

    if (!claimed.shouldProcess) return toWithdrawalDto(claimed.withdrawal);
    return this.executePayout(withdrawalId);
  }

  async retryPayout(
    actor: { userId: string; role: UserRole },
    withdrawalId: string,
  ): Promise<ReturnType<typeof toWithdrawalDto>> {
    assertPermission(actor.role, Permission.WITHDRAWALS_REVIEW);
    const withdrawal = await this.client.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) throw AppError.notFound(ErrorCode.WITHDRAWAL_NOT_FOUND, 'Withdrawal not found');
    if (withdrawal.status !== 'PROCESSING') {
      throw AppError.conflict(
        ErrorCode.INVALID_STATE_TRANSITION,
        'Only a withdrawal stuck in PROCESSING can be retried',
      );
    }
    await this.client.withdrawal.update({
      where: { id: withdrawalId },
      data: { payoutAttempts: { increment: 1 }, lastPayoutError: null },
    });
    return this.executePayout(withdrawalId);
  }

  private async executePayout(withdrawalId: string): Promise<ReturnType<typeof toWithdrawalDto>> {
    const withdrawal = await this.client.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: withdrawalInclude,
    });
    if (!withdrawal) throw AppError.notFound(ErrorCode.WITHDRAWAL_NOT_FOUND, 'Withdrawal not found');
    if (withdrawal.status === 'COMPLETED') return toWithdrawalDto(withdrawal);
    if (withdrawal.status !== 'PROCESSING') {
      throw AppError.conflict(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Withdrawal in status ${withdrawal.status} is not payable`,
      );
    }

    let payoutResult: PayoutResult;
    try {
      payoutResult = await this.payout.createPayout({
        withdrawalId: withdrawal.id,
        amountMinor: withdrawal.amountMinor,
        currencyCode: withdrawal.currencyCode,
        bankName: withdrawal.payoutMethod.bankName,
        accountLast4: withdrawal.payoutMethod.accountLast4,
        idempotencyKey: `withdrawal:${withdrawal.id}`,
      });
    } catch (error) {
      await this.client.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          lastPayoutError: error instanceof Error ? error.message.slice(0, 500) : 'Payout provider error',
        },
      });
      throw new AppError(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'The payout provider did not return a definitive result. The withdrawal remains in PROCESSING for review.',
        502,
        { cause: error },
      );
    }

    if (payoutResult.success) {
      return this.settlePayout(withdrawalId, payoutResult.providerReference);
    }
    return this.failPayout(
      withdrawalId,
      payoutResult.providerReference,
      payoutResult.failureCode ?? 'PAYOUT_FAILED',
      payoutResult.failureReason ?? 'The payout provider rejected the withdrawal.',
    );
  }

  private async settlePayout(
    withdrawalId: string,
    providerReference: string,
  ): Promise<ReturnType<typeof toWithdrawalDto>> {
    const result = await this.client.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
        include: withdrawalInclude,
      });
      if (!withdrawal) throw AppError.notFound(ErrorCode.WITHDRAWAL_NOT_FOUND, 'Withdrawal not found');
      if (withdrawal.status === 'COMPLETED') return { dto: toWithdrawalDto(withdrawal), userId: withdrawal.userId };
      if (withdrawal.status !== 'PROCESSING') {
        throw AppError.conflict(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Withdrawal in status ${withdrawal.status} cannot be settled`,
        );
      }
      await this.wallets.lockUsersAdvisory(tx, [withdrawal.userId]);
      const [walletLock] = await this.wallets.lockWallets(tx, [withdrawal.walletId]);
      if (!walletLock) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');

      const hold = await tx.walletHold.findUnique({ where: { transactionId: withdrawal.transactionId } });
      const totalMinor = withdrawal.amountMinor + withdrawal.feeMinor;
      if (!hold || hold.status !== 'ACTIVE' || hold.amountMinor !== totalMinor) {
        throw new AppError(
          ErrorCode.LEDGER_IMBALANCE,
          'Withdrawal hold is missing or inconsistent',
          500,
          { expose: false },
        );
      }

      const clearing = await this.ledger.systemAccount(tx, 'PAYOUT_CLEARING', withdrawal.currencyCode);
      const feeRevenue =
        withdrawal.feeMinor > 0n
          ? await this.ledger.systemAccount(tx, 'FEE_REVENUE', withdrawal.currencyCode)
          : null;
      const journal = await this.ledger.post({
        tx,
        currencyCode: withdrawal.currencyCode,
        description: `Withdrawal ${withdrawal.transaction.reference}`,
        transactionId: withdrawal.transactionId,
        metadata: { providerReference, payoutProvider: this.payout.provider },
        lines: [
          {
            ledgerAccountId: walletLock.ledgerAccountId,
            direction: 'DEBIT',
            amountMinor: totalMinor,
            description: 'Withdrawal from wallet',
          },
          {
            ledgerAccountId: clearing.id,
            direction: 'CREDIT',
            amountMinor: withdrawal.amountMinor,
            description: 'Payout to customer bank account',
          },
          ...(feeRevenue
            ? [
                {
                  ledgerAccountId: feeRevenue.id,
                  direction: 'CREDIT' as const,
                  amountMinor: withdrawal.feeMinor,
                  description: 'Withdrawal fee',
                },
              ]
            : []),
        ],
      });

      await tx.walletHold.update({
        where: { id: hold.id },
        data: { status: 'CONSUMED', consumedAt: new Date() },
      });
      const held = await tx.$executeRaw`
        UPDATE "wallet_accounts"
        SET "heldMinor" = "heldMinor" - ${totalMinor},
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE "id" = ${walletLock.walletAccountId}
          AND "heldMinor" >= ${totalMinor}
      `;
      if (held !== 1) {
        throw new AppError(ErrorCode.LEDGER_IMBALANCE, 'Held balance projection is inconsistent', 500, {
          expose: false,
        });
      }

      const now = new Date();
      const updated = await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: 'COMPLETED',
          payoutReference: providerReference,
          completedAt: now,
          lastPayoutError: null,
          failureCode: null,
          failureReason: null,
        },
        include: withdrawalInclude,
      });
      await tx.financialTransaction.update({
        where: { id: withdrawal.transactionId },
        data: {
          status: 'COMPLETED',
          completedAt: now,
          metadata: {
            payoutReference: providerReference,
            journalReference: journal.reference,
            payoutProvider: this.payout.provider,
          },
        },
      });
      await this.audit.record(
        {
          actorUserId: null,
          actorRole: 'SYSTEM',
          action: 'WITHDRAWAL_COMPLETED',
          entityType: 'Withdrawal',
          entityId: withdrawalId,
          beforeState: { status: 'PROCESSING' },
          afterState: {
            status: 'COMPLETED',
            journalReference: journal.reference,
            payoutReference: providerReference,
          },
        },
        tx,
      );
      return { dto: toWithdrawalDto(updated), userId: withdrawal.userId };
    });

    await this.notifications.createSafely({
      userId: result.userId,
      type: 'WITHDRAWAL_UPDATE',
      title: 'Withdrawal completed',
      body: `Your withdrawal of ${result.dto.amount} ${result.dto.currency} was paid out.`,
      data: { withdrawalId, reference: result.dto.reference },
    });
    return result.dto;
  }

  private async failPayout(
    withdrawalId: string,
    providerReference: string,
    failureCode: string,
    failureReason: string,
  ): Promise<ReturnType<typeof toWithdrawalDto>> {
    const result = await this.client.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
        include: withdrawalInclude,
      });
      if (!withdrawal) throw AppError.notFound(ErrorCode.WITHDRAWAL_NOT_FOUND, 'Withdrawal not found');
      if (withdrawal.status === 'FAILED' || withdrawal.status === 'COMPLETED') {
        return { dto: toWithdrawalDto(withdrawal), userId: withdrawal.userId, changed: false };
      }
      if (withdrawal.status !== 'PROCESSING') {
        throw AppError.conflict(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Withdrawal in status ${withdrawal.status} cannot be failed`,
        );
      }
      await this.wallets.lockUsersAdvisory(tx, [withdrawal.userId]);
      await this.wallets.lockWallets(tx, [withdrawal.walletId]);
      await this.releaseHold(tx, withdrawal.walletId, withdrawal.transactionId);
      const updated = await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: 'FAILED',
          payoutReference: providerReference,
          failureCode,
          failureReason,
          lastPayoutError: failureReason,
        },
        include: withdrawalInclude,
      });
      await tx.financialTransaction.update({
        where: { id: withdrawal.transactionId },
        data: { status: 'FAILED', failureCode, failureReason },
      });
      await this.audit.record(
        {
          actorUserId: null,
          actorRole: 'SYSTEM',
          action: 'WITHDRAWAL_FAILED',
          entityType: 'Withdrawal',
          entityId: withdrawalId,
          beforeState: { status: 'PROCESSING' },
          afterState: { status: 'FAILED', failureCode },
          reason: failureReason,
        },
        tx,
      );
      return { dto: toWithdrawalDto(updated), userId: withdrawal.userId, changed: true };
    });

    if (result.changed) {
      await this.notifications.createSafely({
        userId: result.userId,
        type: 'WITHDRAWAL_UPDATE',
        title: 'Withdrawal failed',
        body: `Your withdrawal could not be completed and the reserved funds were released. Reason: ${failureReason}`,
        data: { withdrawalId, failureCode },
      });
    }
    return result.dto;
  }

  private async releaseHold(tx: TransactionClient, walletId: string, transactionId: string): Promise<void> {
    const hold = await tx.walletHold.findUnique({ where: { transactionId } });
    if (!hold || hold.status !== 'ACTIVE') return;
    const walletAccount = await tx.walletAccount.findUnique({ where: { walletId } });
    if (!walletAccount) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet account not found');
    await tx.walletHold.update({
      where: { id: hold.id },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    const updated = await tx.$executeRaw`
      UPDATE "wallet_accounts"
      SET "heldMinor" = "heldMinor" - ${hold.amountMinor},
          "version" = "version" + 1,
          "updatedAt" = NOW()
      WHERE "id" = ${walletAccount.id}
        AND "heldMinor" >= ${hold.amountMinor}
    `;
    if (updated !== 1) {
      throw new AppError(ErrorCode.LEDGER_IMBALANCE, 'Held balance projection is inconsistent', 500, {
        expose: false,
      });
    }
  }

  private async getReviewOwner(withdrawalId: string): Promise<{ userId: string }> {
    const withdrawal = await this.client.withdrawal.findUniqueOrThrow({
      where: { id: withdrawalId },
      select: { userId: true },
    });
    return withdrawal;
  }

  private async dispatchPayout(withdrawalId: string): Promise<void> {
    if (this.payoutQueue) {
      const queued = await this.payoutQueue.enqueuePayout(withdrawalId);
      if (queued) return;
    }
    await this.processPayout(withdrawalId);
  }
}
