import { AppError, ErrorCode } from '../../common/errors/app-error';
import { toCsv } from '../../common/utils/csv';
import { formatMinor } from '../../common/money/money';
import { TransactionRepository, maskName, transactionBaseDto } from './transaction.repository';
import type { transactionQuerySchema } from './transaction.schemas';
import type { z } from 'zod';
import type { WalletRepository } from '../wallets/wallet.repository';

export class TransactionService {
  constructor(
    private readonly repository: TransactionRepository = new TransactionRepository(),
    private readonly wallets?: WalletRepository,
  ) {}

  async listForUser(userId: string, input: z.infer<typeof transactionQuerySchema>) {
    const { items, total, meta } = await this.repository.listForUser(userId, input);
    const dtoItems = items.map((item) => this.mapListItem(userId, item));
    if (input.format === 'csv') {
      if (total > 5_000) {
        throw AppError.unprocessable(
          ErrorCode.VALIDATION_ERROR,
          'CSV export is limited to 5,000 transactions. Narrow the date range or filters.',
        );
      }
      const exportPage = await this.repository.listForUser(userId, {
        ...input,
        page: 1,
        pageSize: Math.min(total, 5_000),
      });
      const csv = toCsv(
        [
          { key: 'createdAt', header: 'Date' },
          { key: 'reference', header: 'Reference' },
          { key: 'type', header: 'Type' },
          { key: 'status', header: 'Status' },
          { key: 'direction', header: 'Direction' },
          { key: 'amount', header: 'Amount' },
          { key: 'fee', header: 'Fee' },
          { key: 'currency', header: 'Currency' },
          { key: 'description', header: 'Description' },
          { key: 'counterparty', header: 'Counterparty' },
        ],
        exportPage.items.map((item) => {
          const dto = this.mapListItem(userId, item);
          return {
            ...dto,
            counterparty: dto.counterparty?.name ?? '',
            description: dto.description ?? '',
          };
        }),
      );
      return { csv, total };
    }
    return { items: dtoItems, meta };
  }

  async getForUser(userId: string, transactionId: string) {
    const found = await this.repository.findAccessible(userId, transactionId);
    if (!found) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Transaction not found');
    return this.mapDetail(userId, found);
  }

  async receipt(userId: string, transactionId: string) {
    const detail = await this.getForUser(userId, transactionId);
    return {
      issuer: 'NEXUS BANK (educational simulation)',
      receiptReference: `RCPT-${detail.reference}`,
      transaction: detail,
      generatedAt: new Date(),
      disclaimer: 'This is a simulated transaction receipt and is not proof of a real-money payment.',
    };
  }

  async exportWalletCsv(userId: string, walletId: string) {
    if (!this.wallets) throw new Error('Wallet repository not configured');
    const wallet = await this.wallets.findForUser(walletId, userId);
    if (!wallet) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
    const result = await this.listForUser(userId, {
      page: 1,
      pageSize: 100,
      sortOrder: 'desc',
      sortBy: 'createdAt',
      walletId,
      format: 'csv',
    });
    return { wallet, csv: 'csv' in result ? result.csv : '' };
  }

  mapListItem(userId: string, item: any) {
    const exponent = item.currency.exponent;
    const base = transactionBaseDto(item, exponent);
    const ownSource = item.sourceWallet?.userId === userId;
    const ownDestination = item.destinationWallet?.userId === userId;
    let direction: 'DEBIT' | 'CREDIT' | 'INTERNAL' | 'NONE' = 'NONE';
    if (ownSource && ownDestination) direction = 'INTERNAL';
    else if (ownSource) direction = 'DEBIT';
    else if (ownDestination) direction = 'CREDIT';

    let counterparty: { name: string; walletId?: string } | null = null;
    if (item.transfer) {
      const other = ownSource && !ownDestination ? item.transfer.recipient : item.transfer.sender;
      if (other && other.id !== userId) {
        counterparty = { name: maskName(other.name) };
      }
    }
    return {
      ...base,
      direction,
      sourceWalletId: ownSource ? item.sourceWallet?.id : undefined,
      destinationWalletId: ownDestination ? item.destinationWallet?.id : undefined,
      walletId:
        direction === 'CREDIT'
          ? item.destinationWallet?.id
          : direction === 'DEBIT' || direction === 'INTERNAL'
            ? item.sourceWallet?.id
            : undefined,
      counterparty,
    };
  }

  mapDetail(userId: string, item: any) {
    const base = this.mapListItem(userId, item);
    const transaction = item;
    return {
      ...base,
      failureReason:
        transaction.status === 'FAILED' || transaction.status === 'CANCELLED' ? transaction.failureReason : null,
      journalReferences: transaction.journalEntries?.map((entry: any) => entry.reference) ?? [],
      depositStatus: transaction.deposit?.status,
      withdrawalStatus: transaction.withdrawal?.status,
      reversal: transaction.type === 'REVERSAL',
    };
  }

  formatAmount(minor: bigint, exponent: number): string {
    return formatMinor(minor, exponent);
  }
}

export const transactionRepository = new TransactionRepository();
export const transactionService = new TransactionService(transactionRepository);
