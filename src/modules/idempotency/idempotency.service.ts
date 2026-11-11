import { Prisma } from '@prisma/client';
import { prisma, type TransactionClient } from '../../infrastructure/database/prisma';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { logger } from '../../infrastructure/logging/logger';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

export interface IdempotencyContext {
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
}

export interface IdempotentExecution<T> {
  result: T;
  replayed: boolean;
  statusCode: number;
  resourceType?: string;
  resourceId?: string;
}

interface HandlerResult<T> {
  data: T;
  statusCode: number;
  resourceType?: string;
  resourceId?: string;
}

function jsonRoundTrip<T>(value: T): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export class IdempotencyService {
  /**
   * Runs a financial operation and its idempotency record in ONE database transaction.
   * A concurrent duplicate blocks on the unique index until the first transaction finishes:
   * if it commits, the duplicate replays the stored response; if it rolls back, the duplicate
   * proceeds and performs the operation exactly once.
   */
  async run<T>(
    context: IdempotencyContext,
    handler: (tx: TransactionClient) => Promise<HandlerResult<T>>,
  ): Promise<IdempotentExecution<T>> {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const existing = await tx.idempotencyKey.findUnique({
            where: { userId_scope_key: { userId: context.userId, scope: context.scope, key: context.key } },
          });

          if (existing && existing.expiresAt.getTime() > Date.now()) {
            return this.replay<T>(existing, context.requestHash);
          }
          if (existing) {
            await tx.idempotencyKey.delete({ where: { id: existing.id } });
          }

          const record = await tx.idempotencyKey.create({
            data: {
              userId: context.userId,
              scope: context.scope,
              key: context.key,
              requestHash: context.requestHash,
              status: 'IN_PROGRESS',
              expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
            },
          });

          const outcome = await handler(tx);
          await tx.idempotencyKey.update({
            where: { id: record.id },
            data: {
              status: 'COMPLETED',
              responseStatus: outcome.statusCode,
              responseBody: jsonRoundTrip(outcome.data),
              resourceType: outcome.resourceType,
              resourceId: outcome.resourceId,
              completedAt: new Date(),
            },
          });
          return {
            result: outcome.data,
            replayed: false,
            statusCode: outcome.statusCode,
            resourceType: outcome.resourceType,
            resourceId: outcome.resourceId,
          };
        },
        { maxWait: 5_000, timeout: 20_000 },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.resolveConcurrentDuplicate<T>(context);
      }
      throw error;
    }
  }

  private async resolveConcurrentDuplicate<T>(context: IdempotencyContext): Promise<IdempotentExecution<T>> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const existing = await prisma.idempotencyKey.findUnique({
        where: { userId_scope_key: { userId: context.userId, scope: context.scope, key: context.key } },
      });
      if (!existing) {
        throw AppError.conflict(
          ErrorCode.IDEMPOTENCY_IN_PROGRESS,
          'A request with this idempotency key is being processed. Retry shortly.',
        );
      }
      if (existing.status === 'COMPLETED') {
        return this.replay<T>(existing, context.requestHash);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw AppError.conflict(
      ErrorCode.IDEMPOTENCY_IN_PROGRESS,
      'A request with this idempotency key is still being processed. Retry shortly.',
    );
  }

  private replay<T>(
    record: {
      requestHash: string;
      status: string;
      responseStatus: number | null;
      responseBody: Prisma.JsonValue | null;
      resourceType: string | null;
      resourceId: string | null;
    },
    requestHash: string,
  ): IdempotentExecution<T> {
    if (record.requestHash !== requestHash) {
      throw AppError.unprocessable(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        'This idempotency key was already used with a different request payload',
      );
    }
    if (record.status !== 'COMPLETED') {
      throw AppError.conflict(
        ErrorCode.IDEMPOTENCY_IN_PROGRESS,
        'A request with this idempotency key is still being processed. Retry shortly.',
      );
    }
    return {
      result: record.responseBody as T,
      replayed: true,
      statusCode: record.responseStatus ?? 200,
      resourceType: record.resourceType ?? undefined,
      resourceId: record.resourceId ?? undefined,
    };
  }

  /**
   * Returns a completed response for an existing key without opening a write transaction.
   * Callers should use this before performing external provider calls so a replay does not
   * depend on provider availability. Throws when the key was reused with another payload.
   */
  async preview<T>(context: IdempotencyContext): Promise<IdempotentExecution<T> | null> {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { userId_scope_key: { userId: context.userId, scope: context.scope, key: context.key } },
    });
    if (!existing || existing.expiresAt.getTime() <= Date.now() || existing.status !== 'COMPLETED') {
      return null;
    }
    return this.replay<T>(existing, context.requestHash);
  }

  async cleanupExpired(): Promise<number> {
    const result = await prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 60 * 60_000) } },
    });
    logger.info({ deleted: result.count }, 'Expired idempotency keys removed');
    return result.count;
  }
}

export const idempotencyService = new IdempotencyService();
