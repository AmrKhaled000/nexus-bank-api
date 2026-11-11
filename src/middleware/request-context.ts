import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from '../infrastructure/logging/logger';
import { config } from '../config/env';
import { hashIpAddress } from '../common/crypto/crypto';
import { runWithRequestContext } from '../common/context/request-context';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestLogger(): RequestHandler {
  const middleware = pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const candidate = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
      res.setHeader('X-Request-Id', candidate);
      return candidate;
    },
    autoLogging: {
      ignore: (req) => req.url?.startsWith('/health') === true || req.url?.startsWith('/metrics') === true,
    },
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
      err: (error) => ({ name: error.name, message: error.message }),
    },
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  });
  return middleware as RequestHandler;
}

export function requestContext(): RequestHandler {
  return (req, _res, next) => {
    const ipHash = hashIpAddress(req.ip, config.IP_HASH_SECRET);
    runWithRequestContext(
      {
        requestId: typeof req.id === 'string' ? req.id : randomUUID(),
        ipHash,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 500) : null,
        startedAt: Date.now(),
      },
      () => next(),
    );
  };
}
