export interface CreateDepositIntentInput {
  transactionReference: string;
  amountMinor: bigint;
  currencyCode: string;
  userId: string;
  description?: string;
}

export interface DepositIntent {
  providerReference: string;
  checkoutUrl?: string;
  clientSecret?: string;
  expiresAt?: Date;
  metadata?: Record<string, string>;
}

export type NormalizedPaymentEventType =
  | 'deposit.completed'
  | 'deposit.failed'
  | 'payout.completed'
  | 'payout.failed';

export interface NormalizedPaymentEvent {
  eventId: string;
  type: NormalizedPaymentEventType;
  providerReference: string;
  amountMinor: bigint | null;
  currencyCode: string | null;
  occurredAt: Date;
  rawType: string;
  metadata?: Record<string, string>;
}

export interface PaymentGateway {
  readonly provider: 'SIMULATED' | 'STRIPE';
  createDepositIntent(input: CreateDepositIntentInput): Promise<DepositIntent>;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<NormalizedPaymentEvent | null>;
}

export interface PayoutRequest {
  withdrawalId: string;
  amountMinor: bigint;
  currencyCode: string;
  bankName: string;
  accountLast4: string;
  idempotencyKey: string;
}

export interface PayoutResult {
  success: boolean;
  providerReference: string;
  failureCode?: string;
  failureReason?: string;
}

export interface PayoutGateway {
  readonly provider: 'SIMULATED';
  createPayout(input: PayoutRequest): Promise<PayoutResult>;
}
