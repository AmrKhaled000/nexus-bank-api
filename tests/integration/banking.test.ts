import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, prisma } from '../helpers/db';
import { bearer, createTestContext, type TestContext } from '../helpers/app';
import {
  TEST_PIN,
  createSession,
  createTestUser,
  createTestWallet,
  fundWallet,
  idempotencyKey,
  type TestUser,
  type TestWallet,
} from '../helpers/fixtures';

const context: TestContext = createTestContext();
const { agent } = context;

interface FundedUser {
  user: TestUser;
  wallet: TestWallet;
  token: string;
}

async function fundedCustomer(emailPrefix: string, fundMinor: bigint): Promise<FundedUser> {
  const user = await createTestUser({ emailPrefix, name: `${emailPrefix} Testerson` });
  const wallet = await createTestWallet(user);
  if (fundMinor > 0n) await fundWallet(wallet, fundMinor);
  const session = await createSession(user);
  return { user, wallet, token: session.accessToken };
}

function transferRequest(token: string) {
  return agent()
    .post('/api/v1/transfers')
    .set('Authorization', bearer(token))
    .set('Idempotency-Key', idempotencyKey('transfer'));
}

describe('wallets and transfers', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await context.close();
  });

  it('creates wallets, tracks the primary wallet and rejects empty-wallet close', async () => {
    const user = await createTestUser({ emailPrefix: 'wallet-owner' });
    const session = await createSession(user);

    const first = await agent()
      .post('/api/v1/wallets')
      .set('Authorization', bearer(session.accessToken))
      .send({ name: 'Everyday', currencyCode: 'USD' });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ isPrimary: true, currency: expect.objectContaining({ code: 'USD' }) });
    expect(first.body.data.balance.totalMinor).toBe('0');

    const second = await agent()
      .post('/api/v1/wallets')
      .set('Authorization', bearer(session.accessToken))
      .send({ name: 'Savings', currencyCode: 'USD', type: 'SAVINGS', isPrimary: false });
    expect(second.status).toBe(201);
    expect(second.body.data.isPrimary).toBe(false);

    const list = await agent().get('/api/v1/wallets').set('Authorization', bearer(session.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);

    const close = await agent()
      .delete(`/api/v1/wallets/${second.body.data.id}`)
      .set('Authorization', bearer(session.accessToken));
    expect(close.status).toBe(200);

    const funded = await fundedCustomer('wallet-close', 100n);
    const closeFunded = await agent()
      .delete(`/api/v1/wallets/${funded.wallet.id}`)
      .set('Authorization', bearer(funded.token));
    expect(closeFunded.status).toBe(422);
    expect(closeFunded.body.error.code).toBe('WALLET_NOT_EMPTY');
  });

  it('transfers funds between two users and keeps the ledger balanced', async () => {
    const sender = await fundedCustomer('transfer-sender', 150_000n);
    const recipient = await fundedCustomer('transfer-recipient', 0n);

    const response = await transferRequest(sender.token).send({
      sourceWalletId: sender.wallet.id,
      destinationWalletId: recipient.wallet.id,
      amount: '123.45',
      description: 'Rent share',
      pin: TEST_PIN,
    });
    expect(response.status).toBe(201);
    expect(response.body.data.transfer).toMatchObject({
      type: 'TRANSFER',
      status: 'COMPLETED',
      amountMinor: '12345',
      feeMinor: '0',
      currency: 'USD',
    });
    expect(response.body.meta.idempotentReplay).toBe(false);

    const [senderWallet, recipientWallet] = await Promise.all([
      prisma.walletAccount.findUnique({ where: { walletId: sender.wallet.id } }),
      prisma.walletAccount.findUnique({ where: { walletId: recipient.wallet.id } }),
    ]);
    expect(senderWallet?.balanceMinor).toBe(137_655n);
    expect(recipientWallet?.balanceMinor).toBe(12_345n);

    const journal = await prisma.journalEntry.findFirst({
      where: { transaction: { reference: response.body.data.transfer.reference } },
      include: { lines: true },
    });
    expect(journal).not.toBeNull();
    const debits = journal!.lines.reduce((total, line) => total + line.debitMinor, 0n);
    const credits = journal!.lines.reduce((total, line) => total + line.creditMinor, 0n);
    expect(debits).toBe(credits);

    const finance = await createTestUser({ role: 'FINANCE_ADMIN', emailPrefix: 'transfer-audit' });
    const financeSession = await createSession(finance);
    const trialBalance = await agent()
      .get('/api/v1/admin/ledger/trial-balance')
      .set('Authorization', bearer(financeSession.accessToken));
    expect(trialBalance.status).toBe(200);
    expect(trialBalance.body.data.balanced).toBe(true);
  });

  it('replays an idempotent transfer and rejects a reused key with a different payload', async () => {
    const sender = await fundedCustomer('idem-sender', 150_000n);
    const recipient = await fundedCustomer('idem-recipient', 0n);

    const key = idempotencyKey('idem-transfer');
    const payload = {
      sourceWalletId: sender.wallet.id,
      destinationWalletId: recipient.wallet.id,
      amount: '25.00',
      pin: TEST_PIN,
    };

    const first = await agent()
      .post('/api/v1/transfers')
      .set('Authorization', bearer(sender.token))
      .set('Idempotency-Key', key)
      .send(payload);
    expect(first.status).toBe(201);

    const replay = await agent()
      .post('/api/v1/transfers')
      .set('Authorization', bearer(sender.token))
      .set('Idempotency-Key', key)
      .send(payload);
    expect(replay.status).toBe(201);
    expect(replay.body.meta.idempotentReplay).toBe(true);
    expect(replay.body.data.transfer.id).toBe(first.body.data.transfer.id);

    const transferCount = await prisma.transfer.count();
    expect(transferCount).toBe(1);

    const conflict = await agent()
      .post('/api/v1/transfers')
      .set('Authorization', bearer(sender.token))
      .set('Idempotency-Key', key)
      .send({ ...payload, amount: '26.00' });
    expect(conflict.status).toBe(422);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('requires the Idempotency-Key header for financial operations', async () => {
    const sender = await fundedCustomer('missing-idem', 150_000n);
    const recipient = await fundedCustomer('missing-idem-dest', 0n);

    const response = await agent()
      .post('/api/v1/transfers')
      .set('Authorization', bearer(sender.token))
      .send({
        sourceWalletId: sender.wallet.id,
        destinationWalletId: recipient.wallet.id,
        amount: '10.00',
        pin: TEST_PIN,
      });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('prevents double spending under concurrent transfers', async () => {
    const sender = await fundedCustomer('race-sender', 10_000n);
    const first = await fundedCustomer('race-one', 0n);
    const second = await fundedCustomer('race-two', 0n);

    const payloadBase = { amount: '80.00', pin: TEST_PIN };

    const [a, b] = await Promise.all([
      agent()
        .post('/api/v1/transfers')
        .set('Authorization', bearer(sender.token))
        .set('Idempotency-Key', idempotencyKey('race-transfer'))
        .send({ ...payloadBase, sourceWalletId: sender.wallet.id, destinationWalletId: first.wallet.id }),
      agent()
        .post('/api/v1/transfers')
        .set('Authorization', bearer(sender.token))
        .set('Idempotency-Key', idempotencyKey('race-transfer'))
        .send({ ...payloadBase, sourceWalletId: sender.wallet.id, destinationWalletId: second.wallet.id }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 422]);
    expect(a.status === 422 ? a.body.error.code : b.body.error.code).toBe('INSUFFICIENT_FUNDS');

    const walletAccount = await prisma.walletAccount.findUnique({ where: { walletId: sender.wallet.id } });
    expect(walletAccount?.balanceMinor).toBe(2_000n);
    expect(await prisma.transfer.count()).toBe(1);
  });

  it('rejects a transfer without sufficient funds without writing any ledger lines', async () => {
    const sender = await fundedCustomer('poor-sender', 5_000n);
    const recipient = await fundedCustomer('poor-recipient', 0n);

    const linesBefore = await prisma.journalEntryLine.count();
    const response = await transferRequest(sender.token).send({
      sourceWalletId: sender.wallet.id,
      destinationWalletId: recipient.wallet.id,
      amount: '50.01',
      pin: TEST_PIN,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INSUFFICIENT_FUNDS');

    expect(await prisma.transfer.count()).toBe(0);
    expect(await prisma.journalEntryLine.count()).toBe(linesBefore);
  });

  it('enforces the per-transaction transfer limit', async () => {
    const sender = await fundedCustomer('limit-sender', 9_000_000_000n);
    const recipient = await fundedCustomer('limit-recipient', 0n);

    const response = await transferRequest(sender.token).send({
      sourceWalletId: sender.wallet.id,
      destinationWalletId: recipient.wallet.id,
      amount: '60000.00',
      pin: TEST_PIN,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('rejects invalid transaction PINs and locks the PIN after repeated failures', async () => {
    const user = await createTestUser({ emailPrefix: 'pin-tester' });
    const wallet = await createTestWallet(user);
    await fundWallet(wallet, 150_000n);
    const session = await createSession(user);
    const recipient = await fundedCustomer('pin-recipient', 0n);

    const wrongPin = await transferRequest(session.accessToken).send({
      sourceWalletId: wallet.id,
      destinationWalletId: recipient.wallet.id,
      amount: '10.00',
      pin: '135790',
    });
    expect(wrongPin.status).toBe(401);
    expect(wrongPin.body.error.code).toBe('INVALID_PIN');

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await transferRequest(session.accessToken).send({
        sourceWalletId: wallet.id,
        destinationWalletId: recipient.wallet.id,
        amount: '10.00',
        pin: '135790',
      });
    }

    const locked = await transferRequest(session.accessToken).send({
      sourceWalletId: wallet.id,
      destinationWalletId: recipient.wallet.id,
      amount: '10.00',
      pin: TEST_PIN,
    });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('PIN_LOCKED');
  });

  it('rejects self-transfers, same wallet as source and destination, and currency mismatch', async () => {
    const sender = await fundedCustomer('self-sender', 150_000n);

    const self = await transferRequest(sender.token).send({
      sourceWalletId: sender.wallet.id,
      destinationWalletId: sender.wallet.id,
      amount: '1.00',
      pin: TEST_PIN,
    });
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe('CONFLICT');

    const euroRecipient = await createTestUser({ emailPrefix: 'euro-dest' });
    const euroWallet = await createTestWallet(euroRecipient, { currencyCode: 'EUR' });
    const mismatch = await transferRequest(sender.token).send({
      sourceWalletId: sender.wallet.id,
      destinationWalletId: euroWallet.id,
      amount: '1.00',
      pin: TEST_PIN,
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('CURRENCY_MISMATCH');
  });

  it('blocks transfers from closed wallets', async () => {
    const user = await createTestUser({ emailPrefix: 'closed-wallet' });
    const wallet = await createTestWallet(user);
    const session = await createSession(user);
    const recipient = await fundedCustomer('closed-dest', 0n);

    const closed = await agent()
      .delete(`/api/v1/wallets/${wallet.id}`)
      .set('Authorization', bearer(session.accessToken));
    expect(closed.status).toBe(200);

    const response = await transferRequest(session.accessToken).send({
      sourceWalletId: wallet.id,
      destinationWalletId: recipient.wallet.id,
      amount: '1.00',
      pin: TEST_PIN,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('WALLET_NOT_ACTIVE');
  });

  it('reverses a completed transfer via the admin endpoint and restores balances', async () => {
    const finance = await createTestUser({ role: 'FINANCE_ADMIN', emailPrefix: 'finance-admin' });
    const financeSession = await createSession(finance);
    const sender = await fundedCustomer('reversal-sender', 150_000n);
    const recipient = await fundedCustomer('reversal-recipient', 0n);

    const created = await transferRequest(sender.token).send({
      sourceWalletId: sender.wallet.id,
      destinationWalletId: recipient.wallet.id,
      amount: '75.00',
      pin: TEST_PIN,
    });
    expect(created.status).toBe(201);
    const transferId = created.body.data.transfer.id as string;

    const withoutConfirmation = await agent()
      .post(`/api/v1/admin/transfers/${transferId}/reverse`)
      .set('Authorization', bearer(financeSession.accessToken))
      .set('Idempotency-Key', idempotencyKey('reverse'))
      .send({ reason: 'Requested by compliance review' });
    expect(withoutConfirmation.status).toBe(428);
    expect(withoutConfirmation.body.error.code).toBe('CONFIRMATION_REQUIRED');

    const reversal = await agent()
      .post(`/api/v1/admin/transfers/${transferId}/reverse`)
      .set('Authorization', bearer(financeSession.accessToken))
      .set('X-Admin-Confirmation', transferId)
      .set('Idempotency-Key', idempotencyKey('reverse'))
      .send({ reason: 'Requested by compliance review' });
    expect(reversal.status).toBe(201);
    expect(reversal.body.data.reversal).toMatchObject({
      type: 'REVERSAL',
      status: 'COMPLETED',
      currency: 'USD',
    });

    const [senderWallet, recipientWallet] = await Promise.all([
      prisma.walletAccount.findUnique({ where: { walletId: sender.wallet.id } }),
      prisma.walletAccount.findUnique({ where: { walletId: recipient.wallet.id } }),
    ]);
    expect(senderWallet?.balanceMinor).toBe(150_000n);
    expect(recipientWallet?.balanceMinor).toBe(0n);

    const original = await prisma.transfer.findUnique({
      where: { id: transferId },
      include: { transaction: true },
    });
    expect(original?.transaction.status).toBe('REVERSED');

    const repeat = await agent()
      .post(`/api/v1/admin/transfers/${transferId}/reverse`)
      .set('Authorization', bearer(financeSession.accessToken))
      .set('X-Admin-Confirmation', transferId)
      .set('Idempotency-Key', idempotencyKey('reverse-again'))
      .send({ reason: 'Second reversal attempt' });
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe('TRANSFER_ALREADY_REVERSED');
  });
});
