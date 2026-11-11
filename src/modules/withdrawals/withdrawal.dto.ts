import type {
  Currency,
  FinancialTransaction,
  PaymentMethodReference,
  Wallet,
  Withdrawal,
} from '@prisma/client';
import { formatMinor } from '../../common/money/money';

type WithdrawalWithRelations = Withdrawal & {
  transaction: FinancialTransaction;
  currency: Currency;
  wallet: Pick<Wallet, 'id' | 'name'>;
  payoutMethod: Pick<PaymentMethodReference, 'id' | 'bankName' | 'accountLast4' | 'isDefault'>;
};

export function toWithdrawalDto(withdrawal: WithdrawalWithRelations) {
  const exponent = withdrawal.currency.exponent;
  const totalMinor = withdrawal.amountMinor + withdrawal.feeMinor;
  return {
    id: withdrawal.id,
    reference: withdrawal.transaction.reference,
    wallet: {
      id: withdrawal.wallet.id,
      name: withdrawal.wallet.name,
    },
    amount: formatMinor(withdrawal.amountMinor, exponent),
    amountMinor: withdrawal.amountMinor.toString(),
    fee: formatMinor(withdrawal.feeMinor, exponent),
    feeMinor: withdrawal.feeMinor.toString(),
    total: formatMinor(totalMinor, exponent),
    totalMinor: totalMinor.toString(),
    currency: withdrawal.currencyCode,
    status: withdrawal.status,
    payoutMethod: {
      id: withdrawal.payoutMethod.id,
      bankName: withdrawal.payoutMethod.bankName,
      accountLast4: withdrawal.payoutMethod.accountLast4,
      isDefault: withdrawal.payoutMethod.isDefault,
    },
    payoutReference: withdrawal.payoutReference,
    payoutAttempts: withdrawal.payoutAttempts,
    lastPayoutError: withdrawal.lastPayoutError,
    reviewedByUserId: withdrawal.reviewedById,
    reviewedAt: withdrawal.reviewedAt,
    reviewNote: withdrawal.reviewNote,
    rejectionReason: withdrawal.rejectionReason,
    failureCode: withdrawal.failureCode,
    failureReason: withdrawal.failureReason,
    createdAt: withdrawal.createdAt,
    updatedAt: withdrawal.updatedAt,
    completedAt: withdrawal.completedAt,
  };
}
