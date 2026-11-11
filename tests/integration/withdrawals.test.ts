import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, prisma } from '../helpers/db';
import { bearer, createTestContext, type TestContext } from '../helpers/app';
import {
  TEST_PIN,
  createPayoutMethod,
  createSession,
  createTestUser,
  createTestWallet,
  fundWallet,
  idempotencyKey,
} from '../helpers/fixtures';

const context: TestContext = createTestContext();
const failurePayoutContext: TestContext = createTestContext({
  SIMULATED_PAYOUT_OUTCOME: 'failure',
  AUTO_APPROVE_WITHDRAWALS: 'true',
});
const { agent } = context;

interface FundedCustomer {
  user: Awaited<ReturnType<typeof createTestUser>>;
  wallet: Awaited<ReturnType<typeof createTestWallet>>;
  payoutMethodId: string;
  token: string;
}

async function fundedCustomer(emailPrefix: string, fundMinor: bigint): Promise<FundedCustomer> {
  const user = await createTestUser({ emailPrefix });
  const wallet = await createTestWallet(user);
  if (fundMinor > 0n) await fundWallet(wallet, fundMinor);
  const payout = await createPayoutMethod(user);
  const session = await createSession(user);
  return { user, wallet, payoutMethodId: payout.id, token: session.accessToken };
}

function withdrawalRequest(token: string, key = idempotencyKey('withdrawal')) {
  return agent()
    .post('/api/v1/withdrawals')
    .set('Authorization', bearer(token))
    .set('Idempotency-Key', key);
}

describe('withdrawals and holds', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await context.close();
    await failurePayoutContext.close();
  });

  it('creates a pending withdrawal, reserves amount plus fee and hides it from available balance', async () => {
    const customer = await fundedCustomer('withdraw-create', 500_000n);

    const created = await withdrawalRequest(customer.token).send({
      walletId: customer.wallet.id,
      payoutMethodId: customer.payoutMethodId,
      amount: '75.00',
      pin: TEST_PIN,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.withdrawal).toMatchObject({
      status: 'PENDING',
      amountMinor: '7500',
      feeMinor: '50',
      totalMinor: '7550',
      currency: 'USD',
    });

    const walletView = await agent()
      .get(`/api/v1/wallets/${customer.wallet.id}`)
      .set('Authorization', bearer(customer.token));
    expect(walletView.body.data.balance).toMatchObject({
      totalMinor: '500000',
      availableMinor: '492450',
      heldMinor: '7550',
    });

    const hold = await prisma.walletHold.findFirst({ where: { walletId: customer.wallet.id } });
    expect(hold).toMatchObject({ status: 'ACTIVE', amountMinor: 7550n });
  });

  it('flags large withdrawals for manual review', async () => {
    const customer = await fundedCustomer('withdraw-review', 1_500_000n);

    const created = await withdrawalRequest(customer.token).send({
      walletId: customer.wallet.id,
      payoutMethodId: customer.payoutMethodId,
      amount: '10000.00',
      pin: TEST_PIN,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.withdrawal.status).toBe('UNDER_REVIEW');
  });

  it('rejects withdrawals above the per-transaction limit', async () => {
    const customer = await fundedCustomer('withdraw-limit', 100_000_000n);

    const created = await withdrawalRequest(customer.token).send({
      walletId: customer.wallet.id,
      payoutMethodId: customer.payoutMethodId,
      amount: '25000.00',
      pin: TEST_PIN,
    });
    expect(created.status).toBe(422);
    expect(created.body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('requires amount plus fee to be available, not just the amount', async () => {
    const customer = await fundedCustomer('withdraw-fee-check', 10_000n);

    const created = await withdrawalRequest(customer.token).send({
      walletId: customer.wallet.id,
      payoutMethodId: customer.payoutMethodId,
      amount: '100.00',
      pin: TEST_PIN,
    });
    expect(created.status).toBe(422);
    expect(created.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await prisma.walletHold.count()).toBe(0);
  });

  it('releases the hold when the withdrawal is cancelled', async () => {
    const customer = await fundedCustomer('withdraw-cancel', 500_000n);

    const created = await withdrawalRequest(customer.token).send({
      walletId: customer.wallet.id,
      payoutMethodId: customer.payoutMethodId,
      amount: '40.00',
      pin: TEST_PIN,
    });
    const withdrawalId = created.body.data.withdrawal.id as string;

    const cancelled = await agent()
      .post(`/api/v1/withdrawals/${withdrawalId}/cancel`)
      .set('Authorization', bearer(customer.token))
      .send({ reason: 'Changed my mind' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const walletView = await agent()
      .get(`/api/v1/wallets/${customer.wallet.id}`)
      .set('Authorization', bearer(customer.token));
    expect(walletView.body.data.balance).toMatchObject({ totalMinor: '500000', availableMinor: '500000', heldMinor: '0' });

    const hold = await prisma.walletHold.findFirst({ where: { walletId: customer.wallet.id } });
    expect(hold?.status).toBe('RELEASED');
  });

  it('approves a pending withdrawal and settles it through the payout rail', async () => {
    const finance = await createTestUser({ role: 'FINANCE_ADMIN', emailPrefix: 'withdraw-finance' });
    const financeSession = await createSession(finance);
    const customer = await fundedCustomer('withdraw-approve', 500_000n);

    const created = await withdrawalRequest(customer.token).send({
      walletId: customer.wallet.id,
      payoutMethodId: customer.payoutMethodId,
      amount: '75.00',
      pin: TEST_PIN,
    });
    const withdrawalId = created.body.data.withdrawal.id as string;

    const approveWithoutPermission = await agent()
      .post(`/api/v1/admin/withdrawals/${withdrawalId}/approve`)
      .set('Authorization', bearer(customer.token));
    expect(approveWithoutPermission.status).toBe(403);

    const approved = await agent()
      .post(`/api/v1/admin/withdrawals/${withdrawalId}/approve`)
      .set('Authorization', bearer(financeSession.accessToken))
      .send({ note: 'Reviewed against account activity' });
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('COMPLETED');
    expect(approved.body.data.payoutReference).toMatch(/^SIM-PAYOUT-/);

    const walletView = await agent()
      .get(`/api/v1/wallets/${customer.wallet.id}`)
      .set('Authorization', bearer(customer.token));
    expect(walletView.body.data.balance).toMatchObject({
      totalMinor: '492450',
      availableMinor: '492450',
      heldMinor: '0',
    });

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    expect(withdrawal?.status).toBe('COMPLETED');
    const hold = await prisma.walletHold.findFirst({ where: { walletId: customer.wallet.id } });
    expect(hold?.status).toBe('CONSUMED');

    const trialBalance = await agent()
      .get('/api/v1/admin/ledger/trial-balance')
      .set('Authorization', bearer(financeSession.accessToken));
    expect(trialBalance.body.data.balanced).toBe(true);

    const transaction = await prisma.financialTransaction.findFirst({
      where: { id: withdrawal!.transactionId },
    });
    expect(transaction?.status).toBe('COMPLETED');
  });

  it('rejects a pending withdrawal and releases the hold', async () => {
    const finance = await createTestUser({ role: 'FINANCE_ADMIN', emailPrefix: 'withdraw-finance-reject' });
    const financeSession = await createSession(finance);
    const support = await createTestUser({ role: 'SUPPORT', emailPrefix: 'withdraw-support' });
    const supportSession = await createSession(support);
    const customer = await fundedCustomer('withdraw-reject', 500_000n);

    const created = await withdrawalRequest(customer.token).send({
      walletId: customer.wallet.id,
      payoutMethodId: customer.payoutMethodId,
      amount: '30.00',
      pin: TEST_PIN,
    });
    const withdrawalId = created.body.data.withdrawal.id as string;

    const denied = await agent()
      .post(`/api/v1/admin/withdrawals/${withdrawalId}/reject`)
      .set('Authorization', bearer(supportSession.accessToken))
      .send({ reason: 'Unsupported route' });
    expect(denied.status).toBe(403);

    const missingReason = await agent()
      .post(`/api/v1/admin/withdrawals/${withdrawalId}/reject`)
      .set('Authorization', bearer(financeSession.accessToken))
      .send({ reason: 'no' });
    expect(missingReason.status).toBe(400);

    const rejected = await agent()
      .post(`/api/v1/admin/withdrawals/${withdrawalId}/reject`)
      .set('Authorization', bearer(financeSession.accessToken))
      .send({ reason: 'Account flagged for review' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('REJECTED');

    const walletView = await agent()
      .get(`/api/v1/wallets/${customer.wallet.id}`)
      .set('Authorization', bearer(customer.token));
    expect(walletView.body.data.balance).toMatchObject({ totalMinor: '500000', availableMinor: '500000', heldMinor: '0' });
  });

  it('prevents cancelling an already approved withdrawal', async () => {
    const finance = await createTestUser({ role: 'FINANCE_ADMIN', emailPrefix: 'withdraw-finance-cancel' });
    const financeSession = await createSession(finance);
    const customer = await fundedCustomer('withdraw-cancel-approved', 500_000n);

    const created = await withdrawalRequest(customer.token).send({
      walletId: customer.wallet.id,
      payoutMethodId: customer.payoutMethodId,
      amount: '20.00',
      pin: TEST_PIN,
    });
    await agent()
      .post(`/api/v1/admin/withdrawals/${created.body.data.withdrawal.id}/approve`)
      .set('Authorization', bearer(financeSession.accessToken))
      .send({});

    const cancelled = await agent()
      .post(`/api/v1/withdrawals/${created.body.data.withdrawal.id}/cancel`)
      .set('Authorization', bearer(customer.token))
      .send({ reason: 'Too late' });
    expect(cancelled.status).toBe(409);
  });

  it('replays an idempotent withdrawal creation and rejects payload mismatch', async () => {
    const customer = await fundedCustomer('withdraw-idempotency', 500_000n);
    const key = idempotencyKey('withdraw-replay');
    const body = {
      walletId: customer.wallet.id,
      payoutMethodId: customer.payoutMethodId,
      amount: '25.00',
      pin: TEST_PIN,
    };

    const first = await withdrawalRequest(customer.token, key).send(body);
    expect(first.status).toBe(201);

    const replay = await withdrawalRequest(customer.token, key).send(body);
    expect(replay.status).toBe(201);
    expect(replay.body.meta.idempotentReplay).toBe(true);
    expect(replay.body.data.withdrawal.id).toBe(first.body.data.withdrawal.id);

    const conflict = await withdrawalRequest(customer.token, key).send({ ...body, amount: '26.00' });
    expect(conflict.status).toBe(422);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    expect(await prisma.walletHold.count({ where: { walletId: customer.wallet.id } })).toBe(1);
  });

  it('prevents two concurrent withdrawals from spending the same funds', async () => {
    const customer = await fundedCustomer('withdraw-race', 10_000n);

    const attempt = () =>
      withdrawalRequest(customer.token).send({
        walletId: customer.wallet.id,
        payoutMethodId: customer.payoutMethodId,
        amount: '60.00',
        pin: TEST_PIN,
      });
    const [a, b] = await Promise.all([attempt(), attempt()]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 422]);
    expect(a.status === 422 ? a.body.error.code : b.body.error.code).toBe('INSUFFICIENT_FUNDS');

    const holds = await prisma.walletHold.count({ where: { walletId: customer.wallet.id, status: 'ACTIVE' } });
    expect(holds).toBe(1);
  });

  it('makes held funds unavailable to transfers', async () => {
    const customer = await fundedCustomer('withdraw-hold-transfer', 10_000n);
    const recipient = await fundedCustomer('withdraw-hold-recipient', 0n);

    const withdrawal = await withdrawalRequest(customer.token).send({
      walletId: customer.wallet.id,
      payoutMethodId: customer.payoutMethodId,
      amount: '60.00',
      pin: TEST_PIN,
    });
    expect(withdrawal.status).toBe(201);

    const transfer = await agent()
      .post('/api/v1/transfers')
      .set('Authorization', bearer(customer.token))
      .set('Idempotency-Key', idempotencyKey('transfer-over-hold'))
      .send({
        sourceWalletId: customer.wallet.id,
        destinationWalletId: recipient.wallet.id,
        amount: '45.00',
        pin: TEST_PIN,
      });
    expect(transfer.status).toBe(422);
    expect(transfer.body.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('fails the withdrawal and releases the hold when the payout provider rejects it', async () => {
    const failingAgent = failurePayoutContext.agent();
    const customer = await fundedCustomer('withdraw-payout-failure', 500_000n);

    const created = await failingAgent
      .post('/api/v1/withdrawals')
      .set('Authorization', bearer(customer.token))
      .set('Idempotency-Key', idempotencyKey('withdraw-failure'))
      .send({
        walletId: customer.wallet.id,
        payoutMethodId: customer.payoutMethodId,
        amount: '10.00',
        pin: TEST_PIN,
      });
    expect(created.status).toBe(201);
    // The creation response reflects the approved request; the payout dispatch runs inline
    // afterwards and settles to FAILED.
    expect(created.body.data.withdrawal.status).toBe('APPROVED');

    const fetched = await agent()
      .get(`/api/v1/withdrawals/${created.body.data.withdrawal.id}`)
      .set('Authorization', bearer(customer.token));
    expect(fetched.body.data).toMatchObject({ status: 'FAILED', failureCode: 'SIMULATED_BANK_REJECTION' });

    const walletView = await agent()
      .get(`/api/v1/wallets/${customer.wallet.id}`)
      .set('Authorization', bearer(customer.token));
    expect(walletView.body.data.balance).toMatchObject({ totalMinor: '500000', availableMinor: '500000', heldMinor: '0' });

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id: created.body.data.withdrawal.id } });
    expect(withdrawal?.status).toBe('FAILED');
    expect(await prisma.journalEntryLine.count()).toBeGreaterThanOrEqual(2); // funding entry only
  });
});
