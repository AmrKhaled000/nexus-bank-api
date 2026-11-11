import type { AppConfig } from '../../config/env';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { createSimulatedPaymentGateway, SimulatedPaymentGateway } from './simulated-payment.gateway';
import { createSimulatedPayoutGateway, SimulatedPayoutGateway } from './simulated-payout.gateway';
import { StripePaymentGateway } from './stripe-payment.gateway';
import type { PaymentGateway, PayoutGateway } from './types';

export type PaymentGatewayProvider = PaymentGateway['provider'];

/**
 * Resolves a payment gateway by provider. SIMULATED is always available (development/tests);
 * STRIPE requires explicit configuration and valid credentials.
 */
export function createPaymentGateway(
  config: AppConfig,
  provider: PaymentGatewayProvider = config.PAYMENT_PROVIDER === 'stripe' ? 'STRIPE' : 'SIMULATED',
): PaymentGateway {
  if (provider === 'STRIPE') {
    if (!config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET) {
      throw new AppError(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.',
        503,
      );
    }
    return new StripePaymentGateway(
      config.STRIPE_SECRET_KEY,
      config.STRIPE_WEBHOOK_SECRET,
      config.APP_BASE_URL,
    );
  }
  return createSimulatedPaymentGateway(config);
}

/** Only the simulated provider is enabled for payouts; no real bank rails are used. */
export function createPayoutGateway(config: AppConfig): PayoutGateway {
  if (config.PAYOUT_PROVIDER !== 'simulated') {
    throw new AppError(ErrorCode.PAYMENT_PROVIDER_ERROR, 'Unsupported payout provider', 503);
  }
  return createSimulatedPayoutGateway(config);
}

export { SimulatedPaymentGateway, SimulatedPayoutGateway, StripePaymentGateway };
