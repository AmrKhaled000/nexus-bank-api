import type { Prisma } from '@prisma/client';
import type { TransactionClient } from '../../infrastructure/database/prisma';
import { prisma } from '../../infrastructure/database/prisma';
import { getRequestContext } from '../../common/context/request-context';

export interface AuditRecordInput {
  actorUserId: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: Prisma.InputJsonValue;
  afterState?: Prisma.InputJsonValue;
  reason?: string | null;
}

/**
 * Audit logs are append-only. The initial migration adds a database trigger that rejects
 * UPDATE/DELETE on the audit_logs table. Sensitive fields must never be placed in state snapshots.
 */
export class AuditService {
  async record(input: AuditRecordInput, tx?: TransactionClient): Promise<void> {
    const context = getRequestContext();
    await (tx ?? prisma).auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        beforeState: input.beforeState,
        afterState: input.afterState,
        reason: input.reason ?? null,
        requestId: context?.requestId ?? null,
        ipHash: context?.ipHash ?? null,
      },
    });
  }
}
