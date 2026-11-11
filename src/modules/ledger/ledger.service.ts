import type { Prisma} from '@prisma/client';
import { type JournalEntry, type JournalEntryLine } from '@prisma/client';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { assertPositiveMinor, MAX_AMOUNT_MINOR } from '../../common/money/money';
import { publicReference } from '../../common/ids/reference';
import { ledgerJournalEntriesTotal } from '../../infrastructure/observability/metrics';
import type { TransactionClient } from '../../infrastructure/database/prisma';
import {
  SYSTEM_ACCOUNTS,
  systemAccountCode,
  walletLedgerAccountCode,
  type SystemAccountKind,
} from './chart-of-accounts';

export type LineDirection = 'DEBIT' | 'CREDIT';

export interface LedgerLineInput {
  ledgerAccountId: string;
  direction: LineDirection;
  amountMinor: bigint;
  description?: string;
}

export interface PostJournalEntryInput {
  tx: TransactionClient;
  currencyCode: string;
  description: string;
  lines: LedgerLineInput[];
  transactionId?: string;
  createdById?: string;
  reversesEntryId?: string;
  metadata?: Prisma.InputJsonValue;
  reference?: string;
}

export interface PostedJournalEntry extends JournalEntry {
  lines: JournalEntryLine[];
}

export class LedgerService {
  /**
   * Posts an immutable, balanced double-entry journal. Balance and currency invariants are
   * validated here for a clear domain error, and independently enforced by PostgreSQL
   * deferred constraint triggers at COMMIT time (defense in depth).
   */
  async post(input: PostJournalEntryInput): Promise<PostedJournalEntry> {
    const { tx } = input;
    if (input.lines.length < 2) {
      throw new AppError(ErrorCode.LEDGER_IMBALANCE, 'A journal entry requires at least two lines', 500, {
        expose: false,
      });
    }

    let debitTotal = 0n;
    let creditTotal = 0n;
    for (const line of input.lines) {
      assertPositiveMinor(line.amountMinor);
      if (line.amountMinor > MAX_AMOUNT_MINOR) {
        throw new AppError(ErrorCode.LEDGER_IMBALANCE, 'Ledger line exceeds supported maximum', 500, {
          expose: false,
        });
      }
      if (line.direction === 'DEBIT') debitTotal += line.amountMinor;
      else creditTotal += line.amountMinor;
    }
    if (debitTotal !== creditTotal) {
      throw new AppError(ErrorCode.LEDGER_IMBALANCE, 'Journal entry is not balanced', 500, {
        expose: false,
        details: { debitTotal: debitTotal.toString(), creditTotal: creditTotal.toString() },
      });
    }
    if (debitTotal === 0n) {
      throw new AppError(ErrorCode.LEDGER_IMBALANCE, 'Journal entry cannot be zero value', 500, {
        expose: false,
      });
    }

    const accountIds = [...new Set(input.lines.map((line) => line.ledgerAccountId))];
    const accounts = await tx.ledgerAccount.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, currencyCode: true, isActive: true, walletId: true, walletAccount: { select: { id: true } } },
    });
    if (accounts.length !== accountIds.length) {
      throw new AppError(ErrorCode.LEDGER_IMBALANCE, 'Unknown ledger account referenced', 500, { expose: false });
    }
    for (const account of accounts) {
      if (account.currencyCode !== input.currencyCode) {
        throw new AppError(
          ErrorCode.LEDGER_IMBALANCE,
          'All ledger lines must use the journal currency',
          500,
          { expose: false },
        );
      }
      if (!account.isActive) {
        throw new AppError(ErrorCode.LEDGER_IMBALANCE, 'Ledger account is inactive', 500, { expose: false });
      }
    }

    const entry = await tx.journalEntry.create({
      data: {
        reference: input.reference ?? publicReference('JE'),
        currencyCode: input.currencyCode,
        description: input.description,
        transactionId: input.transactionId,
        createdById: input.createdById,
        reversesEntryId: input.reversesEntryId,
        metadata: input.metadata,
        lines: {
          create: input.lines.map((line) => ({
            ledgerAccountId: line.ledgerAccountId,
            debitMinor: line.direction === 'DEBIT' ? line.amountMinor : 0n,
            creditMinor: line.direction === 'CREDIT' ? line.amountMinor : 0n,
            description: line.description,
          })),
        },
      },
      include: { lines: true },
    });

    // Maintain wallet balance projections atomically with the ledger write. The database
    // verifies at COMMIT that each projection equals its ledger account sum.
    for (const line of input.lines) {
      const account = accounts.find((candidate) => candidate.id === line.ledgerAccountId);
      if (!account?.walletId || !account.walletAccount) continue;
      const delta = line.direction === 'CREDIT' ? line.amountMinor : -line.amountMinor;
      await tx.$executeRaw`
        UPDATE "wallet_accounts"
        SET "balanceMinor" = "balanceMinor" + ${delta},
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE "id" = ${account.walletAccount.id}
      `;
    }

    ledgerJournalEntriesTotal.inc({ currency: input.currencyCode });
    return entry;
  }

  async postReversal(
    tx: TransactionClient,
    originalEntryId: string,
    description: string,
    createdById?: string,
  ): Promise<PostedJournalEntry> {
    const original = await tx.journalEntry.findUnique({
      where: { id: originalEntryId },
      include: { lines: true },
    });
    if (!original) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Journal entry not found');
    const reversalLines: LedgerLineInput[] = original.lines.map((line) => ({
      ledgerAccountId: line.ledgerAccountId,
      direction: line.debitMinor > 0n ? 'CREDIT' : 'DEBIT',
      amountMinor: line.debitMinor > 0n ? line.debitMinor : line.creditMinor,
      description: `Reversal of ${original.reference}`,
    }));
    return this.post({
      tx,
      currencyCode: original.currencyCode,
      description,
      lines: reversalLines,
      createdById,
      reversesEntryId: original.id,
      transactionId: original.transactionId ?? undefined,
    });
  }

  async ensureSystemAccounts(
    tx: TransactionClient,
    currencies: Array<{ code: string }>,
  ): Promise<void> {
    const kinds = Object.keys(SYSTEM_ACCOUNTS) as SystemAccountKind[];
    for (const currency of currencies) {
      for (const kind of kinds) {
        const definition = SYSTEM_ACCOUNTS[kind];
        const code = systemAccountCode(kind, currency.code);
        await tx.ledgerAccount.upsert({
          where: { code },
          create: {
            code,
            name: `${definition.name} (${currency.code})`,
            type: definition.type,
            normalBalance: definition.normalBalance,
            currencyCode: currency.code,
            isSystem: true,
          },
          update: {},
        });
      }
    }
  }

  async systemAccount(tx: TransactionClient, kind: keyof typeof SYSTEM_ACCOUNTS, currencyCode: string) {
    const account = await tx.ledgerAccount.findUnique({
      where: { code: systemAccountCode(kind, currencyCode) },
    });
    if (!account) {
      throw new AppError(ErrorCode.LEDGER_IMBALANCE, 'System ledger account is missing', 500, {
        expose: false,
      });
    }
    return account;
  }

  /**
   * Creates a wallet's liability ledger account. Wallet creation must run inside a transaction.
   */
  async createWalletAccount(
    tx: TransactionClient,
    wallet: { id: string; name: string; currencyCode: string; userId: string },
  ): Promise<{ ledgerAccountId: string; walletAccountId: string }> {
    const ledgerAccount = await tx.ledgerAccount.create({
      data: {
        code: walletLedgerAccountCode(wallet.id),
        name: `Wallet liability - ${wallet.name}`,
        type: 'LIABILITY',
        normalBalance: 'CREDIT',
        currencyCode: wallet.currencyCode,
        walletId: wallet.id,
        isSystem: false,
      },
    });
    const walletAccount = await tx.walletAccount.create({
      data: {
        walletId: wallet.id,
        ledgerAccountId: ledgerAccount.id,
        balanceMinor: 0n,
        heldMinor: 0n,
      },
    });
    return { ledgerAccountId: ledgerAccount.id, walletAccountId: walletAccount.id };
  }
}
