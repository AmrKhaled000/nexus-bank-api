import { z } from 'zod';
import type { AppConfig } from '../../config/env';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { publicReference } from '../../common/ids/reference';
import type {
  CreateDepositIntentInput,
  DepositIntent,
  NormalizedPaymentEvent,
  PaymentGateway,
} from './types';
import { verifyWebhookSignature } from './webhook-signature';

const eventSchema = z
  .object({
    id: z.string().min(8).max(200),
    type: z.enum(['deposit.completed', 'deposit.failed']),
    created: z.coerce.number().int().nonnegative().optional(),
    data: z
      .object({
        providerReference: z.string().min(8).max(200),
        amountMinor: z.union([z.string().regex(/^\d{1,18}$/), z.number().int().nonnegative()]).optional(),
        currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
        metadata: z.record(z.string().max(200)).optional(),
      })
      .strict(),
  })
  .strict();

export class SimulatedPaymentGateway implements PaymentGateway {
  readonly provider = 'SIMULATED' as const;

  constructor(
    private readonly secret: string,
    private readonly toleranceSeconds: number,
  ) {}

  async createDepositIntent(input: CreateDepositIntentInput): Promise<DepositIntent> {
    const providerReference = `SIM-${input.transactionReference}`;
    const expiresAt = new Date(Date.now() + 30 * 60_000);
    return {
      providerReference,
      expiresAt,
      metadata: {
        provider: 'SIMULATED',
        ...(input.description ? { description: input.description } : {}),
      },
    };
  }

  async parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedPaymentEvent> {
    const signatureHeader = firstHeader(headers['x-nexus-signature']);
    verifyWebhookSignature(rawBody, signatureHeader, this.secret, this.toleranceSeconds);

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw AppError.badRequest(ErrorCode.INVALID_JSON, 'Webhook body is not valid JSON');
    }
    const parsed = eventSchema.safeParse(json);
    if (!parsed.success) {
      throw AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'Webhook payload is invalid', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const event = parsed.data;
    return {
      eventId: event.id,
      type: event.type,
      providerReference: event.data.providerReference,
      amountMinor:
        event.data.amountMinor === undefined ? null : BigInt(String(event.data.amountMinor)),
      currencyCode: event.data.currency?.toUpperCase() ?? null,
      occurredAt: new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000),
      rawType: event.type,
      ...(event.data.metadata ? { metadata: event.data.metadata } : {}),
    };
  }

  static demoEvent(input: {
    eventId: string;
    type: 'deposit.completed' | 'deposit.failed';
    providerReference: string;
    amountMinor: bigint;
    currencyCode: string;
  }) {
    return {
      id: input.eventId,
      type: input.type,
      created: Math.floor(Date.now() / 1000),
      data: {
        providerReference: input.providerReference,
        amountMinor: input.amountMinor.toString(),
        currency: input.currencyCode,
      },
    };
  }

  static newEventId(): string {
    return publicReference('SIM-EVT');
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createSimulatedPaymentGateway(config: AppConfig): SimulatedPaymentGateway {
  if (!config.PAYMENT_WEBHOOK_SECRET) {
    throw new Error('PAYMENT_WEBHOOK_SECRET is required for the simulated payment webhook');
  }
  return new SimulatedPaymentGateway(
    config.PAYMENT_WEBHOOK_SECRET,
    config.PAYMENT_WEBHOOK_TOLERANCE_SECONDS,
  );
}
