import { prisma } from '../../infrastructure/database/prisma';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { AuditService } from '../audit/audit.service';
import { SecurityEventService } from '../security/security-event.service';
import type { TransactionClient } from '../../infrastructure/database/prisma';
import { toPublicUser } from './user.dto';

export class UserService {
  constructor(
    private readonly audit: AuditService = new AuditService(),
    private readonly securityEvents: SecurityEventService = new SecurityEventService(),
  ) {}

  async getProfile(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return {
      ...toPublicUser(user),
      lastLoginAt: user.lastLoginAt,
      updatedAt: user.updatedAt,
    };
  }

  async updateProfile(userId: string, role: string, input: { name: string }) {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (before.status === 'CLOSED') {
      throw AppError.forbidden(ErrorCode.ACCOUNT_CLOSED, 'Closed accounts cannot be modified');
    }
    const user = await prisma.$transaction(async (tx: TransactionClient) => {
      const updated = await tx.user.update({ where: { id: userId }, data: { name: input.name } });
      await this.audit.record(
        {
          actorUserId: userId,
          actorRole: role,
          action: 'PROFILE_UPDATED',
          entityType: 'User',
          entityId: userId,
          beforeState: { name: before.name },
          afterState: { name: updated.name },
        },
        tx,
      );
      return updated;
    });
    return toPublicUser(user);
  }

  async listSecurityEvents(userId: string, limit: number) {
    return this.securityEvents.listForUser(userId, limit);
  }

  async closeAccount(userId: string): Promise<void> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.status === 'CLOSED') {
      throw AppError.conflict(ErrorCode.INVALID_STATE_TRANSITION, 'Account is already closed');
    }
    const wallets = await prisma.wallet.findMany({
      where: { userId, status: { not: 'CLOSED' } },
      include: { walletAccount: true },
    });
    if (wallets.some((wallet) => (wallet.walletAccount?.balanceMinor ?? 0n) !== 0n)) {
      throw AppError.unprocessable(
        ErrorCode.WALLET_NOT_EMPTY,
        'All wallets must have a zero balance before the account can be closed',
      );
    }
    if (wallets.some((wallet) => (wallet.walletAccount?.heldMinor ?? 0n) !== 0n)) {
      throw AppError.unprocessable(ErrorCode.WALLET_NOT_EMPTY, 'Active holds must be resolved first');
    }
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.wallet.updateMany({
        where: { userId, status: { not: 'CLOSED' } },
        data: { status: 'CLOSED', closedAt: now, isPrimary: false },
      });
      await tx.ledgerAccount.updateMany({
        where: { wallet: { userId } },
        data: { isActive: false },
      });
      await tx.user.update({ where: { id: userId }, data: { status: 'CLOSED', deletedAt: now } });
      await tx.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'ACCOUNT_CLOSED' },
      });
      await tx.refreshToken.updateMany({
        where: { session: { userId }, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.audit.record(
        {
          actorUserId: userId,
          actorRole: user.role,
          action: 'ACCOUNT_CLOSED',
          entityType: 'User',
          entityId: userId,
          beforeState: { status: user.status },
          afterState: { status: 'CLOSED' },
        },
        tx,
      );
    });
  }
}

export const userService = new UserService();
