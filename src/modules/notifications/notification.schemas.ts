import { z } from 'zod';
import { paginationSchema } from '../../common/validation/pagination';

export const notificationQuerySchema = paginationSchema.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const notificationIdParamsSchema = z.object({ id: z.string().cuid() });
