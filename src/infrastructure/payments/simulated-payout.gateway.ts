import { createHmac } from 'node:crypto';
import type { AppConfig } from '../../config/env';
import type { PayoutGateway, PayoutRequest, PayoutResult } from './types';

/**
 * Deterministic sandbox payout provider. It performs no network call and moves no money.
 * The outcome is controlled by SIMULATED_PAYOUT_OUTCOME, which makes failure paths testable.
 */
export class SimulatedPayoutGateway implements PayoutGateway {
  readonly provider = 'SIMULATED' as const;

  constructor(private readonly outcome: 'success' | 'failure') {}

  async createPayout(input: PayoutRequest): Promise<PayoutResult> {
    const digest = createHmac('sha256', 'nexus-simulated-payout')
      .update(`${input.withdrawalId}:${input.idempotencyKey}`)
      .digest('hex')
      .slice(0, 16)
      .toUpperCase();
    const providerReference = `SIM-PAYOUT-${digest}`;

    if (this.outcome === 'failure') {
      return {
        success: false,
        providerReference,
        failureCode: 'SIMULATED_BANK_REJECTION',
        failureReason: 'The simulated payout provider rejected this bank account (sandbox outcome).',
      };
    }
    return { success: true, providerReference };
  }
}

export function createSimulatedPayoutGateway(config: AppConfig): SimulatedPayoutGateway {
  return new SimulatedPayoutGateway(config.SIMULATED_PAYOUT_OUTCOME);
}
