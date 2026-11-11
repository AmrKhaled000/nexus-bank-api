import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { config as defaultConfig } from '../../config/env';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { prisma } from '../../infrastructure/database/prisma';
import { LedgerService } from '../ledger/ledger.service';
import type { WalletRepository } from './wallet.repository';
import { walletRepository } from './wallet.repository';
import { toWalletDto } from './wallet.dto';
import type { z } from 'zod';
import type { createWalletSchema, updateWalletSchema } from './wallet.schemas';

export class WalletService {
  constructor(
    private readonly client: PrismaClient = prisma,
    private readonly ledger: LedgerService = new LedgerService(),
    private readonly config: AppConfig = defaultConfig,
    private readonly wallets: WalletRepository = walletRepository,
  ) {}

  async create(
    userId: string,
    input: z.infer<typeof createWalletSchema>,
  ): Promise<ReturnType<typeof toWalletDto>> {
    const user = await this.client.user.findUnique({
      where: { id: userId },
      select: { status: true, emailVerifiedAt: true },
    });
    if (!user) throw AppError.unauthorized();
    if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
      throw AppError.forbidden(ErrorCode.ACCOUNT_SUSPENDED, 'An active, verified account is required');
    }
    const currency = await this.client.currency.findUnique({ where: { code: input.currencyCode } });
    if (!currency || !currency.isActive) {
      throw AppError.unprocessable(ErrorCode.CURRENCY_NOT_SUPPORTED, 'Currency is not supported');
    }

    try {
      const wallet = await this.client.$transaction(
        async (tx) => {
          await this.wallets.lockWalletCreation(tx, userId);
          const count = await this.wallets.countForUser(tx, userId);
          if (count >= this.config.MAX_WALLETS_PER_USER) {
            throw AppError.unprocessable(
              ErrorCode.WALLET_LIMIT_REACHED,
              `A maximum of ${this.config.MAX_WALLETS_PER_USER} wallets is allowed`,
            );
          }
          const isPrimary = input.isPrimary ?? count === 0;
          if (isPrimary) {
            await tx.wallet.updateMany({
              where: { userId, currencyCode: input.currencyCode, isPrimary: true },
              data: { isPrimary: false },
            });
          }
          const created = await tx.wallet.create({
            data: {
              userId,
              currencyCode: input.currencyCode,
              name: input.name,
              type: input.type,
              isPrimary,
              status: 'ACTIVE',
            },
          });
          await this.ledger.createWalletAccount(tx, {
            id: created.id,
            name: created.name,
            currencyCode: created.currencyCode,
            userId,
          });
          return tx.wallet.findUniqueOrThrow({
            where: { id: created.id },
            include: { currency: true, walletAccount: true },
          });
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
      return toWalletDto(wallet);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && /one_primary|unique/i.test(error.message)) {
        throw AppError.conflict(ErrorCode.CONFLICT, 'A primary wallet for this currency already exists');
      }
      throw error;
    }
  }

  async list(userId: string) {
    const wallets = await this.wallets.listForUser(userId);
    return wallets.map(toWalletDto);
  }

  async get(userId: string, walletId: string) {
    const wallet = await this.wallets.findForUser(walletId, userId);
    if (!wallet) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
    return toWalletDto(wallet);
  }

  async update(
    userId: string,
    walletId: string,
    input: z.infer<typeof updateWalletSchema>,
  ): Promise<ReturnType<typeof toWalletDto>> {
    const wallet = await this.wallets.findForUser(walletId, userId);
    if (!wallet) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
    if (wallet.status === 'CLOSED') {
      throw AppError.conflict(ErrorCode.INVALID_STATE_TRANSITION, 'Closed wallets cannot be updated');
    }
    const updated = await this.client.wallet.update({
      where: { id: walletId },
      data: { name: input.name },
      include: { currency: true, walletAccount: true },
    });
    return toWalletDto(updated);
  }

  async close(userId: string, walletId: string): Promise<void> {
    await this.client.$transaction(
      async (tx) => {
        await this.wallets.lockUserAdvisory(tx, userId);
        const [locked] = await this.wallets.lockWallets(tx, [walletId]);
        if (!locked || locked.userId !== userId) {
          throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
        }
        if (locked.status === 'CLOSED') {
          throw AppError.conflict(ErrorCode.INVALID_STATE_TRANSITION, 'Wallet is already closed');
        }
        if (locked.balanceMinor !== 0n) {
          throw AppError.unprocessable(
            ErrorCode.WALLET_NOT_EMPTY,
            'Wallet balance must be zero before it can be closed',
          );
        }
        if (locked.heldMinor !== 0n) {
          throw AppError.unprocessable(ErrorCode.WALLET_NOT_EMPTY, 'Wallet has funds reserved by active withdrawals');
        }
        await tx.wallet.update({
          where: { id: walletId },
          data: { status: 'CLOSED', closedAt: new Date(), isPrimary: false },
        });
        await tx.ledgerAccount.update({
          where: { id: locked.ledgerAccountId },
          data: { isActive: false },
        });
      },
      { maxWait: 5_000, timeout: 15_000 },
    );
  }
}
