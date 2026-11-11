import type { Prisma} from '@prisma/client';
import { type SecurityEventType, type SecuritySeverity } from '@prisma/client';
import type { TransactionClient } from '../../infrastructure/database/prisma';
import { prisma } from '../../infrastructure/database/prisma';
import { getRequestContext } from '../../common/context/request-context';

export interface SecurityEventInput {
  userId?: string | null;
  type: SecurityEventType;
  severity: SecuritySeverity;
  metadata?: Prisma.InputJsonValue;
  ipHash?: string | null;
  userAgent?: string | null;
}

export class SecurityEventService {
  async record(input: SecurityEventInput, tx?: TransactionClient): Promise<void> {
    const context = getRequestContext();
    const client = tx ?? prisma;
    await client.securityEvent.create({
      data: {
        userId: input.userId ?? null,
        type: input.type,
        severity: input.severity,
        ipHash: input.ipHash ?? context?.ipHash ?? null,
        userAgent: input.userAgent ?? context?.userAgent ?? null,
        metadata: input.metadata,
      },
    });
  }

  async listForUser(userId: string, limit = 50) {
    return prisma.securityEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      select: {
        id: true,
        type: true,
        severity: true,
        metadata: true,
        createdAt: true,
      },
    });
  }
}
