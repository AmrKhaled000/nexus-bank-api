import type { RequestHandler } from 'express';
import rateLimit, { ipKeyGenerator, type Store } from 'express-rate-limit';
import { Redis } from 'ioredis';
import { RedisStore } from 'rate-limit-redis';
import type { AppConfig } from '../config/env';
import { ErrorCode } from '../common/errors/app-error';
import type { Request, Response } from 'express';
import { logger } from '../infrastructure/logging/logger';

function limitExceeded(req: Request, res: Response): void {
  res.status(429).json({
    success: false,
    error: {
      code: ErrorCode.TOO_MANY_REQUESTS,
      message: 'Too many requests. Please retry later.',
    },
    requestId: typeof req.id === 'string' ? req.id : undefined,
  });
}

function baseOptions(config: AppConfig) {
  return {
    standardHeaders: 'draft-8' as const,
    legacyHeaders: false,
    skip: () => !config.RATE_LIMIT_ENABLED,
    handler: limitExceeded,
  };
}

export interface RateLimiters {
  global: RequestHandler;
  login: RequestHandler;
  registration: RequestHandler;
  passwordReset: RequestHandler;
  financial: RequestHandler;
  verification: RequestHandler;
}

/**
 * Builds the rate-limit store. Defaults to the in-process memory store, which is correct for a
 * single-replica deployment. Set RATE_LIMIT_REDIS=true with REDIS_URL to share counters across
 * horizontally scaled API replicas — note that Redis then becomes a hard dependency for the
 * rate limiter, so enable alerting on Redis availability.
 */
function createStore(config: AppConfig): Store | undefined {
  if (!config.RATE_LIMIT_REDIS) return undefined;
  if (!config.REDIS_URL) {
    logger.warn('RATE_LIMIT_REDIS=true but REDIS_URL is unset; falling back to in-memory rate limiting');
    return undefined;
  }
  const client = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
  client.on('error', (error: Error) => {
    logger.error({ error: error.message }, 'Rate-limit Redis client error');
  });
  return new RedisStore({
    prefix: 'nexus:ratelimit:',
    sendCommand: (...args: string[]) =>
      client.call(args[0]!, ...args.slice(1)) as Promise<never>,
  });
}

/**
 * Returns the configured limiter set. Defaults to in-process memory limiting; set
 * RATE_LIMIT_REDIS=true and REDIS_URL to share counters across replicas (see SECURITY.md).
 */
export function createRateLimiters(config: AppConfig): RateLimiters {
  const store = createStore(config);
  const options = { ...baseOptions(config), ...(store ? { store } : {}) };

  return {
    global: rateLimit({
      ...options,
      windowMs: 15 * 60_000,
      limit: 600,
      identifier: 'global',
    }),
    login: rateLimit({
      ...options,
      windowMs: 15 * 60_000,
      limit: 10,
      skipSuccessfulRequests: true,
      identifier: 'auth-login',
    }),
    registration: rateLimit({
      ...options,
      windowMs: 60 * 60_000,
      limit: 5,
      identifier: 'auth-register',
    }),
    passwordReset: rateLimit({
      ...options,
      windowMs: 60 * 60_000,
      limit: 5,
      identifier: 'auth-password-reset',
    }),
    verification: rateLimit({
      ...options,
      windowMs: 15 * 60_000,
      limit: 10,
      identifier: 'auth-verification',
    }),
    financial: rateLimit({
      ...options,
      windowMs: 60_000,
      limit: 60,
      identifier: 'financial-write',
      keyGenerator: (req) => req.auth?.userId ?? ipKeyGenerator(req.ip ?? '127.0.0.1'),
    }),
  };
}
