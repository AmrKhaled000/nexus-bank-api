import { AppError, ErrorCode } from '../../common/errors/app-error';
import { formatMinor } from '../../common/money/money';
import { toCsv } from '../../common/utils/csv';
import { TransactionRepository } from '../transactions/transaction.repository';
import { WalletRepository } from '../wallets/wallet.repository';

const MAX_STATEMENT_RANGE_DAYS = 366;
const MAX_STATEMENT_LINES = 10_000;

export class StatementService {
  constructor(
    private readonly wallets: WalletRepository = new WalletRepository(),
    private readonly transactions: TransactionRepository = new TransactionRepository(),
  ) {}

  async generate(
    userId: string,
    walletId: string,
    input: { from?: string; to?: string; format: 'json' | 'csv' },
  ) {
    const wallet = await this.wallets.findForUser(walletId, userId);
    if (!wallet || !wallet.ledgerAccount) {
      throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
    }
    const to = input.to ? new Date(input.to) : new Date();
    const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) {
      throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Statement start must be before end');
    }
    if (to.getTime() - from.getTime() > MAX_STATEMENT_RANGE_DAYS * 86_400_000) {
      throw AppError.unprocessable(
        ErrorCode.VALIDATION_ERROR,
        `Statement range cannot exceed ${MAX_STATEMENT_RANGE_DAYS} days`,
      );
    }

    const { openingMinor, rows } = await this.transactions.getStatement(
      walletId,
      wallet.ledgerAccount.id,
      from,
      to,
      MAX_STATEMENT_LINES,
    );
    if (rows.length > MAX_STATEMENT_LINES) {
      throw AppError.unprocessable(
        ErrorCode.VALIDATION_ERROR,
        'Statement contains too many entries. Narrow the date range.',
      );
    }

    let running = openingMinor;
    const exponent = wallet.currency.exponent;
    const entries = rows.map((row) => {
      running += row.creditMinor - row.debitMinor;
      return {
        postedAt: row.postedAt,
        journalReference: row.entryReference,
        transactionReference: row.transactionReference,
        type: row.type,
        status: row.status,
        description: row.entryDescription,
        debit: row.debitMinor > 0n ? formatMinor(row.debitMinor, exponent) : null,
        credit: row.creditMinor > 0n ? formatMinor(row.creditMinor, exponent) : null,
        balance: formatMinor(running, exponent),
      };
    });

    const statement = {
      wallet: {
        id: wallet.id,
        name: wallet.name,
        currency: wallet.currency.code,
        accountNumberMasked: `NEXUS-${wallet.id.slice(-6).toUpperCase()}`,
      },
      period: { from, to },
      openingBalance: formatMinor(openingMinor, exponent),
      closingBalance: formatMinor(running, exponent),
      currency: wallet.currency.code,
      entries,
      generatedAt: new Date(),
      disclaimer: 'Simulated banking statement for educational purposes only.',
    };

    if (input.format === 'csv') {
      const csv = toCsv(
        [
          { key: 'postedAt', header: 'Posted At' },
          { key: 'journalReference', header: 'Journal Reference' },
          { key: 'transactionReference', header: 'Transaction Reference' },
          { key: 'type', header: 'Type' },
          { key: 'status', header: 'Status' },
          { key: 'description', header: 'Description' },
          { key: 'debit', header: 'Debit' },
          { key: 'credit', header: 'Credit' },
          { key: 'balance', header: 'Balance' },
        ],
        [
          { description: 'Opening balance', balance: formatMinor(openingMinor, exponent) },
          ...entries.map((entry) => ({ ...entry, postedAt: entry.postedAt.toISOString() })),
          { description: 'Closing balance', balance: formatMinor(running, exponent) },
        ],
      );
      return { format: 'csv' as const, csv, filename: `statement-${wallet.id}-${from.toISOString().slice(0, 10)}.csv` };
    }
    return { format: 'json' as const, statement };
  }
}

export const statementService = new StatementService();
