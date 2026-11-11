import Stripe from 'stripe';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import type {
  CreateDepositIntentInput,
  DepositIntent,
  NormalizedPaymentEvent,
  PaymentGateway,
} from './types';

const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Stripe integration for educational/sandbox use only. It stores no card data: the hosted
 * Checkout page collects payment details directly from Stripe. All amounts are minor units.
 */
export class StripePaymentGateway implements PaymentGateway {
  readonly provider = 'STRIPE' as const;
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
    private readonly baseUrl: string,
  ) {
    this.stripe = new Stripe(secretKey, {
      apiVersion: '2025-08-27.basil',
      maxNetworkRetries: 2,
      timeout: 10_000,
    });
  }

  async createDepositIntent(input: CreateDepositIntentInput): Promise<DepositIntent> {
    const metadata: Record<string, string> = {
      transactionReference: input.transactionReference,
      userId: input.userId,
      ...(input.description ? { description: input.description.slice(0, 200) } : {}),
    };
    try {
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          payment_method_types: ['card'],
          client_reference_id: input.transactionReference,
          customer_email: undefined,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currencyCode.toLowerCase(),
                unit_amount: Number(input.amountMinor),
                product_data: {
                  name: 'NEXUS BANK wallet deposit',
                  description: 'Simulated wallet top-up. No real money is moved.',
                },
              },
            },
          ],
          metadata,
          payment_intent_data: { metadata },
          success_url: `${this.baseUrl}/payments/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${this.baseUrl}/payments/cancelled`,
          expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        },
        { idempotencyKey: `deposit-intent:${input.transactionReference}` },
      );
      return {
        providerReference: session.id,
        ...(session.url ? { checkoutUrl: session.url } : {}),
        ...(session.expires_at ? { expiresAt: new Date(session.expires_at * 1000) } : {}),
        metadata,
      };
    } catch (error) {
      throw new AppError(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'The payment provider could not create a deposit session',
        502,
        { cause: error },
      );
    }
  }

  async parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedPaymentEvent | null> {
    const signature = firstHeader(headers['stripe-signature']);
    if (!signature) {
      throw AppError.badRequest(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Missing Stripe signature header');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
        STRIPE_WEBHOOK_TOLERANCE_SECONDS,
      );
    } catch {
      throw AppError.badRequest(
        ErrorCode.WEBHOOK_SIGNATURE_INVALID,
        'Stripe webhook signature verification failed',
        undefined,
      );
    }

    const occurredAt = new Date(event.created * 1000);
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
        return null;
      }
      return {
        eventId: event.id,
        type: 'deposit.completed',
        providerReference: session.id,
        amountMinor: session.amount_total === null ? null : BigInt(session.amount_total),
        currencyCode: session.currency ? session.currency.toUpperCase() : null,
        occurredAt,
        rawType: event.type,
        metadata: session.metadata ?? undefined,
      };
    }
    if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const session = event.data.object as Stripe.Checkout.Session;
      return {
        eventId: event.id,
        type: 'deposit.failed',
        providerReference: session.id,
        amountMinor: session.amount_total === null ? null : BigInt(session.amount_total),
        currencyCode: session.currency ? session.currency.toUpperCase() : null,
        occurredAt,
        rawType: event.type,
        metadata: session.metadata ?? undefined,
      };
    }
    return null;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
