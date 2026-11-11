import type { User } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import {
  generateSecureToken,
  hashPassword,
  sha256,
  verifyPassword,
} from '../../common/crypto/crypto';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { logger } from '../../infrastructure/logging/logger';
import type { EmailDispatcher } from '../../infrastructure/email/email-dispatcher';
import { NullEmailDispatcher } from '../../infrastructure/email/email-dispatcher';
import { prisma } from '../../infrastructure/database/prisma';
import { isUniqueConstraintError } from '../../infrastructure/database/prisma';
import type { SecurityEventService } from '../security/security-event.service';
import { PinService } from '../security/pin.service';
import type { TokenService } from './token.service';
import type { TotpService } from './totp.service';
import { toPublicUser, type PublicUser } from '../users/user.dto';

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1_000;
const LOGIN_LOCK_MINUTES = 15;
const MAX_LOGIN_ATTEMPTS = 5;

export interface RequestMeta {
  ipHash: string | null;
  userAgent: string | null;
  deviceName?: string;
}

export interface TokenBundle {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionId: string;
}

export type LoginResult =
  | { kind: 'tokens'; user: PublicUser; tokens: TokenBundle }
  | { kind: 'mfa_required'; mfaToken: string; expiresInSeconds: number };

interface RefreshLockRow {
  tokenId: string;
  sessionId: string;
  userId: string;
  usedAt: Date | null;
  revokedAt: Date | null;
  tokenExpiresAt: Date;
  sessionRevokedAt: Date | null;
  sessionExpiresAt: Date;
}

export class AuthService {
  private readonly pinService: PinService;

  constructor(
    private readonly config: AppConfig,
    private readonly tokens: TokenService,
    private readonly totp: TotpService,
    private readonly securityEvents: SecurityEventService,
    private readonly email: EmailDispatcher = new NullEmailDispatcher(),
  ) {
    this.pinService = new PinService(config, securityEvents);
  }

  async register(input: { name: string; email: string; password: string }): Promise<{ user: PublicUser; message: string }> {
    this.assertPasswordNotDerivedFromIdentity(input.password, input.email, input.name);
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password);
    const rawVerificationToken = generateSecureToken(32);
    const verificationHash = sha256(rawVerificationToken);

    let user: User;
    try {
      user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            name: input.name,
            passwordHash,
            status: 'PENDING_VERIFICATION',
          },
        });
        await tx.userVerification.create({
          data: {
            userId: created.id,
            purpose: 'EMAIL_VERIFICATION',
            tokenHash: verificationHash,
            expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
          },
        });
        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw AppError.conflict(ErrorCode.EMAIL_ALREADY_EXISTS, 'An account with this email already exists');
      }
      throw error;
    }

    await this.trySendEmail({
      to: user.email,
      subject: 'Verify your NEXUS BANK email address',
      text: [
        `Hello ${user.name},`,
        '',
        'Welcome to NEXUS BANK. Verify your email address using the one-time token below:',
        rawVerificationToken,
        '',
        'This token expires in 24 hours. If you did not create this account, ignore this email.',
      ].join('\n'),
    });

    return {
      user: toPublicUser(user),
      message: 'Account created. Check your email to verify your address before signing in.',
    };
  }

  async verifyEmail(rawToken: string): Promise<{ message: string }> {
    const tokenHash = sha256(rawToken);
    const record = await prisma.userVerification.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!record || record.purpose !== 'EMAIL_VERIFICATION') {
      throw AppError.badRequest(ErrorCode.INVALID_TOKEN, 'Verification token is invalid');
    }
    if (record.consumedAt) {
      throw AppError.badRequest(ErrorCode.INVALID_TOKEN, 'Verification token has already been used');
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw AppError.badRequest(ErrorCode.TOKEN_EXPIRED, 'Verification token has expired');
    }

    await prisma.$transaction(async (tx) => {
      const consumed = await tx.userVerification.updateMany({
        where: { id: record.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) {
        throw AppError.badRequest(ErrorCode.INVALID_TOKEN, 'Verification token is no longer valid');
      }
      await tx.user.update({
        where: { id: record.userId },
        data: {
          emailVerifiedAt: record.user.emailVerifiedAt ?? new Date(),
          status: record.user.status === 'PENDING_VERIFICATION' ? 'ACTIVE' : record.user.status,
        },
      });
    });

    return { message: 'Email address verified successfully.' };
  }

  async resendVerification(email: string): Promise<{ message: string }> {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || user.emailVerifiedAt || user.status === 'CLOSED') {
      return { message: 'If the account requires verification, an email has been sent.' };
    }
    const rawToken = generateSecureToken(32);
    await prisma.$transaction(async (tx) => {
      await tx.userVerification.updateMany({
        where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.userVerification.create({
        data: {
          userId: user.id,
          purpose: 'EMAIL_VERIFICATION',
          tokenHash: sha256(rawToken),
          expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
        },
      });
    });
    await this.trySendEmail({
      to: user.email,
      subject: 'Verify your NEXUS BANK email address',
      text: `Hello ${user.name},\n\nUse this one-time token to verify your email address:\n\n${rawToken}\n\nThis token expires in 24 hours.`,
    });
    return { message: 'If the account requires verification, an email has been sent.' };
  }

  async login(
    input: { email: string; password: string; deviceName?: string },
    meta: RequestMeta,
  ): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Equalise timing against the password-verification path.
      await hashPassword(input.password);
      await this.securityEvents.record({
        type: 'LOGIN_FAILED',
        severity: 'LOW',
        metadata: { reason: 'unknown_account' },
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      });
      throw AppError.unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password');
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.securityEvents.record({
        userId: user.id,
        type: 'LOGIN_LOCKED',
        severity: 'MEDIUM',
        metadata: { lockedUntil: user.lockedUntil.toISOString() },
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      });
      throw new AppError(ErrorCode.ACCOUNT_LOCKED, 'Account is temporarily locked. Try again later.', 423);
    }

    if (!(await verifyPassword(user.passwordHash, input.password))) {
      await this.recordFailedLogin(user, meta);
      throw AppError.unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password');
    }

    if (user.status === 'PENDING_VERIFICATION') {
      throw AppError.forbidden(ErrorCode.EMAIL_NOT_VERIFIED, 'Verify your email address before signing in');
    }
    if (user.status === 'SUSPENDED' || user.status === 'CLOSED') {
      throw AppError.forbidden(
        user.status === 'SUSPENDED' ? ErrorCode.ACCOUNT_SUSPENDED : ErrorCode.ACCOUNT_CLOSED,
        'This account cannot sign in',
      );
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    if (user.totpEnabled) {
      const mfaToken = this.tokens.signMfaToken(user.id);
      return { kind: 'mfa_required', mfaToken: mfaToken.token, expiresInSeconds: mfaToken.expiresInSeconds };
    }

    const tokens = await this.createSession(user, meta);
    return { kind: 'tokens', user: toPublicUser(user), tokens };
  }

  async verifyTwoFactor(
    input: { mfaToken: string; code: string; deviceName?: string },
    meta: RequestMeta,
  ): Promise<{ user: PublicUser; tokens: TokenBundle }> {
    const claims = this.tokens.verifyMfaToken(input.mfaToken);
    const user = await prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user) throw AppError.unauthorized();
    if (!user.totpEnabled || !user.totpSecretEncrypted) {
      throw AppError.badRequest(ErrorCode.INVALID_TWO_FACTOR_CODE, 'Two-factor authentication is not enabled');
    }
    if (user.status === 'SUSPENDED' || user.status === 'CLOSED' || user.status === 'PENDING_VERIFICATION') {
      throw AppError.forbidden(ErrorCode.ACCOUNT_SUSPENDED, 'This account cannot sign in');
    }
    const secret = this.totp.decrypt(user.totpSecretEncrypted);
    this.totp.assertValidCode(secret, input.code);
    const step = this.totp.currentStep();
    const consumed = await prisma.user.updateMany({
      where: {
        id: user.id,
        OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }],
      },
      data: { totpLastUsedStep: step },
    });
    if (consumed.count !== 1) {
      throw AppError.unprocessable(ErrorCode.INVALID_TWO_FACTOR_CODE, 'Authenticator code has already been used');
    }
    const tokens = await this.createSession(user, meta);
    return { user: toPublicUser(user), tokens };
  }

  async refresh(rawRefreshToken: string, meta: RequestMeta): Promise<{ user: PublicUser; tokens: TokenBundle }> {
    const tokenHash = sha256(rawRefreshToken);
    const outcome:
      | { kind: 'reuse' }
      | { kind: 'invalid'; reason: 'not_found' | 'expired' | 'revoked' }
      | {
          kind: 'ok';
          user: User;
          sessionId: string;
          access: { token: string; expiresInSeconds: number };
          newRawToken: string;
          newExpiresAt: Date;
        } = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<RefreshLockRow[]>`
        SELECT
          rt."id" AS "tokenId",
          rt."sessionId" AS "sessionId",
          s."userId" AS "userId",
          rt."usedAt" AS "usedAt",
          rt."revokedAt" AS "revokedAt",
          rt."expiresAt" AS "tokenExpiresAt",
          s."revokedAt" AS "sessionRevokedAt",
          s."expiresAt" AS "sessionExpiresAt"
        FROM "refresh_tokens" rt
        JOIN "user_sessions" s ON s."id" = rt."sessionId"
        WHERE rt."tokenHash" = ${tokenHash}
        FOR UPDATE OF rt, s
      `;
      const row = rows[0];
      if (!row) return { kind: 'invalid', reason: 'not_found' } as const;

      if (row.usedAt || row.revokedAt) {
        await tx.refreshToken.update({
          where: { id: row.tokenId },
          data: { reuseDetectedAt: new Date(), revokedAt: row.revokedAt ?? new Date() },
        });
        await tx.userSession.update({
          where: { id: row.sessionId },
          data: { revokedAt: new Date(), revokedReason: 'REFRESH_TOKEN_REUSE' },
        });
        await tx.refreshToken.updateMany({
          where: { sessionId: row.sessionId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.securityEvents.record(
          {
            userId: row.userId,
            type: 'REFRESH_TOKEN_REUSE',
            severity: 'CRITICAL',
            metadata: { sessionId: row.sessionId },
            ipHash: meta.ipHash,
            userAgent: meta.userAgent,
          },
          tx,
        );
        return { kind: 'reuse' } as const;
      }

      if (row.revokedAt || row.sessionRevokedAt) return { kind: 'invalid', reason: 'revoked' } as const;
      if (row.tokenExpiresAt.getTime() <= Date.now() || row.sessionExpiresAt.getTime() <= Date.now()) {
        return { kind: 'invalid', reason: 'expired' } as const;
      }

      const user = await tx.user.findUnique({ where: { id: row.userId } });
      if (!user) return { kind: 'invalid', reason: 'not_found' } as const;
      if (user.status === 'SUSPENDED' || user.status === 'CLOSED') {
        await tx.userSession.update({
          where: { id: row.sessionId },
          data: { revokedAt: new Date(), revokedReason: 'USER_STATUS_BLOCKED' },
        });
        return { kind: 'invalid', reason: 'revoked' } as const;
      }

      const now = new Date();
      const newRawToken = generateSecureToken(48);
      const newExpiresAt = new Date(now.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
      await tx.refreshToken.update({
        where: { id: row.tokenId },
        data: { usedAt: now, revokedAt: now },
      });
      const created = await tx.refreshToken.create({
        data: {
          sessionId: row.sessionId,
          tokenHash: sha256(newRawToken),
          expiresAt: newExpiresAt,
        },
      });
      await tx.refreshToken.update({
        where: { id: row.tokenId },
        data: { replacedByTokenId: created.id },
      });
      await tx.userSession.update({
        where: { id: row.sessionId },
        data: { lastUsedAt: now, expiresAt: newExpiresAt },
      });
      const access = this.tokens.signAccessToken({ userId: user.id, role: user.role, sessionId: row.sessionId });
      return { kind: 'ok', user, sessionId: row.sessionId, newRawToken, newExpiresAt, access } as const;
    });

    if (outcome.kind === 'reuse') {
      throw AppError.unauthorized(
        ErrorCode.REFRESH_TOKEN_REUSE,
        'Refresh token reuse detected. All sessions for this token family have been revoked.',
      );
    }
    if (outcome.kind === 'invalid') {
      throw AppError.unauthorized(
        outcome.reason === 'expired' ? ErrorCode.TOKEN_EXPIRED : ErrorCode.INVALID_TOKEN,
        outcome.reason === 'expired' ? 'Refresh token has expired' : 'Refresh token is invalid',
      );
    }
    return {
      user: toPublicUser(outcome.user),
      tokens: {
        accessToken: outcome.access.token,
        accessTokenExpiresIn: outcome.access.expiresInSeconds,
        refreshToken: outcome.newRawToken,
        refreshTokenExpiresAt: outcome.newExpiresAt,
        sessionId: outcome.sessionId,
      },
    };
  }

  async logout(userId: string, sessionId: string): Promise<void> {
    const now = new Date();
    await prisma.$transaction([
      prisma.userSession.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'LOGOUT' },
      }),
      prisma.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
  }

  async logoutAll(userId: string): Promise<{ revokedSessions: number }> {
    const now = new Date();
    const sessions = await prisma.userSession.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });
    await prisma.$transaction([
      prisma.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'LOGOUT_ALL' },
      }),
      prisma.refreshToken.updateMany({
        where: { session: { userId }, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
    return { revokedSessions: sessions.length };
  }

  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await prisma.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        deviceName: true,
        userAgent: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
    return sessions.map((session) => ({
      ...session,
      current: session.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const session = await prisma.userSession.findFirst({ where: { id: sessionId, userId } });
    if (!session) throw AppError.notFound(ErrorCode.NOT_FOUND, 'Session not found');
    if (session.revokedAt) return;
    const now = new Date();
    await prisma.$transaction([
      prisma.userSession.update({
        where: { id: sessionId },
        data: { revokedAt: now, revokedReason: 'USER_REVOKED' },
      }),
      prisma.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
  }

  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    const response = { message: 'If an account exists, a password reset email has been sent.' };
    if (!user || user.status === 'CLOSED') return response;

    const rawToken = generateSecureToken(32);
    await prisma.$transaction(async (tx) => {
      await tx.userVerification.updateMany({
        where: { userId: user.id, purpose: 'PASSWORD_RESET', consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.userVerification.create({
        data: {
          userId: user.id,
          purpose: 'PASSWORD_RESET',
          tokenHash: sha256(rawToken),
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
        },
      });
    });
    await this.trySendEmail({
      to: user.email,
      subject: 'Reset your NEXUS BANK password',
      text: `Hello ${user.name},\n\nUse this one-time token to reset your password:\n\n${rawToken}\n\nThis token expires in 30 minutes. If you did not request a reset, ignore this email.`,
    });
    return response;
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<{ message: string }> {
    const record = await prisma.userVerification.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { user: true },
    });
    if (!record || record.purpose !== 'PASSWORD_RESET') {
      throw AppError.badRequest(ErrorCode.INVALID_TOKEN, 'Password reset token is invalid');
    }
    if (record.consumedAt) throw AppError.badRequest(ErrorCode.INVALID_TOKEN, 'Password reset token has been used');
    if (record.expiresAt.getTime() <= Date.now()) {
      throw AppError.badRequest(ErrorCode.TOKEN_EXPIRED, 'Password reset token has expired');
    }
    this.assertPasswordNotDerivedFromIdentity(newPassword, record.user.email, record.user.name);
    const passwordHash = await hashPassword(newPassword);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      const consumed = await tx.userVerification.updateMany({
        where: { id: record.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) {
        throw AppError.badRequest(ErrorCode.INVALID_TOKEN, 'Password reset token is no longer valid');
      }
      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null, pinFailedAttempts: 0, pinLockedUntil: null },
      });
      await tx.userSession.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'PASSWORD_RESET' },
      });
      await tx.refreshToken.updateMany({
        where: { session: { userId: record.userId }, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.securityEvents.record(
        { userId: record.userId, type: 'PASSWORD_RESET', severity: 'HIGH' },
        tx,
      );
    });
    return { message: 'Password has been reset. Sign in with your new password.' };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentSessionId: string,
  ): Promise<{ message: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.unauthorized();
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw AppError.unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect');
    }
    this.assertPasswordNotDerivedFromIdentity(newPassword, user.email, user.name);
    if (await verifyPassword(user.passwordHash, newPassword)) {
      throw AppError.unprocessable(ErrorCode.PASSWORD_REUSE, 'New password must differ from the current password');
    }
    const passwordHash = await hashPassword(newPassword);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await tx.userSession.updateMany({
        where: { userId, revokedAt: null, id: { not: currentSessionId } },
        data: { revokedAt: now, revokedReason: 'PASSWORD_CHANGED' },
      });
      await tx.refreshToken.updateMany({
        where: {
          session: { userId, id: { not: currentSessionId } },
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      await this.securityEvents.record(
        { userId, type: 'PASSWORD_CHANGED', severity: 'MEDIUM' },
        tx,
      );
    });
    return { message: 'Password changed. Other sessions have been revoked.' };
  }

  async setupTwoFactor(userId: string, password: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.unauthorized();
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw AppError.unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Password is incorrect');
    }
    if (user.totpEnabled) {
      throw AppError.conflict(ErrorCode.TWO_FACTOR_ALREADY_ENABLED, 'Two-factor authentication is already enabled');
    }
    const { secret, otpauthUrl } = this.totp.generateSecret();
    await prisma.user.update({
      where: { id: userId },
      data: { totpSecretEncrypted: this.totp.encrypt(secret), totpEnabled: false, totpLastUsedStep: null },
    });
    return { secret, otpauthUrl };
  }

  async enableTwoFactor(userId: string, code: string): Promise<{ message: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpSecretEncrypted) {
      throw AppError.badRequest(ErrorCode.INVALID_TWO_FACTOR_CODE, 'Start two-factor setup first');
    }
    if (user.totpEnabled) {
      throw AppError.conflict(ErrorCode.TWO_FACTOR_ALREADY_ENABLED, 'Two-factor authentication is already enabled');
    }
    const secret = this.totp.decrypt(user.totpSecretEncrypted);
    this.totp.assertValidCode(secret, code);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { totpEnabled: true, totpLastUsedStep: this.totp.currentStep() },
      });
      await this.securityEvents.record(
        { userId, type: 'TWO_FACTOR_ENABLED', severity: 'MEDIUM' },
        tx,
      );
      void now;
    });
    return { message: 'Two-factor authentication enabled.' };
  }

  async disableTwoFactor(userId: string, password: string, code: string): Promise<{ message: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpEnabled || !user.totpSecretEncrypted) {
      throw AppError.badRequest(ErrorCode.INVALID_TWO_FACTOR_CODE, 'Two-factor authentication is not enabled');
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw AppError.unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Password is incorrect');
    }
    const secret = this.totp.decrypt(user.totpSecretEncrypted);
    this.totp.assertValidCode(secret, code);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { totpEnabled: false, totpSecretEncrypted: null, totpLastUsedStep: null },
      });
      await this.securityEvents.record(
        { userId, type: 'TWO_FACTOR_DISABLED', severity: 'HIGH' },
        tx,
      );
    });
    return { message: 'Two-factor authentication disabled.' };
  }

  async setTransactionPin(userId: string, password: string, pin: string): Promise<{ message: string }> {
    await this.pinService.setPin(userId, password, pin);
    return { message: 'Transaction PIN configured.' };
  }

  async changeTransactionPin(
    userId: string,
    password: string,
    currentPin: string,
    newPin: string,
  ): Promise<{ message: string }> {
    await this.pinService.changePin(userId, password, currentPin, newPin);
    return { message: 'Transaction PIN changed.' };
  }

  private async recordFailedLogin(user: User, meta: RequestMeta): Promise<void> {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });
    if (updated.failedLoginAttempts >= MAX_LOGIN_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOGIN_LOCK_MINUTES * 60_000);
      await prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil, failedLoginAttempts: 0 },
      });
      await this.securityEvents.record({
        userId: user.id,
        type: 'LOGIN_LOCKED',
        severity: 'HIGH',
        metadata: { lockedUntil: lockedUntil.toISOString() },
        ipHash: meta.ipHash,
        userAgent: meta.userAgent,
      });
      return;
    }
    await this.securityEvents.record({
      userId: user.id,
      type: 'LOGIN_FAILED',
      severity: 'LOW',
      metadata: { attempt: updated.failedLoginAttempts },
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
    });
  }

  private async createSession(user: User, meta: RequestMeta): Promise<TokenBundle> {
    const now = new Date();
    const refreshExpiresAt = new Date(now.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    const rawRefreshToken = generateSecureToken(48);
    const session = await prisma.$transaction(async (tx) => {
      const activeSessions = await tx.userSession.findMany({
        where: { userId: user.id, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      const allowedExisting = Math.max(0, this.config.MAX_ACTIVE_SESSIONS - 1);
      const excess = activeSessions.length - allowedExisting;
      if (excess > 0) {
        const toRevoke = activeSessions.slice(0, excess).map((item) => item.id);
        await tx.userSession.updateMany({
          where: { id: { in: toRevoke } },
          data: { revokedAt: now, revokedReason: 'SESSION_LIMIT' },
        });
        await tx.refreshToken.updateMany({
          where: { sessionId: { in: toRevoke }, revokedAt: null },
          data: { revokedAt: now },
        });
      }
      const created = await tx.userSession.create({
        data: {
          userId: user.id,
          deviceName: meta.deviceName?.slice(0, 100) ?? null,
          userAgent: meta.userAgent?.slice(0, 500) ?? null,
          ipHash: meta.ipHash,
          expiresAt: refreshExpiresAt,
        },
      });
      await tx.refreshToken.create({
        data: {
          sessionId: created.id,
          tokenHash: sha256(rawRefreshToken),
          expiresAt: refreshExpiresAt,
        },
      });
      return created;
    });

    const access = this.tokens.signAccessToken({ userId: user.id, role: user.role, sessionId: session.id });
    return {
      accessToken: access.token,
      accessTokenExpiresIn: access.expiresInSeconds,
      refreshToken: rawRefreshToken,
      refreshTokenExpiresAt: refreshExpiresAt,
      sessionId: session.id,
    };
  }

  private assertPasswordNotDerivedFromIdentity(password: string, email: string, name: string): void {
    const lowerPassword = password.toLowerCase().replace(/\s+/g, '');
    const localPart = email.split('@')[0]?.toLowerCase() ?? '';
    const compactName = name.toLowerCase().replace(/\s+/g, '');
    if (lowerPassword.includes(localPart) || (compactName.length >= 4 && lowerPassword.includes(compactName))) {
      throw AppError.badRequest(
        ErrorCode.VALIDATION_ERROR,
        'Password must not contain your name or email address',
      );
    }
  }

  private async trySendEmail(message: Parameters<EmailDispatcher['send']>[0]): Promise<void> {
    try {
      await this.email.send(message);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : 'unknown', recipient: message.to },
        'Email dispatch failed; auth flow continues',
      );
    }
  }
}
