import { Prisma, type PrismaClient, type UserRole, type UserStatus } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { assertPermission, Permission } from '../../common/security/permissions';
import { formatMinor, parseAmountToMinor } from '../../common/money/money';
import { publicReference } from '../../common/ids/reference';
import { logger } from '../../infrastructure/logging/logger';
import { LedgerService } from '../ledger/ledger.service';
import type { WalletRepository} from '../wallets/wallet.repository';
import { walletRepository } from '../wallets/wallet.repository';
import type { IdempotencyService} from '../idempotency/idempotency.service';
import { idempotencyService } from '../idempotency/idempotency.service';
import type { NotificationService} from '../notifications/notification.service';
import { notificationService } from '../notifications/notification.service';
import { SecurityEventService } from '../security/security-event.service';
import { AuditService } from '../audit/audit.service';
import type {
  adminLedgerQuerySchema,
  adminUserQuerySchema,
  auditLogQuerySchema,
  journalQuerySchema,
  ledgerAdjustmentSchema,
  updateUserRoleSchema,
  updateUserStatusSchema,
} from './admin.schemas';
import { paginationMeta } from '../../common/validation/pagination';

type AdminUserView = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  totpEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  _count?: { wallets: number; sessions: number; deposits?: number; withdrawals?: number };
};

function toAdminUserDto(user: AdminUserView) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    twoFactorEnabled: user.totpEnabled,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    deletedAt: user.deletedAt,
    ...(user._count ? { counts: user._count } : {}),
  };
}

export class AdminService {
  constructor(
    private readonly client: PrismaClient = prisma,
    private readonly ledger: LedgerService = new LedgerService(),
    private readonly wallets: WalletRepository = walletRepository,
    private readonly idempotency: IdempotencyService = idempotencyService,
    private readonly notifications: NotificationService = notificationService,
    private readonly securityEvents: SecurityEventService = new SecurityEventService(),
    private readonly audit: AuditService = new AuditService(),
  ) {}

  async listUsers(input: z.infer<typeof adminUserQuerySchema>) {
    const where: Prisma.UserWhereInput = {
      ...(input.role ? { role: input.role } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.search
        ? {
            OR: [
              { email: { contains: input.search, mode: 'insensitive' } },
              { name: { contains: input.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [users, total] = await Promise.all([
      this.client.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          emailVerifiedAt: true,
          totpEnabled: true,
          lastLoginAt: true,
          createdAt: true,
          deletedAt: true,
          _count: { select: { wallets: true, sessions: true } },
        },
        orderBy: [{ createdAt: input.sortOrder }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.client.user.count({ where }),
    ]);
    return {
      items: users.map((user) => toAdminUserDto(user)),
      meta: paginationMeta(input.page, input.pageSize, total),
    };
  }

  async getUser(userId: string) {
    const user = await this.client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        totpEnabled: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        _count: { select: { wallets: true, sessions: true, deposits: true, withdrawals: true } },
      },
    });
    if (!user) throw AppError.notFound(ErrorCode.NOT_FOUND, 'User not found');
    const wallets = await this.client.wallet.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        currencyCode: true,
        status: true,
        isPrimary: true,
        walletAccount: { select: { balanceMinor: true, heldMinor: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ...toAdminUserDto(user),
      wallets: wallets.map((wallet) => ({
        id: wallet.id,
        name: wallet.name,
        currency: wallet.currencyCode,
        status: wallet.status,
        isPrimary: wallet.isPrimary,
        balanceMinor: (wallet.walletAccount?.balanceMinor ?? 0n).toString(),
        heldMinor: (wallet.walletAccount?.heldMinor ?? 0n).toString(),
      })),
    };
  }

  async updateUserStatus(
    actor: { userId: string; role: UserRole },
    targetId: string,
    input: z.infer<typeof updateUserStatusSchema>,
  ) {
    assertPermission(actor.role, Permission.USERS_MANAGE);
    if (actor.userId === targetId) {
      throw AppError.conflict(ErrorCode.CONFLICT, 'You cannot change your own account status');
    }
    const target = await this.client.user.findUnique({ where: { id: targetId } });
    if (!target) throw AppError.notFound(ErrorCode.NOT_FOUND, 'User not found');
    if (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
      throw AppError.forbidden(ErrorCode.ROLE_NOT_ALLOWED, 'Only a super admin can modify a super admin');
    }
    if (target.role !== 'CUSTOMER' && actor.role !== 'SUPER_ADMIN') {
      throw AppError.forbidden(ErrorCode.ROLE_NOT_ALLOWED, 'Only a super admin can modify staff accounts');
    }

    const updated = await this.client.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: targetId },
        data: { status: input.status },
      });
      if (input.status !== 'ACTIVE') {
        await tx.userSession.updateMany({
          where: { userId: targetId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: `Account status changed to ${input.status}` },
        });
      }
      await this.audit.record(
        {
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'USER_STATUS_CHANGED',
          entityType: 'User',
          entityId: targetId,
          beforeState: { status: target.status },
          afterState: { status: input.status },
          reason: input.reason,
        },
        tx,
      );
      await this.securityEvents.record(
        {
          userId: targetId,
          type: 'ACCOUNT_STATUS_CHANGED',
          severity: input.status === 'ACTIVE' ? 'LOW' : 'HIGH',
          metadata: { from: target.status, to: input.status, actorUserId: actor.userId, reason: input.reason },
        },
        tx,
      );
      return user;
    });

    await this.notifications.createSafely({
      userId: targetId,
      type: 'ACCOUNT_UPDATE',
      title: 'Account status updated',
      body: `Your account status is now ${input.status}. Reason: ${input.reason}`,
      data: { status: input.status },
    });
    return toAdminUserDto(updated);
  }

  async updateUserRole(
    actor: { userId: string; role: UserRole },
    targetId: string,
    input: z.infer<typeof updateUserRoleSchema>,
  ) {
    assertPermission(actor.role, Permission.ROLES_MANAGE);
    if (actor.role !== 'SUPER_ADMIN') {
      throw AppError.forbidden(ErrorCode.ROLE_NOT_ALLOWED, 'Only a super admin can change roles');
    }
    if (actor.userId === targetId) {
      throw AppError.conflict(ErrorCode.CONFLICT, 'You cannot change your own role');
    }
    const target = await this.client.user.findUnique({ where: { id: targetId } });
    if (!target) throw AppError.notFound(ErrorCode.NOT_FOUND, 'User not found');
    if (target.role === input.role) {
      throw AppError.conflict(ErrorCode.CONFLICT, 'User already has this role');
    }

    const updated = await this.client.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id: targetId }, data: { role: input.role } });
      await tx.userSession.updateMany({
        where: { userId: targetId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'Role changed' },
      });
      await this.audit.record(
        {
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'USER_ROLE_CHANGED',
          entityType: 'User',
          entityId: targetId,
          beforeState: { role: target.role },
          afterState: { role: input.role },
          reason: input.reason,
        },
        tx,
      );
      return user;
    });
    return toAdminUserDto(updated);
  }

  async listLedgerAccounts(input: z.infer<typeof adminLedgerQuerySchema>) {
    const [accounts, totals] = await Promise.all([
      this.client.ledgerAccount.findMany({
        where: {
          ...(input.currency ? { currencyCode: input.currency } : {}),
          ...(input.accountType ? { type: input.accountType } : {}),
        },
        include: {
          wallet: { select: { id: true, userId: true, name: true } },
          walletAccount: { select: { balanceMinor: true, heldMinor: true } },
        },
        orderBy: [{ isSystem: 'desc' }, { code: 'asc' }],
      }),
      this.client.journalEntryLine.groupBy({
        by: ['ledgerAccountId'],
        _sum: { debitMinor: true, creditMinor: true },
      }),
    ]);
    const totalByAccount = new Map(totals.map((row) => [row.ledgerAccountId, row._sum]));
    return accounts.map((account) => {
      const sums = totalByAccount.get(account.id);
      const debitMinor = sums?.debitMinor ?? 0n;
      const creditMinor = sums?.creditMinor ?? 0n;
      const signedBalance =
        account.normalBalance === 'DEBIT' ? debitMinor - creditMinor : creditMinor - debitMinor;
      return {
        id: account.id,
        code: account.code,
        name: account.name,
        type: account.type,
        normalBalance: account.normalBalance,
        currency: account.currencyCode,
        isSystem: account.isSystem,
        isActive: account.isActive,
        debitMinor: debitMinor.toString(),
        creditMinor: creditMinor.toString(),
        signedBalanceMinor: signedBalance.toString(),
        wallet: account.wallet,
        projection: account.walletAccount
          ? {
              balanceMinor: account.walletAccount.balanceMinor.toString(),
              heldMinor: account.walletAccount.heldMinor.toString(),
            }
          : null,
      };
    });
  }

  async trialBalance() {
    // SUM(bigint) surfaces as numeric/Decimal through Prisma raw queries, so normalize via
    // string before comparing. BIGINT casts keep the query result a real bigint as well.
    const rows = await this.client.$queryRaw<
      Array<{ currency: string; debits: bigint | string; credits: bigint | string; lines: bigint | string }>
    >(Prisma.sql`
      SELECT je."currencyCode" AS "currency",
             COALESCE(SUM(l."debitMinor"), 0)::bigint AS "debits",
             COALESCE(SUM(l."creditMinor"), 0)::bigint AS "credits",
             COUNT(l."id") AS "lines"
      FROM "journal_entry_lines" l
      JOIN "journal_entries" je ON je."id" = l."journalEntryId"
      GROUP BY je."currencyCode"
      ORDER BY je."currencyCode" ASC
    `);
    const currencies = rows.map((row) => {
      const debits = BigInt(String(row.debits));
      const credits = BigInt(String(row.credits));
      return {
        currency: row.currency,
        debitsMinor: debits.toString(),
        creditsMinor: credits.toString(),
        differenceMinor: (debits - credits).toString(),
        lines: Number(row.lines),
        balanced: debits === credits,
      };
    });
    return {
      balanced: currencies.every((row) => row.balanced),
      currencies,
    };
  }

  async listJournalEntries(input: z.infer<typeof journalQuerySchema>) {
    const where: Prisma.JournalEntryWhereInput = {
      ...(input.currency ? { currencyCode: input.currency } : {}),
      ...(input.transactionId ? { transactionId: input.transactionId } : {}),
      ...(input.dateFrom || input.dateTo
        ? {
            createdAt: {
              ...(input.dateFrom ? { gte: new Date(input.dateFrom) } : {}),
              ...(input.dateTo ? { lte: new Date(input.dateTo) } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.client.journalEntry.findMany({
        where,
        include: {
          lines: {
            include: {
              ledgerAccount: { select: { code: true, name: true, type: true } },
            },
            orderBy: { id: 'asc' },
          },
          transaction: { select: { reference: true, type: true, status: true } },
        },
        orderBy: [{ createdAt: input.sortOrder }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.client.journalEntry.count({ where }),
    ]);
    return {
      items: items.map((entry) => ({
        id: entry.id,
        reference: entry.reference,
        currency: entry.currencyCode,
        description: entry.description,
        createdAt: entry.createdAt,
        transaction: entry.transaction,
        lines: entry.lines.map((line) => ({
          id: line.id.toString(),
          accountCode: line.ledgerAccount.code,
          accountName: line.ledgerAccount.name,
          accountType: line.ledgerAccount.type,
          debitMinor: line.debitMinor.toString(),
          creditMinor: line.creditMinor.toString(),
          description: line.description,
        })),
      })),
      meta: paginationMeta(input.page, input.pageSize, total),
    };
  }

  async adjustLedger(
    actor: { userId: string; role: UserRole },
    input: z.infer<typeof ledgerAdjustmentSchema>,
    idempotency: { key: string; requestHash: string },
  ) {
    assertPermission(actor.role, Permission.LEDGER_ADJUST);
    return this.idempotency.run(
      {
        userId: actor.userId,
        scope: 'admin.ledger.adjust',
        key: idempotency.key,
        requestHash: idempotency.requestHash,
      },
      async (tx) => {
        const wallet = await tx.wallet.findUnique({
          where: { id: input.walletId },
          include: { currency: true, user: { select: { id: true, status: true } } },
        });
        if (!wallet) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
        if (wallet.status === 'CLOSED') {
          throw AppError.unprocessable(ErrorCode.WALLET_NOT_ACTIVE, 'Closed wallets cannot be adjusted');
        }
        const amountMinor = parseAmountToMinor(input.amount, wallet.currency.exponent);

        await this.wallets.lockUsersAdvisory(tx, [wallet.userId]);
        const [locked] = await this.wallets.lockWallets(tx, [wallet.id]);
        if (!locked) throw AppError.notFound(ErrorCode.WALLET_NOT_FOUND, 'Wallet not found');
        if (input.direction === 'DEBIT') {
          const available = locked.balanceMinor - locked.heldMinor;
          if (available < amountMinor) {
            throw AppError.unprocessable(
              ErrorCode.INSUFFICIENT_FUNDS,
              'The wallet does not have enough available balance for this debit adjustment',
            );
          }
        }

        const reference = publicReference('ADJ');
        const systemKind = input.direction === 'CREDIT' ? 'ADJUSTMENT_EXPENSE' : 'ADJUSTMENT_INCOME';
        const system = await this.ledger.systemAccount(tx, systemKind, wallet.currencyCode);
        const transaction = await tx.financialTransaction.create({
          data: {
            reference,
            type: 'ADJUSTMENT',
            status: 'COMPLETED',
            amountMinor,
            feeMinor: 0n,
            currencyCode: wallet.currencyCode,
            initiatorUserId: actor.userId,
            ...(input.direction === 'CREDIT'
              ? { destinationWalletId: wallet.id }
              : { sourceWalletId: wallet.id }),
            description: `Administrative ${input.direction.toLowerCase()} adjustment: ${input.reason}`,
            completedAt: new Date(),
            metadata: { actorUserId: actor.userId, direction: input.direction, reason: input.reason },
          },
        });
        const journal = await this.ledger.post({
          tx,
          currencyCode: wallet.currencyCode,
          description: `Administrative adjustment ${reference}`,
          transactionId: transaction.id,
          createdById: actor.userId,
          metadata: { reason: input.reason, direction: input.direction },
          lines:
            input.direction === 'CREDIT'
              ? [
                  {
                    ledgerAccountId: system.id,
                    direction: 'DEBIT',
                    amountMinor,
                    description: 'Adjustment expense',
                  },
                  {
                    ledgerAccountId: locked.ledgerAccountId,
                    direction: 'CREDIT',
                    amountMinor,
                    description: 'Administrative wallet credit',
                  },
                ]
              : [
                  {
                    ledgerAccountId: locked.ledgerAccountId,
                    direction: 'DEBIT',
                    amountMinor,
                    description: 'Administrative wallet debit',
                  },
                  {
                    ledgerAccountId: system.id,
                    direction: 'CREDIT',
                    amountMinor,
                    description: 'Adjustment income',
                  },
                ],
        });
        await this.audit.record(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'LEDGER_ADJUSTMENT',
            entityType: 'Wallet',
            entityId: wallet.id,
            beforeState: {
              balanceMinor: locked.balanceMinor.toString(),
              heldMinor: locked.heldMinor.toString(),
            },
            afterState: {
              balanceMinor: (
                input.direction === 'CREDIT'
                  ? locked.balanceMinor + amountMinor
                  : locked.balanceMinor - amountMinor
              ).toString(),
            },
            reason: input.reason,
          },
          tx,
        );
        return {
          data: {
            adjustment: {
              transactionId: transaction.id,
              reference,
              direction: input.direction,
              amount: formatMinor(amountMinor, wallet.currency.exponent),
              amountMinor: amountMinor.toString(),
              currency: wallet.currencyCode,
              journalReference: journal.reference,
            },
          },
          statusCode: 201,
          resourceType: 'transaction',
          resourceId: transaction.id,
        };
      },
    );
  }

  async reconcile(actor?: { userId: string; role: UserRole }) {
    const [trialBalance, projectionMismatches, staleData, webhookFailures] = await Promise.all([
      this.trialBalance(),
      this.client.$queryRaw<
        Array<{
          walletId: string;
          projected: bigint;
          ledger: bigint;
          held: bigint;
          activeHolds: bigint;
        }>
      >(Prisma.sql`
        WITH ledger AS (
          SELECT l."ledgerAccountId", SUM(l."creditMinor" - l."debitMinor") AS balance
          FROM "journal_entry_lines" l
          GROUP BY l."ledgerAccountId"
        ), holds AS (
          SELECT h."walletId", SUM(h."amountMinor") AS amount
          FROM "wallet_holds" h
          WHERE h."status" = 'ACTIVE'
          GROUP BY h."walletId"
        )
        SELECT wa."walletId" AS "walletId",
               wa."balanceMinor" AS "projected",
               COALESCE(ledger.balance, 0) AS "ledger",
               wa."heldMinor" AS "held",
               COALESCE(holds.amount, 0) AS "activeHolds"
        FROM "wallet_accounts" wa
        LEFT JOIN ledger ON ledger."ledgerAccountId" = wa."ledgerAccountId"
        LEFT JOIN holds ON holds."walletId" = wa."walletId"
        WHERE wa."balanceMinor" <> COALESCE(ledger.balance, 0)
           OR wa."heldMinor" <> COALESCE(holds.amount, 0)
        LIMIT 100
      `),
      this.client.$queryRaw<
        Array<{ category: string; count: bigint }>
      >(Prisma.sql`
        SELECT 'expired_pending_deposits' AS category, COUNT(*) AS count
        FROM "deposits" WHERE "status" IN ('PENDING','PROCESSING') AND "expiresAt" < NOW()
        UNION ALL
        SELECT 'stuck_processing_withdrawals', COUNT(*)
        FROM "withdrawals" WHERE "status" = 'PROCESSING' AND "updatedAt" < NOW() - INTERVAL '15 minutes'
        UNION ALL
        SELECT 'failed_webhooks_24h', COUNT(*)
        FROM "webhook_events" WHERE "status" = 'FAILED' AND "receivedAt" > NOW() - INTERVAL '24 hours'
        UNION ALL
        SELECT 'stuck_idempotency_keys', COUNT(*)
        FROM "idempotency_keys" WHERE "status" = 'IN_PROGRESS' AND "createdAt" < NOW() - INTERVAL '10 minutes'
      `),
      this.client.webhookEvent.count({
        where: { status: 'FAILED', receivedAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
      }),
    ]);

    const issues: Array<{ type: string; severity: 'MEDIUM' | 'HIGH' | 'CRITICAL'; details: unknown }> = [];
    if (!trialBalance.balanced) {
      issues.push({ type: 'TRIAL_BALANCE_MISMATCH', severity: 'CRITICAL', details: trialBalance.currencies });
    }
    for (const mismatch of projectionMismatches) {
      issues.push({
        type: 'WALLET_PROJECTION_MISMATCH',
        severity: 'CRITICAL',
        details: {
          walletId: mismatch.walletId,
          projectedMinor: mismatch.projected.toString(),
          ledgerMinor: mismatch.ledger.toString(),
          heldMinor: mismatch.held.toString(),
          activeHoldsMinor: mismatch.activeHolds.toString(),
        },
      });
    }
    for (const row of staleData) {
      const count = Number(row.count);
      if (count === 0) continue;
      issues.push({
        type: row.category.toUpperCase(),
        severity: row.category === 'failed_webhooks_24h' ? 'HIGH' : 'MEDIUM',
        details: { count },
      });
    }
    if (webhookFailures > 0 && !staleData.some((row) => row.category === 'failed_webhooks_24h')) {
      issues.push({ type: 'FAILED_WEBHOOKS_24H', severity: 'HIGH', details: { count: webhookFailures } });
    }

    const result = {
      healthy: issues.length === 0,
      checkedAt: new Date(),
      trialBalance,
      issues,
    };
    if (actor) {
      await this.audit.record({
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'RECONCILIATION_RUN',
        entityType: 'System',
        entityId: 'ledger',
        afterState: {
          healthy: result.healthy,
          issueCount: issues.length,
          trialBalanced: trialBalance.balanced,
        },
      });
      if (!result.healthy) {
        logger.warn({ issues: issues.length }, 'Reconciliation found issues');
      }
    }
    return result;
  }

  async listAuditLogs(input: z.infer<typeof auditLogQuerySchema>) {
    const where: Prisma.AuditLogWhereInput = {
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.entityType ? { entityType: input.entityType } : {}),
      ...(input.entityId ? { entityId: input.entityId } : {}),
      ...(input.dateFrom || input.dateTo
        ? {
            createdAt: {
              ...(input.dateFrom ? { gte: new Date(input.dateFrom) } : {}),
              ...(input.dateTo ? { lte: new Date(input.dateTo) } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.client.auditLog.findMany({
        where,
        orderBy: [{ createdAt: input.sortOrder }, { id: 'desc' }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.client.auditLog.count({ where }),
    ]);
    return { items, meta: paginationMeta(input.page, input.pageSize, total) };
  }

  async stats() {
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const [users, activeUsers, wallets, pendingWithdrawals, deposits24h, withdrawals24h, transfers24h, volumes] =
      await Promise.all([
        this.client.user.count(),
        this.client.user.count({ where: { status: 'ACTIVE' } }),
        this.client.wallet.count({ where: { status: { not: 'CLOSED' } } }),
        this.client.withdrawal.count({ where: { status: { in: ['PENDING', 'UNDER_REVIEW'] } } }),
        this.client.deposit.count({ where: { createdAt: { gte: since } } }),
        this.client.withdrawal.count({ where: { createdAt: { gte: since } } }),
        this.client.transfer.count({ where: { createdAt: { gte: since } } }),
        this.client.financialTransaction.groupBy({
          by: ['currencyCode', 'type'],
          where: { status: 'COMPLETED', completedAt: { gte: since } },
          _sum: { amountMinor: true },
          _count: { _all: true },
        }),
      ]);
    return {
      users: { total: users, active: activeUsers },
      wallets: { total: wallets },
      pendingWithdrawalReviews: pendingWithdrawals,
      last24Hours: {
        deposits: deposits24h,
        withdrawals: withdrawals24h,
        transfers: transfers24h,
      },
      completedVolume: volumes.map((row) => ({
        currency: row.currencyCode,
        type: row.type,
        count: row._count._all,
        amountMinor: (row._sum.amountMinor ?? 0n).toString(),
      })),
    };
  }
}
