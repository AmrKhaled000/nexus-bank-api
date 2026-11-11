import { Prisma, type FinancialTransaction, type TransactionStatus, type TransactionType } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { paginationArgs, paginationMeta } from '../../common/validation/pagination';
import { formatMinor } from '../../common/money/money';
import type { z } from 'zod';
import type { transactionQuerySchema } from './transaction.schemas';

export interface TransactionView {
  transaction: FinancialTransaction;
  direction: 'DEBIT' | 'CREDIT' | 'INTERNAL' | 'NONE';
  ownedWalletIds: Set<string>;
  counterpartyName: string | null;
}

export class TransactionRepository {
  async findAccessible(userId: string, transactionId: string) {
    return prisma.financialTransaction.findFirst({
      where: {
        id: transactionId,
        OR: [
          { initiatorUserId: userId },
          { sourceWallet: { userId } },
          { destinationWallet: { userId } },
        ],
      },
      include: {
        currency: true,
        sourceWallet: { include: { user: { select: { id: true, name: true } } } },
        destinationWallet: { include: { user: { select: { id: true, name: true } } } },
        transfer: {
          include: {
            sender: { select: { id: true, name: true, email: true } },
            recipient: { select: { id: true, name: true, email: true } },
          },
        },
        deposit: true,
        withdrawal: true,
        journalEntries: { select: { reference: true, createdAt: true } },
      },
    });
  }

  async findById(transactionId: string) {
    return prisma.financialTransaction.findUnique({
      where: { id: transactionId },
      include: {
        currency: true,
        sourceWallet: { include: { user: { select: { id: true, name: true, email: true } } } },
        destinationWallet: { include: { user: { select: { id: true, name: true, email: true } } } },
        transfer: true,
        deposit: true,
        withdrawal: true,
        journalEntries: true,
      },
    });
  }

  async listForUser(userId: string, input: z.infer<typeof transactionQuerySchema>) {
    const accessWhere: Prisma.FinancialTransactionWhereInput = input.walletId
      ? {
          OR: [
            { sourceWalletId: input.walletId, sourceWallet: { userId } },
            { destinationWalletId: input.walletId, destinationWallet: { userId } },
          ],
        }
      : {
          OR: [
            { sourceWallet: { userId } },
            { destinationWallet: { userId } },
            { initiatorUserId: userId },
          ],
        };

    const andConditions: Prisma.FinancialTransactionWhereInput[] = [accessWhere];
    if (input.search) {
      andConditions.push({
        OR: [
          { reference: { contains: input.search, mode: 'insensitive' } },
          { description: { contains: input.search, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.FinancialTransactionWhereInput = {
      AND: andConditions,
      ...(input.type ? { type: input.type } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.currency ? { currencyCode: input.currency } : {}),
      ...(input.dateFrom || input.dateTo
        ? {
            createdAt: {
              ...(input.dateFrom ? { gte: new Date(input.dateFrom) } : {}),
              ...(input.dateTo ? { lte: new Date(input.dateTo) } : {}),
            },
          }
        : {}),
      ...(input.reference ? { reference: { contains: input.reference, mode: 'insensitive' } } : {}),
      ...(input.minAmount || input.maxAmount
        ? {
            amountMinor: {
              ...(input.minAmount ? { gte: BigInt(input.minAmount) } : {}),
              ...(input.maxAmount ? { lte: BigInt(input.maxAmount) } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.financialTransaction.findMany({
        where,
        include: {
          currency: true,
          sourceWallet: { select: { id: true, userId: true, name: true } },
          destinationWallet: { select: { id: true, userId: true, name: true } },
          transfer: {
            include: {
              sender: { select: { id: true, name: true } },
              recipient: { select: { id: true, name: true } },
            },
          },
        },
        orderBy:
          input.sortBy === 'amount'
            ? [{ amountMinor: input.sortOrder }, { createdAt: 'desc' }]
            : [{ createdAt: input.sortOrder }, { id: 'desc' }],
        ...paginationArgs(input),
      }),
      prisma.financialTransaction.count({ where }),
    ]);
    return { items, total, meta: paginationMeta(input.page, input.pageSize, total) };
  }

  async getStatement(walletId: string, ledgerAccountId: string, from: Date, to: Date, limit: number) {
    const openingRows = await prisma.$queryRaw<Array<{ opening: bigint }>>`
      SELECT COALESCE(SUM(l."creditMinor" - l."debitMinor"), 0)::bigint AS "opening"
      FROM "journal_entry_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      WHERE l."ledgerAccountId" = ${ledgerAccountId}
        AND e."createdAt" < ${from}
    `;
    const rows = await prisma.$queryRaw<
      Array<{
        lineId: bigint;
        postedAt: Date;
        entryReference: string;
        entryDescription: string;
        transactionReference: string | null;
        type: TransactionType | null;
        status: TransactionStatus | null;
        debitMinor: bigint;
        creditMinor: bigint;
      }>
    >(Prisma.sql`
      SELECT
        l."id" AS "lineId",
        e."createdAt" AS "postedAt",
        e."reference" AS "entryReference",
        e."description" AS "entryDescription",
        t."reference" AS "transactionReference",
        t."type" AS "type",
        t."status" AS "status",
        l."debitMinor" AS "debitMinor",
        l."creditMinor" AS "creditMinor"
      FROM "journal_entry_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      LEFT JOIN "financial_transactions" t ON t."id" = e."transactionId"
      WHERE l."ledgerAccountId" = ${ledgerAccountId}
        AND e."createdAt" >= ${from}
        AND e."createdAt" <= ${to}
      ORDER BY e."createdAt" ASC, l."id" ASC
      LIMIT ${limit + 1}
    `);
    return { openingMinor: openingRows[0]?.opening ?? 0n, rows, limit };
  }

  async countWalletLines(ledgerAccountId: string): Promise<number> {
    return prisma.journalEntryLine.count({ where: { ledgerAccountId } });
  }
}

export function transactionBaseDto(transaction: FinancialTransaction, currencyExponent: number) {
  return {
    id: transaction.id,
    reference: transaction.reference,
    type: transaction.type,
    status: transaction.status,
    amount: formatMinor(transaction.amountMinor, currencyExponent),
    amountMinor: transaction.amountMinor.toString(),
    fee: formatMinor(transaction.feeMinor, currencyExponent),
    feeMinor: transaction.feeMinor.toString(),
    currency: transaction.currencyCode,
    description: transaction.description,
    createdAt: transaction.createdAt,
    completedAt: transaction.completedAt,
  };
}

export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0] ?? 'Nexus customer';
  return `${parts[0]} ${(parts[parts.length - 1]?.[0] ?? '').toUpperCase()}.`;
}

export function assertTransactionVisibleOrThrow(found: unknown): void {
  if (!found) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Transaction not found');
}
