import type { Currency, FinancialTransaction, Transfer, User } from '@prisma/client';
import { formatMinor } from '../../common/money/money';

type TransferWithRelations = Transfer & {
  transaction: FinancialTransaction & { currency: Currency };
  sender: Pick<User, 'id' | 'name'>;
  recipient: Pick<User, 'id' | 'name'>;
  sourceWallet: { id: string; name: string; userId: string };
  destinationWallet: { id: string; name: string; userId: string };
};

export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0] ?? 'Customer';
  return `${parts[0]} ${(parts[parts.length - 1]?.[0] ?? '').toUpperCase()}.`;
}

export function toTransferDto(transfer: TransferWithRelations, viewerUserId: string) {
  const exponent = transfer.transaction.currency.exponent;
  const isSender = transfer.senderUserId === viewerUserId;
  const counterparty = isSender ? transfer.recipient : transfer.sender;
  return {
    id: transfer.id,
    reference: transfer.transaction.reference,
    type: 'TRANSFER',
    status: transfer.transaction.status,
    direction: isSender ? 'DEBIT' : transfer.recipientUserId === viewerUserId ? 'CREDIT' : 'NONE',
    amount: formatMinor(transfer.amountMinor, exponent),
    amountMinor: transfer.amountMinor.toString(),
    fee: formatMinor(transfer.feeMinor, exponent),
    feeMinor: transfer.feeMinor.toString(),
    totalDebit: isSender ? formatMinor(transfer.amountMinor + transfer.feeMinor, exponent) : undefined,
    currency: transfer.currencyCode,
    description: transfer.description,
    sourceWallet:
      transfer.senderUserId === viewerUserId ? { id: transfer.sourceWalletId, name: transfer.sourceWallet.name } : undefined,
    destinationWallet:
      transfer.recipientUserId === viewerUserId
        ? { id: transfer.destinationWalletId, name: transfer.destinationWallet.name }
        : undefined,
    counterparty: {
      name: maskName(counterparty.name),
      id: counterparty.id === viewerUserId ? counterparty.id : undefined,
    },
    journalReference: undefined as string | undefined,
    createdAt: transfer.createdAt,
    completedAt: transfer.transaction.completedAt,
  };
}
