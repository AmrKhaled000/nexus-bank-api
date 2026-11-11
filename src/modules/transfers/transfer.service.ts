import type { PrismaClient, UserRole } from '@prisma/client';
import type { z } from 'zod';
import type { AppConfig } from '../../config/env';
import { config } from '../../config/env';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { assertPermission, Permission } from '../../common/security/permissions';
import { parseAmountToMinor, formatMinor } from '../../common/money/money';
import { publicReference } from '../../common/ids/reference';
import { logger } from '../../infrastructure/logging/logger';
import { prisma, type TransactionClient } from '../../infrastructure/database/prisma';
import { LedgerService } from '../ledger/ledger.service';
import type { WalletRepository} from '../wallets/wallet.repository';
import { walletRepository } from '../wallets/wallet.repository';
import type { LimitService, FeeService} from '../limits/limit.service';
import { limitService, feeService } from '../limits/limit.service';
import type { IdempotencyService} from '../idempotency/idempotency.service';
import { idempotencyService, type IdempotentExecution } from '../idempotency/idempotency.service';
import type { NotificationService} from '../notifications/notification.service';
import { notificationService } from '../notifications/notification.service';
import { SecurityEventService } from '../security/security-event.service';
import { AuditService } from '../audit/audit.service';
import { PinService } from '../security/pin.service';
import { maskName, toTransferDto } from './transfer.dto';
import type { createTransferSchema, transferQuerySchema } from './transfer.schemas';
import { paginationMeta } from '../../common/validation/pagination';

interface TransferResult {
  transfer: ReturnType<typeof toTransferDto>;
}

export class TransferService {
  constructor(
    private readonly client: PrismaClient = prisma,
    private readonly wallets: WalletRepository = walletRepository,
    private readonly ledger: LedgerService = new LedgerService(),
    private readonly limits: LimitService = limitService,
    private readonly fees: FeeService = feeService,
    private readonly idempotency: IdempotencyService = idempotencyService,
    private readonly notifications: NotificationService = notificationService,
    private readonly securityEvents: SecurityEventService = new SecurityEventService(),
    private readonly audit: AuditService = new AuditService(),
    private readonly pins: PinService = new PinService(config, new SecurityEventService()),
    private readonly settings: AppConfig = config,
  ) {}

  async create(
    userId: string,
    input: z.infer<typeof createTransferSchema>,
    idempotency: { key: string; requestHash: string },
  ): Promise<IdempotentExecution<TransferResult>> {
    await this.pins.verifyForTransaction(userId, input.pin);

    const execution = await this.idempotency.run<TransferResult>(
      {
        userId,
        scope: 'transfers.create',
        key: idempotency.key,
        requestHash: idempotency.requestHash,
      },
      async (tx) => {
        const result = await this.performTransfer(tx, userId, input);
        return {
          data: result,
          statusCode: 201,
          resourceType: 'transfer',
          resourceId: result.transfer.id,
        };
      },
    );

    if (!execution.replayed) {
      await this.notifyTransfer(userId, execution.result.transfer);
      await this.assessSuspiciousActivity(userId, execution.result.transfer);
    }
    return execution;
  }

  private async performTransfer(
    tx: TransactionClient,
    userId: string,
    input: z.infer<typeof createTransferSchema>,
  ): Promise<TransferResult> {
    const sender = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, status: true, emailVerifiedAt: true, role: true },
    });
    if (!sender) throw AppError.unauthorized();
    if (sender.status !== 'ACTIVE' || !sender.emailVerifiedAt) {
      throw AppError.forbidden(ErrorCode.ACCOUNT_SUSPENDED, 'An active, verified account is required for transfers');
    }
    if (input.sourceWalletId === input.destinationWalletId) {
      throw AppError.unprocessable(ErrorCode.CONFLICT, 'Source and destination wallets must differ');
    }

    const source = await tx.wallet.findFirst({
      where: { id: input.sourceWalletId, userId },
      include: { currency: true },
    });
    if (!source) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Source wallet not found');
    if (source.status !== 'ACTIVE') {
      throw AppError.unprocessable(ErrorCode.WALLET_NOT_ACTIVE, 'Source wallet is not active');
    }

    const destination = await tx.wallet.findUnique({
      where: { id: input.destinationWalletId },
      include: { currency: true, user: { select: { id: true, name: true, status: true } } },
    });
    if (!destination) {
      throw AppError.notFound(ErrorCode.RECIPIENT_WALLET_NOT_FOUND, 'Destination wallet not found');
    }
    if (destination.status !== 'ACTIVE') {
      throw AppError.unprocessable(ErrorCode.WALLET_NOT_ACTIVE, 'Destination wallet is not active');
    }
    if (destination.currencyCode !== source.currencyCode) {
      throw AppError.unprocessable(ErrorCode.CURRENCY_MISMATCH, 'Wallets must share the same currency');
    }
    if (destination.user.status !== 'ACTIVE') {
      throw AppError.unprocessable(ErrorCode.RECIPIENT_WALLET_NOT_FOUND, 'Destination account is not available');
    }

    const amountMinor = parseAmountToMinor(input.amount, source.currency.exponent);
    const fee = await this.fees.quote('TRANSFER', amountMinor, source.currencyCode);
    const totalDebit = amountMinor + fee.feeMinor;

    await this.wallets.lockUsersAdvisory(tx, [userId, destination.userId]);
    const locked = await this.wallets.lockWallets(tx, [input.sourceWalletId, input.destinationWalletId]);
    const sourceLock = locked.find((wallet) => wallet.walletId === input.sourceWalletId);
    const destinationLock = locked.find((wallet) => wallet.walletId === input.destinationWalletId);
    if (!sourceLock || !destinationLock) {
      throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
    }
    if (sourceLock.status !== 'ACTIVE' || destinationLock.status !== 'ACTIVE') {
      throw AppError.unprocessable(ErrorCode.WALLET_NOT_ACTIVE, 'One of the wallets is not active');
    }

    await this.limits.assertWithinLimits(tx, {
      scope: 'TRANSFER',
      currencyCode: source.currencyCode,
      userId,
      amountMinor,
    });

    const available = sourceLock.balanceMinor - sourceLock.heldMinor;
    if (available < totalDebit) {
      throw AppError.unprocessable(ErrorCode.INSUFFICIENT_FUNDS, 'Insufficient available balance', {
        availableMinor: available.toString(),
        requiredMinor: totalDebit.toString(),
      });
    }

    const reference = publicReference('TX');
    const now = new Date();
    const transaction = await tx.financialTransaction.create({
      data: {
        reference,
        type: 'TRANSFER',
        status: 'COMPLETED',
        amountMinor,
        feeMinor: fee.feeMinor,
        currencyCode: source.currencyCode,
        initiatorUserId: userId,
        sourceWalletId: input.sourceWalletId,
        destinationWalletId: input.destinationWalletId,
        description: input.description ?? 'Internal transfer',
        completedAt: now,
      },
    });
    const transfer = await tx.transfer.create({
      data: {
        transactionId: transaction.id,
        senderUserId: userId,
        recipientUserId: destination.userId,
        sourceWalletId: input.sourceWalletId,
        destinationWalletId: input.destinationWalletId,
        amountMinor,
        feeMinor: fee.feeMinor,
        currencyCode: source.currencyCode,
        description: input.description,
      },
      include: {
        transaction: { include: { currency: true } },
        sender: { select: { id: true, name: true } },
        recipient: { select: { id: true, name: true } },
        sourceWallet: { select: { id: true, name: true, userId: true } },
        destinationWallet: { select: { id: true, name: true, userId: true } },
      },
    });

    const feeAccount =
      fee.feeMinor > 0n ? await this.ledger.systemAccount(tx, 'FEE_REVENUE', source.currencyCode) : null;
    const lines = [
      {
        ledgerAccountId: sourceLock.ledgerAccountId,
        direction: 'DEBIT' as const,
        amountMinor: totalDebit,
        description: `Transfer to ${maskName(destination.user.name)}`,
      },
      {
        ledgerAccountId: destinationLock.ledgerAccountId,
        direction: 'CREDIT' as const,
        amountMinor,
        description: `Transfer from ${maskName(sender.name)}`,
      },
      ...(feeAccount
        ? [
            {
              ledgerAccountId: feeAccount.id,
              direction: 'CREDIT' as const,
              amountMinor: fee.feeMinor,
              description: 'Transfer fee',
            },
          ]
        : []),
    ];

    const journal = await this.ledger.post({
      tx,
      currencyCode: source.currencyCode,
      description: `Internal transfer ${reference}`,
      lines,
      transactionId: transaction.id,
      createdById: userId,
    });

    if (amountMinor >= BigInt(this.settings.SUSPICIOUS_AMOUNT_MINOR)) {
      await this.securityEvents.record(
        {
          userId,
          type: 'SUSPICIOUS_TRANSACTION',
          severity: 'HIGH',
          metadata: { reference, amountMinor: amountMinor.toString(), currency: source.currencyCode },
        },
        tx,
      );
    }

    const dto = toTransferDto(transfer, userId);
    return { transfer: { ...dto, journalReference: journal.reference } };
  }

  async list(userId: string, input: z.infer<typeof transferQuerySchema>) {
    const accessFilter =
      input.direction === 'sent'
        ? { senderUserId: userId }
        : input.direction === 'received'
          ? { recipientUserId: userId }
          : { OR: [{ senderUserId: userId }, { recipientUserId: userId }] };
    const where = {
      ...accessFilter,
      ...(input.currency ? { currencyCode: input.currency } : {}),
      ...(input.status ? { transaction: { status: input.status } } : {}),
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
      this.client.transfer.findMany({
        where,
        include: {
          transaction: { include: { currency: true } },
          sender: { select: { id: true, name: true } },
          recipient: { select: { id: true, name: true } },
          sourceWallet: { select: { id: true, name: true, userId: true } },
          destinationWallet: { select: { id: true, name: true, userId: true } },
        },
        orderBy: [{ createdAt: input.sortOrder }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.client.transfer.count({ where }),
    ]);
    return {
      items: items.map((item) => toTransferDto(item, userId)),
      meta: paginationMeta(input.page, input.pageSize, total),
    };
  }

  async get(userId: string, transferId: string) {
    const transfer = await this.client.transfer.findFirst({
      where: {
        id: transferId,
        OR: [{ senderUserId: userId }, { recipientUserId: userId }],
      },
      include: {
        transaction: { include: { currency: true } },
        sender: { select: { id: true, name: true } },
        recipient: { select: { id: true, name: true } },
        sourceWallet: { select: { id: true, name: true, userId: true } },
        destinationWallet: { select: { id: true, name: true, userId: true } },
      },
    });
    if (!transfer) throw AppError.notFound(ErrorCode.TRANSFER_NOT_FOUND, 'Transfer not found');
    return toTransferDto(transfer, userId);
  }

  async reverse(
    actor: { userId: string; role: UserRole },
    transferId: string,
    reason: string,
    idempotency: { key: string; requestHash: string },
  ): Promise<IdempotentExecution<{ reversal: unknown }>> {
    assertPermission(actor.role, Permission.TRANSFERS_REVERSE);
    return this.idempotency.run<{ reversal: unknown }>(
      {
        userId: actor.userId,
        scope: 'transfers.reverse',
        key: idempotency.key,
        requestHash: idempotency.requestHash,
      },
      async (tx) => {
        const transfer = await tx.transfer.findUnique({
          where: { id: transferId },
          include: {
            transaction: { include: { currency: true, journalEntries: { include: { lines: true } } } },
            sender: { select: { id: true, name: true } },
            recipient: { select: { id: true, name: true } },
          },
        });
        if (!transfer) throw AppError.notFound(ErrorCode.TRANSFER_NOT_FOUND, 'Transfer not found');
        if (transfer.transaction.status === 'REVERSED') {
          throw AppError.conflict(ErrorCode.TRANSFER_ALREADY_REVERSED, 'Transfer has already been reversed');
        }
        if (transfer.transaction.status !== 'COMPLETED') {
          throw AppError.conflict(ErrorCode.INVALID_STATE_TRANSITION, 'Only completed transfers can be reversed');
        }
        const originalJournal = transfer.transaction.journalEntries[0];
        if (!originalJournal) {
          throw AppError.conflict(ErrorCode.LEDGER_IMBALANCE, 'Original journal entry is missing');
        }

        await this.wallets.lockUsersAdvisory(tx, [transfer.senderUserId, transfer.recipientUserId]);
        const locked = await this.wallets.lockWallets(tx, [
          transfer.sourceWalletId,
          transfer.destinationWalletId,
        ]);
        const recipientLock = locked.find((wallet) => wallet.walletId === transfer.destinationWalletId);
        const senderLock = locked.find((wallet) => wallet.walletId === transfer.sourceWalletId);
        if (!recipientLock || !senderLock) {
          throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
        }
        const recipientAvailable = recipientLock.balanceMinor - recipientLock.heldMinor;
        if (recipientAvailable < transfer.amountMinor) {
          throw AppError.unprocessable(
            ErrorCode.INSUFFICIENT_FUNDS,
            'Recipient no longer has sufficient funds for a reversal',
          );
        }

        const reference = publicReference('TX');
        const now = new Date();
        const reversalTransaction = await tx.financialTransaction.create({
          data: {
            reference,
            type: 'REVERSAL',
            status: 'COMPLETED',
            amountMinor: transfer.amountMinor,
            feeMinor: transfer.feeMinor,
            currencyCode: transfer.currencyCode,
            sourceWalletId: transfer.destinationWalletId,
            destinationWalletId: transfer.sourceWalletId,
            description: `Reversal of ${transfer.transaction.reference}: ${reason}`,
            completedAt: now,
            metadata: { reversedTransactionId: transfer.transactionId, actorUserId: actor.userId, reason },
          },
        });

        const lines = originalJournal.lines.map((line) => ({
          ledgerAccountId: line.ledgerAccountId,
          direction: line.debitMinor > 0n ? ('CREDIT' as const) : ('DEBIT' as const),
          amountMinor: line.debitMinor > 0n ? line.debitMinor : line.creditMinor,
          description: `Reversal of ${originalJournal.reference}`,
        }));
        const reversalJournal = await this.ledger.post({
          tx,
          currencyCode: transfer.currencyCode,
          description: `Reversal of transfer ${transfer.transaction.reference}`,
          lines,
          transactionId: reversalTransaction.id,
          createdById: actor.userId,
          reversesEntryId: originalJournal.id,
          metadata: { reason },
        });

        await tx.financialTransaction.update({
          where: { id: transfer.transactionId },
          data: {
            status: 'REVERSED',
            failureReason: `Reversed by ${actor.userId}: ${reason}`,
          },
        });
        await this.audit.record(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'TRANSFER_REVERSED',
            entityType: 'Transfer',
            entityId: transferId,
            beforeState: { transactionStatus: 'COMPLETED' },
            afterState: { transactionStatus: 'REVERSED', reversalReference: reference },
            reason,
          },
          tx,
        );

        return {
          data: {
            reversal: {
              id: reversalTransaction.id,
              reference,
              type: 'REVERSAL',
              status: 'COMPLETED',
              amount: formatMinor(transfer.amountMinor, transfer.transaction.currency.exponent),
              currency: transfer.currencyCode,
              journalReference: reversalJournal.reference,
              originalReference: transfer.transaction.reference,
            },
          },
          statusCode: 201,
          resourceType: 'transaction',
          resourceId: reversalTransaction.id,
        };
      },
    );
  }

  private async notifyTransfer(userId: string, transfer: ReturnType<typeof toTransferDto>): Promise<void> {
    await this.notifications.createSafely({
      userId,
      type: 'TRANSFER_SENT',
      title: 'Transfer completed',
      body: `Your transfer of ${transfer.amount} ${transfer.currency} was completed. Reference: ${transfer.reference}.`,
      data: { reference: transfer.reference, transferId: transfer.id },
    });
    if (transfer.counterparty.id && transfer.counterparty.id !== userId) {
      await this.notifications.createSafely({
        userId: transfer.counterparty.id,
        type: 'TRANSFER_RECEIVED',
        title: 'Money received',
        body: `You received ${transfer.amount} ${transfer.currency}. Reference: ${transfer.reference}.`,
        data: { reference: transfer.reference, transferId: transfer.id },
      });
    }
  }

  private async assessSuspiciousActivity(userId: string, transfer: ReturnType<typeof toTransferDto>): Promise<void> {
    try {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
      const count = await this.client.transfer.count({
        where: { senderUserId: userId, createdAt: { gte: tenMinutesAgo } },
      });
      if (count >= 5) {
        await this.securityEvents.record({
          userId,
          type: 'SUSPICIOUS_TRANSACTION',
          severity: 'HIGH',
          metadata: { reason: 'velocity', transfersInWindow: count, reference: transfer.reference },
        });
      }
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : 'unknown' }, 'Suspicious activity assessment failed');
    }
  }
}
