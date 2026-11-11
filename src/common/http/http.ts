import type { Request, RequestHandler, Response } from 'express';
import type { z} from 'zod';
import { ZodError } from 'zod';

declare global {
  namespace Express {
    interface Request {
      id?: string;
      rawBody?: Buffer;
      auth?: {
        userId: string;
        role: string;
        sessionId: string;
        emailVerified: boolean;
        userStatus: string;
      };
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export interface RequestSchemas {
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  params?: z.ZodTypeAny;
}

export function validateRequest(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    try {
      const validated: NonNullable<Request['validated']> = { ...(req.validated ?? {}) };
      if (schemas.params) validated.params = schemas.params.parse(req.params);
      if (schemas.query) validated.query = schemas.query.parse(req.query);
      if (schemas.body) validated.body = schemas.body.parse(req.body);
      req.validated = validated;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function validatedBody<TSchema extends z.ZodTypeAny>(
  req: Request,
  schema: TSchema,
): z.output<TSchema> {
  const parsed = schema.safeParse(req.validated?.body);
  if (!parsed.success) {
    throw new ZodError(parsed.error.issues);
  }
  return parsed.data as z.output<TSchema>;
}

export function validatedQuery<TSchema extends z.ZodTypeAny>(
  req: Request,
  schema: TSchema,
): z.output<TSchema> {
  const parsed = schema.safeParse(req.validated?.query);
  if (!parsed.success) {
    throw new ZodError(parsed.error.issues);
  }
  return parsed.data as z.output<TSchema>;
}

export function validatedParams<TSchema extends z.ZodTypeAny>(
  req: Request,
  schema: TSchema,
): z.output<TSchema> {
  const parsed = schema.safeParse(req.validated?.params);
  if (!parsed.success) {
    throw new ZodError(parsed.error.issues);
  }
  return parsed.data as z.output<TSchema>;
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown>,
): Response {
  return res.status(statusCode).json({
    success: true,
    data,
    ...(meta ? { meta } : {}),
  });
}

export function sendNoContent(res: Response): Response {
  return res.status(204).send();
}
