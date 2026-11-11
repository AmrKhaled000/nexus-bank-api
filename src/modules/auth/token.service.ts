import { randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  sid: string;
  typ: 'access';
  jti: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface MfaTokenClaims {
  sub: string;
  typ: 'mfa';
  jti: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export class TokenService {
  constructor(private readonly config: AppConfig) {}

  signAccessToken(input: { userId: string; role: UserRole; sessionId: string }): {
    token: string;
    expiresInSeconds: number;
  } {
    const token = jwt.sign(
      {
        sub: input.userId,
        role: input.role,
        sid: input.sessionId,
        typ: 'access',
      },
      this.config.JWT_ACCESS_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: this.config.JWT_ACCESS_TTL_SECONDS,
        issuer: this.config.JWT_ISSUER,
        audience: this.config.JWT_AUDIENCE,
        jwtid: randomUUID(),
      },
    );
    return { token, expiresInSeconds: this.config.JWT_ACCESS_TTL_SECONDS };
  }

  signMfaToken(userId: string): { token: string; expiresInSeconds: number } {
    const expiresInSeconds = 300;
    const token = jwt.sign({ sub: userId, typ: 'mfa' }, this.config.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: expiresInSeconds,
      issuer: this.config.JWT_ISSUER,
      audience: this.config.JWT_AUDIENCE,
      jwtid: randomUUID(),
    });
    return { token, expiresInSeconds };
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    const payload = this.verify(token);
    if (payload.typ !== 'access' || typeof payload.sid !== 'string' || typeof payload.role !== 'string') {
      throw AppError.unauthorized(ErrorCode.INVALID_TOKEN, 'Invalid access token');
    }
    return payload as AccessTokenClaims;
  }

  verifyMfaToken(token: string): MfaTokenClaims {
    const payload = this.verify(token);
    if (payload.typ !== 'mfa') {
      throw AppError.unauthorized(ErrorCode.INVALID_TOKEN, 'Invalid authentication token');
    }
    return payload as MfaTokenClaims;
  }

  private verify(token: string): JwtPayload {
    try {
      const decoded = jwt.verify(token, this.config.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'],
        issuer: this.config.JWT_ISSUER,
        audience: this.config.JWT_AUDIENCE,
      });
      if (typeof decoded === 'string') {
        throw new Error('Unexpected JWT payload');
      }
      return decoded;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw AppError.unauthorized(ErrorCode.TOKEN_EXPIRED, 'Token has expired');
      }
      throw AppError.unauthorized(ErrorCode.INVALID_TOKEN, 'Invalid or malformed token');
    }
  }
}
