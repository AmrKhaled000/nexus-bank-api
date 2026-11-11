import type { Request, Response } from 'express';
import { sendSuccess, validatedParams, validatedQuery } from '../../common/http/http';
import { paginationMeta } from '../../common/validation/pagination';
import type { NotificationService } from './notification.service';
import { notificationIdParamsSchema, notificationQuerySchema } from './notification.schemas';

export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  list = async (req: Request, res: Response): Promise<Response> => {
    const query = validatedQuery(req, notificationQuerySchema);
    const result = await this.notifications.list(req.auth!.userId, {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.unreadOnly ? { unreadOnly: true } : {}),
    });
    return sendSuccess(res, result.items, 200, {
      ...paginationMeta(query.page, query.pageSize, result.total),
      unread: result.unread,
    });
  };

  markRead = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, notificationIdParamsSchema);
    await this.notifications.markRead(req.auth!.userId, id);
    return sendSuccess(res, { message: 'Notification marked as read.' });
  };

  markAllRead = async (req: Request, res: Response): Promise<Response> => {
    return sendSuccess(res, await this.notifications.markAllRead(req.auth!.userId));
  };
}
