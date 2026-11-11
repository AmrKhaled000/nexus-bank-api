import type { FeeOperation, LimitScope, PrismaClient } from '@prisma/client';
import { parseAmountToMinor } from '../src/common/money/money';
import { LedgerService } from '../src/modules/ledger/ledger.service';

export interface CurrencySeed {
  code: string;
  name: string;
  symbol: string;
  exponent: number;
}

export const SUPPORTED_CURRENCIES: CurrencySeed[] = [
  { code: 'USD', name: 'US Dollar', symbol: '$', exponent: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', exponent: 2 },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£', exponent: 2 },
];

const LIMITS: Record<LimitScope, { max: number; daily: number; monthly: number }> = {
  TRANSFER: { max: 50_000, daily: 20_000, monthly: 100_000 },
  DEPOSIT: { max: 50_000, daily: 50_000, monthly: 200_000 },
  WITHDRAWAL: { max: 20_000, daily: 20_000, monthly: 50_000 },
};

function units(amount: number, exponent: number): bigint {
  return BigInt(Math.round(amount)) * 10n ** BigInt(exponent);
}

/**
 * Idempotent reference data required by every environment: currencies, system ledger accounts,
 * transaction limits and fee policies. Demo users are seeded separately by prisma/seed.ts.
 */
export async function seedReferenceData(client: PrismaClient): Promise<void> {
  for (const currency of SUPPORTED_CURRENCIES) {
    await client.currency.upsert({
      where: { code: currency.code },
      create: { ...currency, isActive: true },
      update: { name: currency.name, symbol: currency.symbol, exponent: currency.exponent, isActive: true },
    });
  }

  const currencies = await client.currency.findMany({ where: { isActive: true }, select: { code: true } });
  const ledger = new LedgerService();
  await client.$transaction(async (tx) => {
    await ledger.ensureSystemAccounts(tx, currencies);
  });

  for (const currency of SUPPORTED_CURRENCIES) {
    const factor = 10n ** BigInt(currency.exponent);
    for (const scope of Object.keys(LIMITS) as LimitScope[]) {
      const policy = LIMITS[scope];
      const existing = await client.transactionLimit.findFirst({
        where: { scope, currencyCode: currency.code, userId: null },
      });
      const data = {
        scope,
        currencyCode: currency.code,
        userId: null,
        perTransactionMinMinor: factor,
        perTransactionMaxMinor: units(policy.max, currency.exponent),
        dailyMaxMinor: units(policy.daily, currency.exponent),
        monthlyMaxMinor: units(policy.monthly, currency.exponent),
        isActive: true,
      };
      if (existing) {
        await client.transactionLimit.update({ where: { id: existing.id }, data });
      } else {
        await client.transactionLimit.create({ data });
      }
    }

    const fees: Array<{ operation: FeeOperation; flatMinor: bigint; percentBps: number; maxFeeMinor: bigint }> = [
      { operation: 'TRANSFER', flatMinor: 0n, percentBps: 0, maxFeeMinor: 0n },
      { operation: 'DEPOSIT', flatMinor: 0n, percentBps: 0, maxFeeMinor: 0n },
      {
        // A 50-minor flat fee (0.50 in a two-decimal currency) capped at five major units.
        operation: 'WITHDRAWAL',
        flatMinor: parseAmountToMinor('0.50', currency.exponent),
        percentBps: 0,
        maxFeeMinor: parseAmountToMinor('5.00', currency.exponent),
      },
    ];
    for (const fee of fees) {
      await client.feePolicy.upsert({
        where: { operation_currencyCode: { operation: fee.operation, currencyCode: currency.code } },
        create: {
          operation: fee.operation,
          currencyCode: currency.code,
          flatMinor: fee.flatMinor,
          percentBps: fee.percentBps,
          minFeeMinor: fee.flatMinor,
          maxFeeMinor: fee.maxFeeMinor,
          isActive: true,
        },
        update: {
          flatMinor: fee.flatMinor,
          percentBps: fee.percentBps,
          minFeeMinor: fee.flatMinor,
          maxFeeMinor: fee.maxFeeMinor,
          isActive: true,
        },
      });
    }
  }
}
