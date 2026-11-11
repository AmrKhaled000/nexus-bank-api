import { z } from 'zod';
import { nameSchema } from '../../common/validation/schemas';

export const updateProfileSchema = z.object({ name: nameSchema }).strict();

export const userSecurityEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
