import type { AppConfig } from '../../config/env';
import type { EmailDispatcher } from './email-dispatcher';
import { FileEmailDispatcher } from './dev-email-dispatcher';
import { SmtpEmailDispatcher } from './smtp-email-dispatcher';

export function createEmailDispatcher(config: AppConfig): EmailDispatcher {
  if (config.SMTP_HOST) return new SmtpEmailDispatcher(config);
  if (config.isProduction) {
    throw new Error('SMTP_HOST must be configured in production; the file email transport is development-only');
  }
  return new FileEmailDispatcher(config.DEV_MAIL_DIR);
}
