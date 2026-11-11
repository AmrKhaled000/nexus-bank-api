import type { Currency, Deposit, FinancialTransaction, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { config } from '../../config/env';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { sha256 } from '../../common/crypto/crypto';
import { formatMinor } from '../../common/money/money';
import { prisma, isUniqueConstraintError, type TransactionClient } from '../../infrastructure/database/prisma';
import {
  createPaymentGateway,
  type PaymentGatewayProvider,
} from '../../infrastructure/payments/gateway-factory';
import { SimulatedPaymentGateway } from '../../infrastructure/payments/simulated-payment.gateway';
import { signWebhookPayload } from '../../infrastructure/payments/webhook-signature';
import { LedgerService } from '../ledger/ledger.service';
import type { WalletRepository} from '../wallets/wallet.repository';
import { walletRepository } from '../wallets/wallet.repository';
import type { NotificationService} from '../notifications/notification.service';
import { notificationService } from '../notifications/notification.service';
import { SecurityEventService } from '../security/security-event.service';
import { AuditService } from '../audit/audit.service';

export type WebhookProcessingStatus = 'processed' | 'ignored' | 'duplicate' | 'failed';

export interface WebhookProcessingResult {
  eventId: string;
  status: WebhookProcessingStatus;
  duplicate: boolean;
  message?: string;
  depositId?: string;
}

type DepositWithRelations = Deposit & {
  transaction: FinancialTransaction;
  currency: Currency;
};

/**
 * Processes signed provider events exactly once. Signature verification happens before any
 * database access. Event deduplication and ledger settlement share one transaction, so a
 * webhook cannot be recorded without also settling its deposit (or vice versa).
 */
export class PaymentWebhookService {
  constructor(
    private readonly client: PrismaClient = prisma,
    private readonly ledger: LedgerService = new LedgerService(),
    private readonly wallets: WalletRepository = walletRepository,
    private readonly notifications: NotificationService = notificationService,
    private readonly securityEvents: SecurityEventService = new SecurityEventService(),
    private readonly audit: AuditService = new AuditService(),
    private readonly settings: AppConfig = config,
  ) {}

  async process(
    provider: PaymentGatewayProvider,
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<WebhookProcessingResult> {
    const gateway = createPaymentGateway(this.settings, provider);
    const event = await gateway.parseWebhook(rawBody, headers);
    if (!event) {
      return {
        eventId: 'unsupported',
        status: 'ignored',
        duplicate: false,
        message: 'The provider event type is not handled by this endpoint.',
      };
    }

    const payloadHash = sha256(rawBody);
    try {
      return await this.client.$transaction(
        async (tx) => {
          await tx.webhookEvent.create({
            data: {
              provider,
              eventId: event.eventId,
              payloadHash,
              status: 'PROCESSED',
              processedAt: new Date(),
            },
          });

          if (event.type === 'payout.completed' || event.type === 'payout.failed') {
            // The only configured payout provider is simulated and synchronous, so payout
            // events are acknowledged without a second settlement path.
            await tx.webhookEvent.update({
              where: { provider_eventId: { provider, eventId: event.eventId } },
              data: { status: 'IGNORED', error: 'Synchronous payout provider does not emit webhooks' },
            });
            return this.result(event.eventId, 'ignored', false);
          }

          const deposit = await tx.deposit.findUnique({
            where: { providerReference: event.providerReference },
            include: { transaction: true, currency: true },
          });
          if (!deposit) {
            await tx.webhookEvent.update({
              where: { provider_eventId: { provider, eventId: event.eventId } },
              data: { status: 'IGNORED', error: 'Unknown provider reference' },
            });
            return this.result(event.eventId, 'ignored', false, 'Unknown provider reference');
          }
          if (deposit.provider !== provider) {
            await this.markFailed(tx, provider, event.eventId, 'Provider does not match the deposit');
            return this.result(event.eventId, 'failed', false, 'Provider does not match the deposit', deposit.id);
          }

          if (event.type === 'deposit.failed') {
            return this.failDeposit(tx, provider, event.eventId, event.rawType, deposit);
          }

          return this.completeDeposit(tx, provider, event.eventId, event.rawType, event.amountMinor, event.currencyCode, deposit);
        },
        { maxWait: 5_000, timeout: 20_000 },
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return this.result(event.eventId, 'duplicate', true, 'This provider event was already processed.');
      }
      throw error;
    }
  }

  /**
   * Educational sandbox helper: constructs a provider-shaped event, signs it with the same
   * webhook secret and feeds it through the public verification path. Disabled in production.
   */
  async simulateDeposit(
    userId: string,
    depositId: string,
    outcome: 'completed' | 'failed',
  ): Promise<WebhookProcessingResult> {
    if (this.settings.isProduction) {
      throw AppError.forbidden(ErrorCode.FORBIDDEN, 'Simulated deposits are disabled in production');
    }
    const deposit = await this.client.deposit.findFirst({
      where: { id: depositId, userId },
      include: { transaction: true, currency: true },
    });
    if (!deposit) throw AppError.notFound(ErrorCode.DEPOSIT_NOT_FOUND, 'Deposit not found');
    if (deposit.provider !== 'SIMULATED') {
      throw AppError.unprocessable(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'This deposit was not created with the simulated provider',
      );
    }
    if (deposit.status === 'COMPLETED') {
      return this.result('simulated', 'duplicate', true, 'Deposit is already completed', deposit.id);
    }
    if (deposit.status === 'CANCELLED' || deposit.status === 'FAILED') {
      throw AppError.conflict(ErrorCode.INVALID_STATE_TRANSITION, 'This deposit can no longer be simulated');
    }

    const payload = SimulatedPaymentGateway.demoEvent({
      eventId: SimulatedPaymentGateway.newEventId(),
      type: outcome === 'completed' ? 'deposit.completed' : 'deposit.failed',
      providerReference: deposit.providerReference,
      amountMinor: deposit.amountMinor,
      currencyCode: deposit.currencyCode,
    });
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    return this.process('SIMULATED', rawBody, {
      'x-nexus-signature': signWebhookPayload(rawBody, this.settings.PAYMENT_WEBHOOK_SECRET),
      'content-type': 'application/json',
    });
  }

  private async completeDeposit(
    tx: TransactionClient,
    provider: PaymentGatewayProvider,
    eventId: string,
    rawType: string,
    eventAmountMinor: bigint | null,
    eventCurrencyCode: string | null,
    deposit: DepositWithRelations,
  ): Promise<WebhookProcessingResult> {
    if (deposit.status === 'CANCELLED' || deposit.status === 'FAILED') {
      await tx.webhookEvent.update({
        where: { provider_eventId: { provider, eventId } },
        data: { status: 'IGNORED', error: `Deposit is ${deposit.status}` },
      });
      return this.result(eventId, 'ignored', false, `Deposit is ${deposit.status}`, deposit.id);
    }
    if (eventAmountMinor !== null && eventAmountMinor !== deposit.amountMinor) {
      await this.markFailed(tx, provider, eventId, 'Provider amount does not match the deposit');
      await this.securityEvents.record(
        {
          userId: deposit.userId,
          type: 'SUSPICIOUS_TRANSACTION',
          severity: 'CRITICAL',
          metadata: {
            reason: 'webhook_amount_mismatch',
            depositId: deposit.id,
            expectedMinor: deposit.amountMinor.toString(),
            receivedMinor: eventAmountMinor.toString(),
          },
        },
        tx,
      );
      return this.result(eventId, 'failed', false, 'Provider amount does not match the deposit', deposit.id);
    }
    if (eventCurrencyCode !== null && eventCurrencyCode !== deposit.currencyCode) {
      await this.markFailed(tx, provider, eventId, 'Provider currency does not match the deposit');
      await this.securityEvents.record(
        {
          userId: deposit.userId,
          type: 'SUSPICIOUS_TRANSACTION',
          severity: 'CRITICAL',
          metadata: {
            reason: 'webhook_currency_mismatch',
            depositId: deposit.id,
            expectedCurrency: deposit.currencyCode,
            receivedCurrency: eventCurrencyCode,
          },
        },
        tx,
      );
      return this.result(eventId, 'failed', false, 'Provider currency does not match the deposit', deposit.id);
    }
    if (deposit.status === 'COMPLETED' || deposit.transaction.status === 'COMPLETED') {
      await tx.webhookEvent.update({
        where: { provider_eventId: { provider, eventId } },
        data: { status: 'IGNORED', error: 'Deposit already settled' },
      });
      return this.result(eventId, 'ignored', false, 'Deposit already settled', deposit.id);
    }

    await this.wallets.lockUsersAdvisory(tx, [deposit.userId]);
    const locked = await this.wallets.lockWallets(tx, [deposit.walletId]);
    const wallet = locked[0];
    if (!wallet) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
    if (wallet.status !== 'ACTIVE') {
      await this.markFailed(tx, provider, eventId, 'Wallet is not active');
      return this.result(eventId, 'failed', false, 'Wallet is not active', deposit.id);
    }

    const cash = await this.ledger.systemAccount(tx, 'CASH', deposit.currencyCode);
    const journal = await this.ledger.post({
      tx,
      currencyCode: deposit.currencyCode,
      description: `Deposit ${deposit.transaction.reference} via ${provider}`,
      transactionId: deposit.transactionId,
      metadata: { provider, providerEventId: eventId, rawType },
      lines: [
        {
          ledgerAccountId: cash.id,
          direction: 'DEBIT',
          amountMinor: deposit.amountMinor,
          description: `Cash received from ${provider}`,
        },
        {
          ledgerAccountId: wallet.ledgerAccountId,
          direction: 'CREDIT',
          amountMinor: deposit.amountMinor,
          description: 'Wallet deposit',
        },
      ],
    });

    const now = new Date();
    await tx.deposit.update({
      where: { id: deposit.id },
      data: { status: 'COMPLETED', completedAt: now, failureCode: null, failureReason: null },
    });
    await tx.financialTransaction.update({
      where: { id: deposit.transactionId },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        metadata: {
          ...(deposit.transaction.metadata as Record<string, unknown> | null),
          provider,
          providerEventId: eventId,
          journalReference: journal.reference,
        },
      },
    });
    await this.audit.record(
      {
        actorUserId: null,
        actorRole: 'SYSTEM',
        action: 'DEPOSIT_SETTLED',
        entityType: 'Deposit',
        entityId: deposit.id,
        beforeState: { status: deposit.status },
        afterState: {
          status: 'COMPLETED',
          journalReference: journal.reference,
          amountMinor: deposit.amountMinor.toString(),
        },
        reason: `Signed ${provider} webhook ${eventId}`,
      },
      tx,
    );

    setImmediate(() => {
      void this.notifications
        .createSafely({
          userId: deposit.userId,
          type: 'DEPOSIT_COMPLETED',
          title: 'Deposit completed',
          body: `Your deposit of ${formatMinor(deposit.amountMinor, deposit.currency.exponent)} ${deposit.currencyCode} has been credited. Reference: ${deposit.transaction.reference}.`,
          data: { depositId: deposit.id, reference: deposit.transaction.reference },
        })
        .catch(() => undefined);
    });

    return this.result(eventId, 'processed', false, undefined, deposit.id);
  }

  private async failDeposit(
    tx: TransactionClient,
    provider: PaymentGatewayProvider,
    eventId: string,
    rawType: string,
    deposit: DepositWithRelations,
  ): Promise<WebhookProcessingResult> {
    if (deposit.status === 'COMPLETED' || deposit.transaction.status === 'COMPLETED') {
      await tx.webhookEvent.update({
        where: { provider_eventId: { provider, eventId } },
        data: { status: 'IGNORED', error: 'Completed deposits cannot be failed by a late event' },
      });
      return this.result(eventId, 'ignored', false, 'Completed deposits cannot be failed', deposit.id);
    }
    if (deposit.status === 'FAILED' || deposit.status === 'CANCELLED') {
      await tx.webhookEvent.update({
        where: { provider_eventId: { provider, eventId } },
        data: { status: 'IGNORED', error: `Deposit already ${deposit.status}` },
      });
      return this.result(eventId, 'ignored', false, `Deposit already ${deposit.status}`, deposit.id);
    }

    await tx.deposit.update({
      where: { id: deposit.id },
      data: {
        status: 'FAILED',
        failureCode: 'PROVIDER_DECLINED',
        failureReason: `Deposit failed at the payment provider (${rawType}).`,
      },
    });
    await tx.financialTransaction.update({
      where: { id: deposit.transactionId },
      data: {
        status: 'FAILED',
        failureCode: 'PROVIDER_DECLINED',
        failureReason: `Deposit failed at the payment provider (${rawType}).`,
      },
    });
    await this.audit.record(
      {
        actorUserId: null,
        actorRole: 'SYSTEM',
        action: 'DEPOSIT_FAILED',
        entityType: 'Deposit',
        entityId: deposit.id,
        beforeState: { status: deposit.status },
        afterState: { status: 'FAILED' },
        reason: `Signed ${provider} webhook ${eventId}`,
      },
      tx,
    );
    setImmediate(() => {
      void this.notifications
        .createSafely({
          userId: deposit.userId,
          type: 'DEPOSIT_FAILED',
          title: 'Deposit failed',
          body: `Your deposit of ${formatMinor(deposit.amountMinor, deposit.currency.exponent)} ${deposit.currencyCode} could not be completed.`,
          data: { depositId: deposit.id, reference: deposit.transaction.reference },
        })
        .catch(() => undefined);
    });
    return this.result(eventId, 'processed', false, 'Deposit marked failed', deposit.id);
  }

  private async markFailed(
    tx: TransactionClient,
    provider: PaymentGatewayProvider,
    eventId: string,
    error: string,
  ): Promise<void> {
    await tx.webhookEvent.update({
      where: { provider_eventId: { provider, eventId } },
      data: { status: 'FAILED', error },
    });
  }

  private result(
    eventId: string,
    status: WebhookProcessingStatus,
    duplicate: boolean,
    message?: string,
    depositId?: string,
  ): WebhookProcessingResult {
    return {
      eventId,
      status,
      duplicate,
      ...(message ? { message } : {}),
      ...(depositId ? { depositId } : {}),
    };
  }
}

export const paymentWebhookService = new PaymentWebhookService();
