import pino, { type Logger } from 'pino';
import { config } from '../../config/env';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-admin-confirmation"]',
  'res.headers["set-cookie"]',
  'password',
  'newPassword',
  'currentPassword',
  'pin',
  'currentPin',
  'newPin',
  'totpCode',
  'token',
  'refreshToken',
  'accessToken',
  'secret',
  'clientSecret',
  'authorization',
  '*.password',
  '*.newPassword',
  '*.pin',
  '*.token',
  '*.refreshToken',
  '*.totpCode',
  '*.secret',
  '*.clientSecret',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  base: {
    service: 'nexus-bank-api',
    environment: config.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

export function safeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'UnknownError', message: String(error) };
}
