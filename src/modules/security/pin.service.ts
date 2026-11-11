import type { AppConfig } from '../../config/env';
import { hashPin, verifyPassword, verifyPin } from '../../common/crypto/crypto';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { prisma } from '../../infrastructure/database/prisma';
import type { SecurityEventService } from '../security/security-event.service';

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

export class PinService {
  constructor(
    private readonly config: AppConfig,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async setPin(userId: string, password: string, pin: string): Promise<void> {
    const user = await this.requireUser(userId);
    if (!user.emailVerifiedAt || user.status !== 'ACTIVE') {
      throw AppError.forbidden(ErrorCode.EMAIL_NOT_VERIFIED, 'Email verification is required before setting a PIN');
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw AppError.unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Password is incorrect');
    }
    const pinHash = await hashPin(pin, this.config.PIN_PEPPER);
    await prisma.user.update({
      where: { id: userId },
      data: { pinHash, pinSetAt: new Date(), pinFailedAttempts: 0, pinLockedUntil: null },
    });
  }

  async changePin(userId: string, password: string, currentPin: string, newPin: string): Promise<void> {
    if (currentPin === newPin) {
      throw AppError.unprocessable(ErrorCode.CONFLICT, 'New PIN must differ from the current PIN');
    }
    const user = await this.requireUser(userId);
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw AppError.unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Password is incorrect');
    }
    if (!user.pinHash) {
      throw AppError.badRequest(ErrorCode.PIN_REQUIRED, 'No transaction PIN is configured');
    }
    this.assertNotLocked(user.pinLockedUntil);
    if (!(await verifyPin(user.pinHash, currentPin, this.config.PIN_PEPPER))) {
      throw AppError.unauthorized(ErrorCode.INVALID_PIN, 'Current PIN is incorrect');
    }
    const pinHash = await hashPin(newPin, this.config.PIN_PEPPER);
    await prisma.user.update({
      where: { id: userId },
      data: { pinHash, pinSetAt: new Date(), pinFailedAttempts: 0, pinLockedUntil: null },
    });
  }

  /**
   * Verified outside financial transactions so that failed attempts are persisted even though
   * the financial operation is rolled back. Successful verification resets the counter.
   */
  async verifyForTransaction(userId: string, pin: string | undefined): Promise<void> {
    if (!pin) {
      throw AppError.badRequest(ErrorCode.PIN_REQUIRED, 'Transaction PIN is required');
    }
    const user = await this.requireUser(userId);
    if (!user.pinHash) {
      throw AppError.badRequest(ErrorCode.PIN_REQUIRED, 'Set a transaction PIN before performing this operation');
    }
    this.assertNotLocked(user.pinLockedUntil);
    const valid = await verifyPin(user.pinHash, pin, this.config.PIN_PEPPER);
    if (valid) {
      if (user.pinFailedAttempts !== 0 || user.pinLockedUntil) {
        await prisma.user.update({
          where: { id: userId },
          data: { pinFailedAttempts: 0, pinLockedUntil: null },
        });
      }
      return;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { pinFailedAttempts: { increment: 1 } },
      select: { pinFailedAttempts: true },
    });
    let lockedUntil: Date | null = null;
    if (updated.pinFailedAttempts >= MAX_PIN_ATTEMPTS) {
      lockedUntil = new Date(Date.now() + PIN_LOCK_MINUTES * 60_000);
      await prisma.user.update({
        where: { id: userId },
        data: { pinLockedUntil: lockedUntil, pinFailedAttempts: 0 },
      });
      await this.securityEvents.record({
        userId,
        type: 'PIN_LOCKED',
        severity: 'HIGH',
        metadata: { lockedUntil: lockedUntil.toISOString() },
      });
      throw new AppError(
        ErrorCode.PIN_LOCKED,
        'Too many incorrect PIN attempts. Transaction PIN is temporarily locked.',
        423,
      );
    }
    await this.securityEvents.record({
      userId,
      type: 'PIN_FAILED',
      severity: 'MEDIUM',
      metadata: { attempt: updated.pinFailedAttempts },
    });
    throw AppError.unauthorized(ErrorCode.INVALID_PIN, 'Transaction PIN is incorrect');
  }

  private assertNotLocked(lockedUntil: Date | null): void {
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      throw new AppError(
        ErrorCode.PIN_LOCKED,
        'Transaction PIN is temporarily locked due to failed attempts',
        423,
      );
    }
  }

  private async requireUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        passwordHash: true,
        pinHash: true,
        pinFailedAttempts: true,
        pinLockedUntil: true,
        emailVerifiedAt: true,
        status: true,
      },
    });
    if (!user) throw AppError.unauthorized();
    return user;
  }
}
