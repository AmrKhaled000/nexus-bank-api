import type { Currency, Wallet, WalletAccount } from '@prisma/client';
import { formatMinor } from '../../common/money/money';

type WalletWithRelations = Wallet & {
  currency: Currency;
  walletAccount: WalletAccount | null;
};

export function toWalletDto(wallet: WalletWithRelations) {
  const exponent = wallet.currency.exponent;
  const balance = wallet.walletAccount?.balanceMinor ?? 0n;
  const held = wallet.walletAccount?.heldMinor ?? 0n;
  const available = balance - held;
  return {
    id: wallet.id,
    name: wallet.name,
    type: wallet.type,
    status: wallet.status,
    isPrimary: wallet.isPrimary,
    currency: {
      code: wallet.currency.code,
      name: wallet.currency.name,
      symbol: wallet.currency.symbol,
      exponent,
    },
    balance: {
      total: formatMinor(balance, exponent),
      available: formatMinor(available, exponent),
      held: formatMinor(held, exponent),
      totalMinor: balance.toString(),
      availableMinor: available.toString(),
      heldMinor: held.toString(),
      currency: wallet.currency.code,
    },
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
    closedAt: wallet.closedAt,
  };
}
