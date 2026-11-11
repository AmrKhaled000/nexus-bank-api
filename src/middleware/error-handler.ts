import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError, ErrorCode } from '../common/errors/app-error';
import { logger, safeError } from '../infrastructure/logging/logger';

export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(AppError.notFound(ErrorCode.NOT_FOUND, `Route ${req.method} ${req.originalUrl} was not found`));
  };
}

function zodDetails(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

function prismaErrorToAppError(error: Prisma.PrismaClientKnownRequestError): AppError | null {
  if (error.code === 'P2002') {
    return AppError.conflict(ErrorCode.CONFLICT, 'A record with these values already exists');
  }
  if (error.code === 'P2025') {
    return AppError.notFound(ErrorCode.NOT_FOUND, 'Resource not found');
  }
  if (error.code === 'P2003') {
    return AppError.unprocessable(ErrorCode.VALIDATION_ERROR, 'Referenced resource does not exist');
  }
  if (error.code === 'P2034') {
    return AppError.conflict(ErrorCode.CONFLICT, 'The operation conflicted with another request. Retry safely.');
  }
  return null;
}

function databaseConstraintError(error: Error): AppError | null {
  const message = error.message;
  if (
    /wallet_accounts_balance_check|wallet_accounts_held_check|balanceMinor.*check constraint/i.test(message) ||
    /insufficient|would go negative/i.test(message)
  ) {
    return AppError.unprocessable(ErrorCode.INSUFFICIENT_FUNDS, 'Insufficient available balance');
  }
  if (/journal|ledger|double.?entry|balance projection|hold/i.test(message)) {
    return new AppError(
      ErrorCode.LEDGER_IMBALANCE,
      'A financial integrity constraint rejected the operation. The transaction was rolled back.',
      500,
      { expose: false, cause: error },
    );
  }
  return null;
}

export function errorHandler(): ErrorRequestHandler {
  return (error, req, res, _next) => {
    if (res.headersSent) {
      logger.error({ error: safeError(error), requestId: req.id }, 'Error after response headers sent');
      return;
    }

    let appError: AppError;

    if (error instanceof AppError) {
      appError = error;
    } else if (error instanceof ZodError) {
      appError = AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Request validation failed', zodDetails(error));
    } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
      appError = prismaErrorToAppError(error) ?? AppError.internal();
    } else if (error instanceof Prisma.PrismaClientValidationError) {
      appError = AppError.internal();
    } else if (error instanceof SyntaxError && 'body' in error) {
      appError = AppError.badRequest(ErrorCode.INVALID_JSON, 'Request body contains invalid JSON');
    } else if (error instanceof Error) {
      if (/request entity too large/i.test(error.message)) {
        appError = new AppError(ErrorCode.VALIDATION_ERROR, 'Request body is too large', 413);
      } else {
        appError = databaseConstraintError(error) ?? AppError.internal();
      }
    } else {
      appError = AppError.internal();
    }

    const requestId = typeof req.id === 'string' ? req.id : undefined;
    if (appError.statusCode >= 500) {
      logger.error(
        {
          requestId,
          method: req.method,
          path: req.originalUrl,
          userId: req.auth?.userId,
          error: safeError(error),
          code: appError.code,
        },
        'Unhandled request failure',
      );
    } else {
      logger.warn(
        {
          requestId,
          method: req.method,
          path: req.originalUrl,
          userId: req.auth?.userId,
          code: appError.code,
        },
        'Request rejected',
      );
    }

    res.status(appError.statusCode).json({
      success: false,
      error: {
        code: appError.code,
        message: appError.expose ? appError.message : 'An unexpected error occurred',
        ...(appError.expose && appError.details !== undefined ? { details: appError.details } : {}),
      },
      requestId,
    });
  };
}
