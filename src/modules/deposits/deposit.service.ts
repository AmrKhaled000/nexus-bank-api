import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import type { AppConfig } from '../../config/env';
import { config } from '../../config/env';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { parseAmountToMinor } from '../../common/money/money';
import { logger } from '../../infrastructure/logging/logger';
import { prisma } from '../../infrastructure/database/prisma';
import { createPaymentGateway, type PaymentGatewayProvider } from '../../infrastructure/payments/gateway-factory';
import { LedgerService } from '../ledger/ledger.service';
import type { WalletRepository} from '../wallets/wallet.repository';
import { walletRepository } from '../wallets/wallet.repository';
import type { LimitService} from '../limits/limit.service';
import { limitService } from '../limits/limit.service';
import type {
  IdempotencyService} from '../idempotency/idempotency.service';
import {
  idempotencyService,
  type IdempotentExecution,
} from '../idempotency/idempotency.service';
import type { NotificationService} from '../notifications/notification.service';
import { notificationService } from '../notifications/notification.service';
import { AuditService } from '../audit/audit.service';
import { toDepositDto } from './deposit.dto';
import type { createDepositSchema, depositQuerySchema } from './deposit.schemas';
import { paginationMeta } from '../../common/validation/pagination';

interface DepositResult {
  deposit: ReturnType<typeof toDepositDto>;
  simulation?: {
    available: boolean;
    endpoint?: string;
    note?: string;
  };
}

/**
 * The transaction reference is deterministically derived from the idempotency context. This lets
 * the provider intent be created before any database lock is held, while retries with the same
 * key and payload map to the same provider idempotency key instead of creating orphan intents.
 */
function deterministicDepositReference(context: { userId: string; key: string; requestHash: string }): string {
  const digest = createHash('sha256')
    .update(`deposit:${context.userId}:${context.key}:${context.requestHash}`)
    .digest('hex')
    .slice(0, 24)
    .toUpperCase();
  return `DEP-${digest}`;
}

export class DepositService {
  constructor(
    private readonly client: PrismaClient = prisma,
    private readonly ledger: LedgerService = new LedgerService(),
    private readonly wallets: WalletRepository = walletRepository,
    private readonly limits: LimitService = limitService,
    private readonly idempotency: IdempotencyService = idempotencyService,
    private readonly notifications: NotificationService = notificationService,
    private readonly audit: AuditService = new AuditService(),
    private readonly settings: AppConfig = config,
  ) {}

  async create(
    userId: string,
    input: z.infer<typeof createDepositSchema>,
    idempotency: { key: string; requestHash: string },
  ): Promise<IdempotentExecution<DepositResult>> {
    const context = {
      userId,
      scope: 'deposits.create',
      key: idempotency.key,
      requestHash: idempotency.requestHash,
    };
    const replay = await this.idempotency.preview<DepositResult>(context);
    if (replay) return replay;

    const user = await this.client.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, emailVerifiedAt: true },
    });
    if (!user) throw AppError.unauthorized();
    if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
      throw AppError.forbidden(ErrorCode.ACCOUNT_SUSPENDED, 'An active, verified account is required for deposits');
    }
    const wallet = await this.client.wallet.findFirst({
      where: { id: input.walletId, userId },
      include: { currency: true },
    });
    if (!wallet) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
    if (wallet.status !== 'ACTIVE') {
      throw AppError.unprocessable(ErrorCode.WALLET_NOT_ACTIVE, 'Wallet is not active');
    }
    const amountMinor = parseAmountToMinor(input.amount, wallet.currency.exponent);
    const reference = deterministicDepositReference(context);
    const provider: PaymentGatewayProvider = input.provider ?? (this.settings.PAYMENT_PROVIDER === 'stripe' ? 'STRIPE' : 'SIMULATED');

    // External provider call happens before any row lock is acquired.
    const gateway = createPaymentGateway(this.settings, provider);
    const intent = await gateway.createDepositIntent({
      transactionReference: reference,
      amountMinor,
      currencyCode: wallet.currencyCode,
      userId,
      ...(input.description ? { description: input.description } : {}),
    });
    if (intent.providerReference.length > 200) {
      throw AppError.internal('Payment provider returned an unsupported reference');
    }
    const expiresAt = intent.expiresAt ?? new Date(Date.now() + 30 * 60_000);

    const execution = await this.idempotency.run<DepositResult>(context, async (tx) => {
      const freshWallet = await tx.wallet.findFirst({
        where: { id: input.walletId, userId },
        include: { currency: true },
      });
      if (!freshWallet) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
      if (freshWallet.status !== 'ACTIVE') {
        throw AppError.unprocessable(ErrorCode.WALLET_NOT_ACTIVE, 'Wallet is not active');
      }
      if (freshWallet.currencyCode !== wallet.currencyCode) {
        throw AppError.conflict(ErrorCode.CONFLICT, 'Wallet currency changed during the request');
      }

      await this.wallets.lockUserAdvisory(tx, userId);
      await this.limits.assertWithinLimits(tx, {
        scope: 'DEPOSIT',
        currencyCode: freshWallet.currencyCode,
        userId,
        amountMinor,
      });

      const transaction = await tx.financialTransaction.create({
        data: {
          reference,
          type: 'DEPOSIT',
          status: 'PENDING',
          amountMinor,
          feeMinor: 0n,
          currencyCode: freshWallet.currencyCode,
          initiatorUserId: userId,
          destinationWalletId: freshWallet.id,
          description: input.description ?? `Deposit via ${provider.toLowerCase()} provider`,
          metadata: {
            provider,
            providerReference: intent.providerReference,
            intentReference: reference,
            ...(intent.checkoutUrl ? { checkoutUrl: intent.checkoutUrl } : {}),
          },
        },
      });
      const deposit = await tx.deposit.create({
        data: {
          transactionId: transaction.id,
          userId,
          walletId: freshWallet.id,
          currencyCode: freshWallet.currencyCode,
          amountMinor,
          provider,
          providerReference: intent.providerReference,
          status: 'PENDING',
          expiresAt,
        },
        include: {
          transaction: true,
          currency: true,
          wallet: { select: { id: true, name: true } },
        },
      });
      await this.audit.record(
        {
          actorUserId: userId,
          actorRole: 'CUSTOMER',
          action: 'DEPOSIT_INITIATED',
          entityType: 'Deposit',
          entityId: deposit.id,
          afterState: {
            reference,
            amountMinor: amountMinor.toString(),
            currency: freshWallet.currencyCode,
            provider,
            providerReference: intent.providerReference,
          },
        },
        tx,
      );

      const dto = toDepositDto(deposit);
      return {
        data: {
          deposit: dto,
          ...(provider === 'SIMULATED'
            ? {
                simulation: {
                  available: true,
                  endpoint: `${this.settings.API_PREFIX}/deposits/${deposit.id}/simulate`,
                  note: 'Educational sandbox: submit a signed simulated provider event through this endpoint.',
                },
              }
            : {}),
        },
        statusCode: 201,
        resourceType: 'deposit',
        resourceId: deposit.id,
      };
    });

    return execution;
  }

  async list(userId: string, input: z.infer<typeof depositQuerySchema>) {
    const where = {
      userId,
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
      this.client.deposit.findMany({
        where,
        include: {
          transaction: true,
          currency: true,
          wallet: { select: { id: true, name: true } },
        },
        orderBy: [{ createdAt: input.sortOrder }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.client.deposit.count({ where }),
    ]);
    return {
      items: items.map(toDepositDto),
      meta: paginationMeta(input.page, input.pageSize, total),
    };
  }

  async get(userId: string, depositId: string) {
    const deposit = await this.client.deposit.findFirst({
      where: { id: depositId, userId },
      include: {
        transaction: true,
        currency: true,
        wallet: { select: { id: true, name: true } },
      },
    });
    if (!deposit) throw AppError.notFound(ErrorCode.DEPOSIT_NOT_FOUND, 'Deposit not found');
    return toDepositDto(deposit);
  }

  /**
   * Expires stale pending deposits. No ledger entry exists for a pending deposit, so this only
   * transitions state. Conditional updates make it safe against a concurrent settlement webhook.
   */
  async expireStale(limit = 100): Promise<number> {
    const candidates = await this.client.deposit.findMany({
      where: { status: { in: ['PENDING', 'PROCESSING'] }, expiresAt: { lt: new Date() } },
      select: { id: true, transactionId: true, userId: true, amountMinor: true, currencyCode: true },
      take: limit,
      orderBy: { expiresAt: 'asc' },
    });
    let expired = 0;
    for (const candidate of candidates) {
      try {
        const didExpire = await this.client.$transaction(async (tx) => {
          const updated = await tx.deposit.updateMany({
            where: { id: candidate.id, status: { in: ['PENDING', 'PROCESSING'] } },
            data: {
              status: 'EXPIRED',
              failureCode: 'DEPOSIT_EXPIRED',
              failureReason: 'The provider checkout window expired before payment was confirmed.',
            },
          });
          if (updated.count === 0) return false;
          await tx.financialTransaction.updateMany({
            where: { id: candidate.transactionId, status: { in: ['PENDING', 'PROCESSING'] } },
            data: {
              status: 'CANCELLED',
              failureCode: 'DEPOSIT_EXPIRED',
              failureReason: 'Deposit intent expired',
            },
          });
          return true;
        });
        if (didExpire) expired += 1;
      } catch (error) {
        logger.warn(
          { depositId: candidate.id, error: error instanceof Error ? error.message : 'unknown' },
          'Failed to expire deposit',
        );
      }
    }
    return expired;
  }
}
