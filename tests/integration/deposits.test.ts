import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, prisma } from '../helpers/db';
import { bearer, createTestContext, type TestContext } from '../helpers/app';
import {
  createSession,
  createTestUser,
  createTestWallet,
  idempotencyKey,
} from '../helpers/fixtures';
import { signWebhookPayload } from '../../src/infrastructure/payments/webhook-signature';

const context: TestContext = createTestContext();
const { agent, config } = context;
const SECRET = config.PAYMENT_WEBHOOK_SECRET;

async function depositingCustomer(emailPrefix: string) {
  const user = await createTestUser({ emailPrefix });
  const wallet = await createTestWallet(user);
  const session = await createSession(user);
  return { user, wallet, token: session.accessToken };
}

function createDepositRequest(token: string, body: Record<string, unknown>, key = idempotencyKey('deposit')) {
  return agent()
    .post('/api/v1/deposits')
    .set('Authorization', bearer(token))
    .set('Idempotency-Key', key)
    .send(body);
}

function signedWebhookBody(payload: Record<string, unknown>) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const timestamp = Math.floor(Date.now() / 1000);
  return { raw, header: signWebhookPayload(raw, SECRET, timestamp) };
}

describe('deposits and payment webhooks', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await context.close();
  });

  it('creates a pending deposit without moving funds and completes it via the simulate endpoint', async () => {
    const customer = await depositingCustomer('deposit-sim-completed');

    const created = await createDepositRequest(customer.token, { walletId: customer.wallet.id, amount: '250.00' });
    expect(created.status).toBe(201);
    expect(created.body.data.deposit).toMatchObject({
      status: 'PENDING',
      amountMinor: '25000',
      currency: 'USD',
      provider: 'SIMULATED',
    });
    expect(created.body.data.simulation).toMatchObject({ available: true });

    const beforeAccount = await prisma.walletAccount.findUnique({ where: { walletId: customer.wallet.id } });
    expect(beforeAccount?.balanceMinor).toBe(0n);

    const depositId = created.body.data.deposit.id as string;
    const simulated = await agent()
      .post(`/api/v1/deposits/${depositId}/simulate`)
      .set('Authorization', bearer(customer.token))
      .send({ outcome: 'completed' });
    expect(simulated.status).toBe(200);
    expect(simulated.body.data).toMatchObject({ status: 'processed', duplicate: false });

    const afterAccount = await prisma.walletAccount.findUnique({ where: { walletId: customer.wallet.id } });
    expect(afterAccount?.balanceMinor).toBe(25_000n);

    const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
    expect(deposit?.status).toBe('COMPLETED');

    const journal = await prisma.journalEntry.findFirst({
      where: { transaction: { id: deposit!.transactionId } },
      include: { lines: true },
    });
    const debits = journal!.lines.reduce((total, line) => total + line.debitMinor, 0n);
    const credits = journal!.lines.reduce((total, line) => total + line.creditMinor, 0n);
    expect(debits).toBe(credits);
  });

  it('marks a deposit as failed when the provider declines it and leaves the ledger untouched', async () => {
    const customer = await depositingCustomer('deposit-sim-failed');

    const created = await createDepositRequest(customer.token, { walletId: customer.wallet.id, amount: '75.50' });
    expect(created.status).toBe(201);
    const depositId = created.body.data.deposit.id as string;

    const simulated = await agent()
      .post(`/api/v1/deposits/${depositId}/simulate`)
      .set('Authorization', bearer(customer.token))
      .send({ outcome: 'failed' });
    expect(simulated.status).toBe(200);
    expect(simulated.body.data.status).toBe('processed');

    const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
    expect(deposit?.status).toBe('FAILED');

    const account = await prisma.walletAccount.findUnique({ where: { walletId: customer.wallet.id } });
    expect(account?.balanceMinor).toBe(0n);
    expect(await prisma.journalEntryLine.count()).toBe(0);
  });

  it('replays an idempotent deposit creation and rejects a mismatched reuse of the key', async () => {
    const customer = await depositingCustomer('deposit-idempotency');
    const key = idempotencyKey('deposit-replay');
    const body = { walletId: customer.wallet.id, amount: '10.00' };

    const first = await createDepositRequest(customer.token, body, key);
    expect(first.status).toBe(201);

    const replay = await createDepositRequest(customer.token, body, key);
    expect(replay.status).toBe(201);
    expect(replay.body.meta.idempotentReplay).toBe(true);
    expect(replay.body.data.deposit.id).toBe(first.body.data.deposit.id);
    expect(await prisma.deposit.count()).toBe(1);

    const conflict = await createDepositRequest(customer.token, { ...body, amount: '10.01' }, key);
    expect(conflict.status).toBe(422);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('enforces the per-transaction deposit limit', async () => {
    const customer = await depositingCustomer('deposit-limit');
    const response = await createDepositRequest(customer.token, { walletId: customer.wallet.id, amount: '60000.00' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('rejects deposits into wallets owned by someone else', async () => {
    const customer = await depositingCustomer('deposit-owner');
    const other = await depositingCustomer('deposit-other');

    const response = await createDepositRequest(customer.token, { walletId: other.wallet.id, amount: '5.00' });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  it('settles a deposit from a correctly signed webhook', async () => {
    const customer = await depositingCustomer('deposit-webhook');

    const created = await createDepositRequest(customer.token, { walletId: customer.wallet.id, amount: '120.25' });
    const deposit = created.body.data.deposit;
    const eventId = `SIM-EVT-WEBHOOK-${Date.now()}`;

    const payload = {
      id: eventId,
      type: 'deposit.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        providerReference: deposit.providerReference,
        amountMinor: deposit.amountMinor,
        currency: deposit.currency,
      },
    };
    const { raw, header } = signedWebhookBody(payload);

    const webhook = await agent()
      .post('/api/v1/webhooks/payments/simulated')
      .set('Content-Type', 'application/json')
      .set('X-Nexus-Signature', header)
      .send(raw.toString('utf8'));
    expect(webhook.status).toBe(200);
    expect(webhook.body.data).toMatchObject({ status: 'processed', duplicate: false });

    const account = await prisma.walletAccount.findUnique({ where: { walletId: customer.wallet.id } });
    expect(account?.balanceMinor).toBe(12_025n);
    const settled = await prisma.deposit.findUnique({ where: { id: deposit.id } });
    expect(settled?.status).toBe('COMPLETED');
  });

  it('rejects an unsigned webhook before touching the database', async () => {
    const customer = await depositingCustomer('deposit-unsigned-webhook');

    const created = await createDepositRequest(customer.token, { walletId: customer.wallet.id, amount: '10.00' });
    const deposit = created.body.data.deposit;
    const payload = {
      id: `SIM-EVT-UNSIGNED-${Date.now()}`,
      type: 'deposit.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        providerReference: deposit.providerReference,
        amountMinor: deposit.amountMinor,
        currency: deposit.currency,
      },
    };

    const webhook = await agent()
      .post('/api/v1/webhooks/payments/simulated')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify(payload), 'utf8'));
    expect(webhook.status).toBe(401);
    expect(webhook.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it('flags a signed webhook whose amount does not match the deposit', async () => {
    const customer = await depositingCustomer('deposit-mismatch');

    const created = await createDepositRequest(customer.token, { walletId: customer.wallet.id, amount: '100.00' });
    const deposit = created.body.data.deposit;
    const payload = {
      id: `SIM-EVT-MISMATCH-${Date.now()}`,
      type: 'deposit.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        providerReference: deposit.providerReference,
        amountMinor: (BigInt(deposit.amountMinor) + 1n).toString(),
        currency: deposit.currency,
      },
    };
    const { raw, header } = signedWebhookBody(payload);

    const webhook = await agent()
      .post('/api/v1/webhooks/payments/simulated')
      .set('Content-Type', 'application/json')
      .set('X-Nexus-Signature', header)
      .send(raw.toString('utf8'));
    expect(webhook.status).toBe(422);
    expect(webhook.body.data.status).toBe('failed');

    const stored = await prisma.deposit.findUnique({ where: { id: deposit.id } });
    expect(stored?.status).toBe('PENDING');

    const event = await prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider: 'SIMULATED', eventId: payload.id } },
    });
    expect(event?.status).toBe('FAILED');

    const security = await prisma.securityEvent.findFirst({
      where: { userId: customer.user.id, type: 'SUSPICIOUS_TRANSACTION' },
    });
    expect(security?.severity).toBe('CRITICAL');

    const account = await prisma.walletAccount.findUnique({ where: { walletId: customer.wallet.id } });
    expect(account?.balanceMinor).toBe(0n);
  });

  it('processes each signed webhook event exactly once', async () => {
    const customer = await depositingCustomer('deposit-duplicate');

    const created = await createDepositRequest(customer.token, { walletId: customer.wallet.id, amount: '42.00' });
    const deposit = created.body.data.deposit;
    const payload = {
      id: `SIM-EVT-DUPLICATE-${Date.now()}`,
      type: 'deposit.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        providerReference: deposit.providerReference,
        amountMinor: deposit.amountMinor,
        currency: deposit.currency,
      },
    };
    const { raw, header } = signedWebhookBody(payload);

    const first = await agent()
      .post('/api/v1/webhooks/payments/simulated')
      .set('Content-Type', 'application/json')
      .set('X-Nexus-Signature', header)
      .send(raw.toString('utf8'));
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('processed');

    const second = await agent()
      .post('/api/v1/webhooks/payments/simulated')
      .set('Content-Type', 'application/json')
      .set('X-Nexus-Signature', header)
      .send(raw.toString('utf8'));
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ status: 'duplicate', duplicate: true });

    expect(await prisma.webhookEvent.count()).toBe(1);
    const account = await prisma.walletAccount.findUnique({ where: { walletId: customer.wallet.id } });
    expect(account?.balanceMinor).toBe(4_200n);
  });

  it('ignores signed webhooks for unknown provider references without failing', async () => {
    const payload = {
      id: `SIM-EVT-UNKNOWN-${Date.now()}`,
      type: 'deposit.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        providerReference: 'SIM-DOES-NOT-EXIST-123456',
        amountMinor: '1000',
        currency: 'USD',
      },
    };
    const { raw, header } = signedWebhookBody(payload);

    const response = await agent()
      .post('/api/v1/webhooks/payments/simulated')
      .set('Content-Type', 'application/json')
      .set('X-Nexus-Signature', header)
      .send(raw.toString('utf8'));
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: 'ignored', duplicate: false });

    const event = await prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider: 'SIMULATED', eventId: payload.id } },
    });
    expect(event?.status).toBe('IGNORED');
  });

  it('expires stale pending deposits so they can no longer complete', async () => {
    const customer = await depositingCustomer('deposit-expiry');

    const created = await createDepositRequest(customer.token, { walletId: customer.wallet.id, amount: '60.00' });
    const depositId = created.body.data.deposit.id as string;

    await prisma.deposit.update({
      where: { id: depositId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const expired = await context.services.deposits.expireStale(10);
    expect(expired).toBe(1);

    const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
    expect(deposit?.status).toBe('EXPIRED');
    const transaction = await prisma.financialTransaction.findUnique({ where: { id: deposit!.transactionId } });
    expect(transaction?.status).toBe('CANCELLED');

    const account = await prisma.walletAccount.findUnique({ where: { walletId: customer.wallet.id } });
    expect(account?.balanceMinor).toBe(0n);
  });

  it('requires authentication and a deposit-bound wallet for the simulate endpoint', async () => {
    const customer = await depositingCustomer('deposit-auth');
    const created = await createDepositRequest(customer.token, { walletId: customer.wallet.id, amount: '5.00' });
    const depositId = created.body.data.deposit.id as string;

    const anonymous = await agent().post(`/api/v1/deposits/${depositId}/simulate`).send({ outcome: 'completed' });
    expect(anonymous.status).toBe(401);

    const intruder = await depositingCustomer('deposit-intruder');
    const foreign = await agent()
      .post(`/api/v1/deposits/${depositId}/simulate`)
      .set('Authorization', bearer(intruder.token))
      .send({ outcome: 'completed' });
    expect(foreign.status).toBe(404);
  });
});
