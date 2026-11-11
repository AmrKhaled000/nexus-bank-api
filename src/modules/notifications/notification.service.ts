import type { NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { logger } from '../../infrastructure/logging/logger';

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue;
}

export class NotificationService {
  async create(input: CreateNotificationInput): Promise<void> {
    await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data,
      },
    });
  }

  /** Notifications are best-effort: a failure must never roll back or fail a financial operation. */
  async createSafely(input: CreateNotificationInput): Promise<void> {
    try {
      await this.create(input);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : 'unknown', userId: input.userId, type: input.type },
        'Notification persistence failed after financial operation',
      );
    }
  }

  async list(userId: string, input: { page: number; pageSize: number; unreadOnly?: boolean }) {
    const where = { userId, ...(input.unreadOnly ? { readAt: null } : {}) };
    const [items, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { items, total, unread };
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    const updated = await prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { readAt: new Date() },
    });
    if (updated.count === 0) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Notification not found');
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }
}

export const notificationService = new NotificationService();
