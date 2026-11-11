import type { RequestHandler } from 'express';
import { AppError, ErrorCode } from '../common/errors/app-error';
import { hasPermission, type Permission } from '../common/security/permissions';
import { prisma } from '../infrastructure/database/prisma';
import type { TokenService } from '../modules/auth/token.service';

export function authenticate(tokens: TokenService): RequestHandler {
  return async (req, _res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        throw AppError.unauthorized(ErrorCode.UNAUTHORIZED, 'Bearer access token is required');
      }
      const rawToken = header.slice('Bearer '.length).trim();
      if (!rawToken) throw AppError.unauthorized();
      const claims = tokens.verifyAccessToken(rawToken);
      const session = await prisma.userSession.findUnique({
        where: { id: claims.sid },
        select: {
          id: true,
          userId: true,
          revokedAt: true,
          expiresAt: true,
          user: {
            select: { id: true, role: true, status: true, emailVerifiedAt: true },
          },
        },
      });
      if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
        throw AppError.unauthorized(ErrorCode.INVALID_TOKEN, 'Session is no longer valid');
      }
      if (session.user.status === 'SUSPENDED' || session.user.status === 'CLOSED') {
        throw AppError.forbidden(
          session.user.status === 'SUSPENDED' ? ErrorCode.ACCOUNT_SUSPENDED : ErrorCode.ACCOUNT_CLOSED,
          'This account cannot access the API',
        );
      }
      req.auth = {
        userId: session.userId,
        role: session.user.role,
        sessionId: session.id,
        emailVerified: Boolean(session.user.emailVerifiedAt),
        userStatus: session.user.status,
      };
      // Session activity tracking is best-effort and throttled to avoid a write on every request.
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);
      await prisma.userSession.updateMany({
        where: { id: session.id, lastUsedAt: { lt: fiveMinutesAgo } },
        data: { lastUsedAt: new Date() },
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireEmailVerified(): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth?.emailVerified) {
      return next(AppError.forbidden(ErrorCode.EMAIL_NOT_VERIFIED, 'Verify your email address first'));
    }
    next();
  };
}

export function requireActiveAccount(): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(AppError.unauthorized());
    if (req.auth.userStatus !== 'ACTIVE') {
      return next(
        AppError.forbidden(
          req.auth.userStatus === 'FROZEN' ? ErrorCode.ACCOUNT_FROZEN : ErrorCode.ACCOUNT_SUSPENDED,
          'Your account is not permitted to perform financial operations',
        ),
      );
    }
    next();
  };
}

export function requireRole(...roles: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(AppError.unauthorized());
    if (!roles.includes(req.auth.role)) {
      return next(AppError.forbidden(ErrorCode.ROLE_NOT_ALLOWED, 'Your role does not permit this operation'));
    }
    next();
  };
}

export function requirePermission(permission: string): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(AppError.unauthorized());
    if (!hasPermission(req.auth.role, permission as Permission)) {
      return next(AppError.forbidden(ErrorCode.ROLE_NOT_ALLOWED, 'Your role does not permit this operation'));
    }
    next();
  };
}
