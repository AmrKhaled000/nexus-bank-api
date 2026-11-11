import { authenticator } from 'otplib';
import type { AppConfig } from '../../config/env';
import { decryptSecret, encryptSecret } from '../../common/crypto/crypto';
import { AppError, ErrorCode } from '../../common/errors/app-error';

authenticator.options = { window: 1, step: 30 };

export class TotpService {
  constructor(private readonly config: AppConfig) {}

  generateSecret(): { secret: string; otpauthUrl: string } {
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri('nexus-bank-user', 'NEXUS BANK', secret);
    return { secret, otpauthUrl };
  }

  encrypt(secret: string): string {
    return encryptSecret(secret, this.config.ENCRYPTION_KEY);
  }

  decrypt(encrypted: string): string {
    return decryptSecret(encrypted, this.config.ENCRYPTION_KEY);
  }

  verify(secret: string, code: string): boolean {
    try {
      return authenticator.check(code, secret);
    } catch {
      return false;
    }
  }

  currentStep(): number {
    return Math.floor(Date.now() / 1000 / 30);
  }

  assertValidCode(secret: string, code: string): void {
    if (!this.verify(secret, code)) {
      throw AppError.unprocessable(ErrorCode.INVALID_TWO_FACTOR_CODE, 'Invalid authenticator code');
    }
  }
}
