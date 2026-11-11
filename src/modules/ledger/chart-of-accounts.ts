import type { LedgerAccountType, NormalBalance } from '@prisma/client';

export type SystemAccountKind =
  | 'CASH'
  | 'PAYOUT_CLEARING'
  | 'FEE_REVENUE'
  | 'ADJUSTMENT_EXPENSE'
  | 'ADJUSTMENT_INCOME';

export interface SystemAccountDefinition {
  codePrefix: string;
  name: string;
  type: LedgerAccountType;
  normalBalance: NormalBalance;
}

export const SYSTEM_ACCOUNTS: Record<SystemAccountKind, SystemAccountDefinition> = {
  CASH: {
    codePrefix: 'SYS:CASH',
    name: 'Cash held at payment custodian',
    type: 'ASSET',
    normalBalance: 'DEBIT',
  },
  PAYOUT_CLEARING: {
    codePrefix: 'SYS:PAYOUT_CLEARING',
    name: 'Payout clearing account',
    type: 'ASSET',
    normalBalance: 'DEBIT',
  },
  FEE_REVENUE: {
    codePrefix: 'SYS:FEE_REVENUE',
    name: 'Fee revenue',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
  },
  ADJUSTMENT_EXPENSE: {
    codePrefix: 'SYS:ADJUSTMENT_EXPENSE',
    name: 'Adjustment expense',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
  },
  ADJUSTMENT_INCOME: {
    codePrefix: 'SYS:ADJUSTMENT_INCOME',
    name: 'Adjustment income',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
  },
};

export function systemAccountCode(kind: SystemAccountKind, currencyCode: string): string {
  return `${SYSTEM_ACCOUNTS[kind].codePrefix}:${currencyCode}`;
}

export function walletLedgerAccountCode(walletId: string): string {
  return `WALLET:${walletId}`;
}
