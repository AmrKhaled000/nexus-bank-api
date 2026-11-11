import type { PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type { WalletRepository } from '../wallets/wallet.repository';
import { walletRepository } from '../wallets/wallet.repository';
import { toPaymentMethodDto } from './payment-method.dto';
import type { createPaymentMethodSchema } from './payment-method.schemas';

/**
 * Only a provider token and the last four digits are stored. The full account number never
 * enters this system, which is the correct pattern for real payout integrations as well.
 */
export class PaymentMethodService {
  constructor(
    private readonly client: PrismaClient = prisma,
    private readonly wallets: WalletRepository = walletRepository,
  ) {}

  async list(userId: string) {
    const methods = await this.client.paymentMethodReference.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return methods.map(toPaymentMethodDto);
  }

  async create(userId: string, input: z.infer<typeof createPaymentMethodSchema>) {
    const method = await this.client.$transaction(async (tx) => {
      await this.wallets.lockUserAdvisory(tx, userId);
      const count = await tx.paymentMethodReference.count({ where: { userId, deletedAt: null } });
      if (count >= 20) {
        throw AppError.unprocessable(ErrorCode.CONFLICT, 'A maximum of 20 payout methods is allowed');
      }
      const isDefault = input.isDefault || count === 0;
      if (isDefault) {
        await tx.paymentMethodReference.updateMany({
          where: { userId, deletedAt: null, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.paymentMethodReference.create({
        data: {
          userId,
          type: 'PAYOUT_BANK_ACCOUNT',
          provider: 'SIMULATED',
          providerToken: `pmsim_${randomBytes(18).toString('base64url')}`,
          bankName: input.bankName,
          accountLast4: input.accountLast4,
          isDefault,
        },
      });
    });
    return toPaymentMethodDto(method);
  }

  async setDefault(userId: string, methodId: string) {
    const method = await this.client.$transaction(async (tx) => {
      await this.wallets.lockUserAdvisory(tx, userId);
      const existing = await tx.paymentMethodReference.findFirst({
        where: { id: methodId, userId, deletedAt: null },
      });
      if (!existing) throw AppError.notFound(ErrorCode.PAYMENT_METHOD_NOT_FOUND, 'Payout method not found');
      await tx.paymentMethodReference.updateMany({
        where: { userId, deletedAt: null, isDefault: true },
        data: { isDefault: false },
      });
      return tx.paymentMethodReference.update({
        where: { id: methodId },
        data: { isDefault: true },
      });
    });
    return toPaymentMethodDto(method);
  }

  async remove(userId: string, methodId: string): Promise<void> {
    await this.client.$transaction(async (tx) => {
      await this.wallets.lockUserAdvisory(tx, userId);
      const method = await tx.paymentMethodReference.findFirst({
        where: { id: methodId, userId, deletedAt: null },
      });
      if (!method) throw AppError.notFound(ErrorCode.PAYMENT_METHOD_NOT_FOUND, 'Payout method not found');
      const activeWithdrawals = await tx.withdrawal.count({
        where: {
          payoutMethodId: methodId,
          status: { in: ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING'] },
        },
      });
      if (activeWithdrawals > 0) {
        throw AppError.conflict(
          ErrorCode.CONFLICT,
          'This payout method is referenced by a withdrawal that is still in progress',
        );
      }
      await tx.paymentMethodReference.update({
        where: { id: methodId },
        data: { deletedAt: new Date(), isDefault: false },
      });
      const next = await tx.paymentMethodReference.findFirst({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      if (next) {
        await tx.paymentMethodReference.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
  }
}
