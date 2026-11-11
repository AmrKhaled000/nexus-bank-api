import type { Request } from 'express';
import { getRequestContext } from '../context/request-context';

export function requestMeta(req: Request): { ipHash: string | null; userAgent: string | null } {
  const context = getRequestContext();
  return {
    ipHash: context?.ipHash ?? null,
    userAgent:
      context?.userAgent ??
      (typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 500) : null),
  };
}
