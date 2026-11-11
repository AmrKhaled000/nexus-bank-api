import { Prisma, type WalletStatus } from '@prisma/client';
import type { TransactionClient } from '../../infrastructure/database/prisma';
import { prisma } from '../../infrastructure/database/prisma';

export interface LockedWallet {
  walletId: string;
  userId: string;
  currencyCode: string;
  status: WalletStatus;
  balanceMinor: bigint;
  heldMinor: bigint;
  walletAccountId: string;
  ledgerAccountId: string;
}

export class WalletRepository {
  async findForUser(walletId: string, userId: string) {
    return prisma.wallet.findFirst({
      where: { id: walletId, userId },
      include: { walletAccount: true, currency: true, ledgerAccount: true },
    });
  }

  async findById(walletId: string) {
    return prisma.wallet.findUnique({
      where: { id: walletId },
      include: { walletAccount: true, currency: true, ledgerAccount: true },
    });
  }

  async listForUser(userId: string) {
    return prisma.wallet.findMany({
      where: { userId },
      include: { walletAccount: true, currency: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Locks wallet rows and their balance projections in deterministic wallet-account order.
   * Callers must invoke this only after acquiring advisory locks for the involved users.
   */
  async lockWallets(tx: TransactionClient, walletIds: string[]): Promise<LockedWallet[]> {
    if (walletIds.length === 0) return [];
    const uniqueIds = [...new Set(walletIds)];
    const rows = await tx.$queryRaw<
      Array<{
        walletId: string;
        userId: string;
        currencyCode: string;
        status: WalletStatus;
        balanceMinor: bigint;
        heldMinor: bigint;
        walletAccountId: string;
        ledgerAccountId: string;
      }>
    >(Prisma.sql`
      SELECT
        w."id" AS "walletId",
        w."userId" AS "userId",
        w."currencyCode" AS "currencyCode",
        w."status" AS "status",
        wa."balanceMinor" AS "balanceMinor",
        wa."heldMinor" AS "heldMinor",
        wa."id" AS "walletAccountId",
        wa."ledgerAccountId" AS "ledgerAccountId"
      FROM "wallets" w
      JOIN "wallet_accounts" wa ON wa."walletId" = w."id"
      WHERE w."id" IN (${Prisma.join(uniqueIds)})
      ORDER BY wa."id" ASC
      FOR UPDATE OF w, wa
    `);
    if (rows.length !== uniqueIds.length) {
      throw new Error('Expected all requested wallets to have balance projections');
    }
    return rows;
  }

  async lockUserAdvisory(tx: TransactionClient, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
  }

  async lockUsersAdvisory(tx: TransactionClient, userIds: string[]): Promise<void> {
    for (const userId of [...new Set(userIds)].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
    }
  }

  async lockWalletCreation(tx: TransactionClient, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wallet:${userId}`}, 0))`;
  }

  async countForUser(tx: TransactionClient, userId: string): Promise<number> {
    return tx.wallet.count({ where: { userId, status: { not: 'CLOSED' } } });
  }
}

export const walletRepository = new WalletRepository();
