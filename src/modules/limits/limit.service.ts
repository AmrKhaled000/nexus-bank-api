import type { FeeOperation, LimitScope, TransactionStatus, TransactionType } from '@prisma/client';
import { prisma, type TransactionClient } from '../../infrastructure/database/prisma';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { calculateFee, formatMinor, type FeeResult } from '../../common/money/money';
import type { Currency } from '@prisma/client';

const TRANSACTION_TYPE_BY_SCOPE: Record<LimitScope, TransactionType> = {
  TRANSFER: 'TRANSFER',
  DEPOSIT: 'DEPOSIT',
  WITHDRAWAL: 'WITHDRAWAL',
};

const COUNTED_STATUSES: Record<LimitScope, TransactionStatus[]> = {
  TRANSFER: ['COMPLETED', 'REVERSED'],
  DEPOSIT: ['COMPLETED'],
  WITHDRAWAL: ['PENDING', 'PROCESSING', 'COMPLETED', 'REVERSED'],
};

export interface LimitPolicy {
  id: string;
  scope: LimitScope;
  currencyCode: string;
  userId: string | null;
  perTransactionMinMinor: bigint;
  perTransactionMaxMinor: bigint;
  dailyMaxMinor: bigint | null;
  monthlyMaxMinor: bigint | null;
}

export class LimitService {
  async getPolicy(tx: TransactionClient, scope: LimitScope, currencyCode: string, userId: string): Promise<LimitPolicy> {
    const userPolicy = await tx.transactionLimit.findFirst({
      where: { scope, currencyCode, userId, isActive: true },
    });
    const globalPolicy =
      userPolicy ??
      (await tx.transactionLimit.findFirst({
        where: { scope, currencyCode, userId: null, isActive: true },
      }));
    if (!globalPolicy) {
      throw new AppError(
        ErrorCode.LIMIT_EXCEEDED,
        `No active ${scope.toLowerCase()} limit is configured for ${currencyCode}`,
        500,
        { expose: false },
      );
    }
    return globalPolicy;
  }

  /**
   * Must be called while holding the user's advisory lock. Counts transaction volume in UTC
   * day/month windows so concurrent writes cannot bypass daily or monthly limits.
   */
  async assertWithinLimits(
    tx: TransactionClient,
    input: { scope: LimitScope; currencyCode: string; userId: string; amountMinor: bigint },
  ): Promise<{ policy: LimitPolicy; dailyUsedMinor: bigint; monthlyUsedMinor: bigint }> {
    const policy = await this.getPolicy(tx, input.scope, input.currencyCode, input.userId);
    if (input.amountMinor < policy.perTransactionMinMinor) {
      throw AppError.unprocessable(ErrorCode.LIMIT_EXCEEDED, 'Amount is below the minimum transaction limit');
    }
    if (input.amountMinor > policy.perTransactionMaxMinor) {
      throw AppError.unprocessable(
        ErrorCode.LIMIT_EXCEEDED,
        'Amount exceeds the maximum per-transaction limit',
        { maxMinor: policy.perTransactionMaxMinor.toString() },
      );
    }

    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const type = TRANSACTION_TYPE_BY_SCOPE[input.scope];
    const statuses = COUNTED_STATUSES[input.scope];

    const [daily, monthly] = await Promise.all([
      policy.dailyMaxMinor === null
        ? Promise.resolve({ _sum: { amountMinor: null } })
        : tx.financialTransaction.aggregate({
            where: {
              initiatorUserId: input.userId,
              type,
              status: { in: statuses },
              currencyCode: input.currencyCode,
              createdAt: { gte: startOfDay },
            },
            _sum: { amountMinor: true },
          }),
      policy.monthlyMaxMinor === null
        ? Promise.resolve({ _sum: { amountMinor: null } })
        : tx.financialTransaction.aggregate({
            where: {
              initiatorUserId: input.userId,
              type,
              status: { in: statuses },
              currencyCode: input.currencyCode,
              createdAt: { gte: startOfMonth },
            },
            _sum: { amountMinor: true },
          }),
    ]);

    const dailyUsed = daily._sum.amountMinor ?? 0n;
    const monthlyUsed = monthly._sum.amountMinor ?? 0n;
    if (policy.dailyMaxMinor !== null && dailyUsed + input.amountMinor > policy.dailyMaxMinor) {
      throw AppError.unprocessable(ErrorCode.LIMIT_EXCEEDED, 'Daily transaction limit would be exceeded', {
        dailyMaxMinor: policy.dailyMaxMinor.toString(),
        dailyUsedMinor: dailyUsed.toString(),
      });
    }
    if (policy.monthlyMaxMinor !== null && monthlyUsed + input.amountMinor > policy.monthlyMaxMinor) {
      throw AppError.unprocessable(ErrorCode.LIMIT_EXCEEDED, 'Monthly transaction limit would be exceeded', {
        monthlyMaxMinor: policy.monthlyMaxMinor.toString(),
        monthlyUsedMinor: monthlyUsed.toString(),
      });
    }
    return { policy, dailyUsedMinor: dailyUsed, monthlyUsedMinor: monthlyUsed };
  }

  async describe(scope: LimitScope, currencyCode: string, userId: string) {
    const policy = await this.getPolicy(prisma, scope, currencyCode, userId);
    const currency = await prisma.currency.findUniqueOrThrow({ where: { code: currencyCode } });
    return this.formatPolicy(policy, currency);
  }

  formatPolicy(policy: LimitPolicy, currency: Currency) {
    return {
      scope: policy.scope,
      currency: currency.code,
      perTransactionMin: formatMinor(policy.perTransactionMinMinor, currency.exponent),
      perTransactionMax: formatMinor(policy.perTransactionMaxMinor, currency.exponent),
      dailyMax: policy.dailyMaxMinor ? formatMinor(policy.dailyMaxMinor, currency.exponent) : null,
      monthlyMax: policy.monthlyMaxMinor ? formatMinor(policy.monthlyMaxMinor, currency.exponent) : null,
    };
  }
}

export interface FeePolicyView {
  flatMinor: bigint;
  percentBps: number;
  minFeeMinor: bigint;
  maxFeeMinor: bigint | null;
}

export class FeeService {
  async getPolicy(operation: FeeOperation, currencyCode: string): Promise<FeePolicyView> {
    const policy = await prisma.feePolicy.findUnique({
      where: { operation_currencyCode: { operation, currencyCode } },
    });
    if (!policy || !policy.isActive) {
      return { flatMinor: 0n, percentBps: 0, minFeeMinor: 0n, maxFeeMinor: null };
    }
    return {
      flatMinor: policy.flatMinor,
      percentBps: policy.percentBps,
      minFeeMinor: policy.minFeeMinor,
      maxFeeMinor: policy.maxFeeMinor,
    };
  }

  async quote(operation: FeeOperation, amountMinor: bigint, currencyCode: string): Promise<FeeResult> {
    const policy = await this.getPolicy(operation, currencyCode);
    return calculateFee(amountMinor, policy);
  }
}

export const limitService = new LimitService();
export const feeService = new FeeService();
