import type { Currency, Deposit, FinancialTransaction, Wallet } from '@prisma/client';
import { formatMinor } from '../../common/money/money';

type DepositWithRelations = Deposit & {
  transaction: FinancialTransaction;
  currency: Currency;
  wallet: Pick<Wallet, 'id' | 'name'>;
};

interface DepositMetadata {
  checkoutUrl?: string;
  clientSecret?: string;
  intentReference?: string;
}

function readMetadata(value: FinancialTransaction['metadata']): DepositMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.checkoutUrl === 'string' ? { checkoutUrl: record.checkoutUrl } : {}),
    ...(typeof record.clientSecret === 'string' ? { clientSecret: record.clientSecret } : {}),
    ...(typeof record.intentReference === 'string' ? { intentReference: record.intentReference } : {}),
  };
}

export function toDepositDto(deposit: DepositWithRelations) {
  const exponent = deposit.currency.exponent;
  const metadata = readMetadata(deposit.transaction.metadata);
  return {
    id: deposit.id,
    reference: deposit.transaction.reference,
    wallet: {
      id: deposit.wallet.id,
      name: deposit.wallet.name,
    },
    amount: formatMinor(deposit.amountMinor, exponent),
    amountMinor: deposit.amountMinor.toString(),
    currency: deposit.currencyCode,
    provider: deposit.provider,
    providerReference: deposit.providerReference,
    status: deposit.status,
    failureReason: deposit.failureReason,
    checkoutUrl: metadata.checkoutUrl ?? null,
    expiresAt: deposit.expiresAt,
    createdAt: deposit.createdAt,
    updatedAt: deposit.updatedAt,
    completedAt: deposit.completedAt,
  };
}
