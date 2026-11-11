import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, prisma } from '../helpers/db';
import { bearer, createTestContext, type TestContext } from '../helpers/app';
import {
  TEST_PASSWORD,
  TEST_PIN,
  createSession,
  createTestUser,
  createTestWallet,
  fundWallet,
  idempotencyKey,
} from '../helpers/fixtures';

const context: TestContext = createTestContext();
const { agent } = context;

async function staff(role: 'SUPPORT' | 'FINANCE_ADMIN' | 'SUPER_ADMIN', emailPrefix: string) {
  const user = await createTestUser({ role, emailPrefix });
  const session = await createSession(user);
  return { user, token: session.accessToken };
}

describe('administrative operations and role-based access control', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await context.close();
  });

  it('denies administrative access to customers and grants read access to support', async () => {
    const plainCustomer = await createTestUser({ emailPrefix: 'rbac-customer' });
    const plainCustomerSession = await createSession(plainCustomer);
    const support = await staff('SUPPORT', 'rbac-support');
    const finance = await staff('FINANCE_ADMIN', 'rbac-finance');

    for (const [name, token] of [
      ['customer', plainCustomerSession.accessToken],
      ['support', support.token],
      ['finance', finance.token],
    ] as const) {
      const response = await agent().get('/api/v1/admin/users').set('Authorization', bearer(token));
      if (name === 'customer') {
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('ROLE_NOT_ALLOWED');
      } else {
        expect(response.status).toBe(200);
        expect(Array.isArray(response.body.data)).toBe(true);
      }
    }

    const statsDenied = await agent().get('/api/v1/admin/stats').set('Authorization', bearer(plainCustomerSession.accessToken));
    expect(statsDenied.status).toBe(403);

    const statsAllowed = await agent().get('/api/v1/admin/stats').set('Authorization', bearer(finance.token));
    expect(statsAllowed.status).toBe(200);
    expect(statsAllowed.body.data.users.total).toBeGreaterThanOrEqual(3);
  });

  it('requires X-Admin-Confirmation for ledger adjustments and applies them idempotently', async () => {
    const finance = await staff('FINANCE_ADMIN', 'adjust-finance');
    const target = await createTestUser({ emailPrefix: 'adjust-target' });
    const wallet = await createTestWallet(target);

    const adjustment = { walletId: wallet.id, direction: 'CREDIT', amount: '25.00', reason: 'Customer service goodwill credit' };

    const noConfirmation = await agent()
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', bearer(finance.token))
      .set('Idempotency-Key', idempotencyKey('adjust'))
      .send(adjustment);
    expect(noConfirmation.status).toBe(428);
    expect(noConfirmation.body.error.code).toBe('CONFIRMATION_REQUIRED');

    const wrongConfirmation = await agent()
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', bearer(finance.token))
      .set('X-Admin-Confirmation', 'not-the-wallet-id')
      .set('Idempotency-Key', idempotencyKey('adjust'))
      .send(adjustment);
    expect(wrongConfirmation.status).toBe(428);

    const missingKey = await agent()
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', bearer(finance.token))
      .set('X-Admin-Confirmation', wallet.id)
      .send(adjustment);
    expect(missingKey.status).toBe(400);
    expect(missingKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const key = idempotencyKey('adjust-replay');
    const applied = await agent()
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', bearer(finance.token))
      .set('X-Admin-Confirmation', wallet.id)
      .set('Idempotency-Key', key)
      .send(adjustment);
    expect(applied.status).toBe(201);
    expect(applied.body.data.adjustment).toMatchObject({ direction: 'CREDIT', amountMinor: '2500', currency: 'USD' });

    const account = await prisma.walletAccount.findUnique({ where: { walletId: wallet.id } });
    expect(account?.balanceMinor).toBe(2_500n);

    const replay = await agent()
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', bearer(finance.token))
      .set('X-Admin-Confirmation', wallet.id)
      .set('Idempotency-Key', key)
      .send(adjustment);
    expect(replay.status).toBe(201);
    expect(replay.body.meta.idempotentReplay).toBe(true);
    expect(replay.body.data.adjustment.transactionId).toBe(applied.body.data.adjustment.transactionId);

    const replayedAccount = await prisma.walletAccount.findUnique({ where: { walletId: wallet.id } });
    expect(replayedAccount?.balanceMinor).toBe(2_500n);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'LEDGER_ADJUSTMENT', entityId: wallet.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.reason).toBe(adjustment.reason);
  });

  it('rejects ledger adjustments from support staff and excessive debit adjustments', async () => {
    const support = await staff('SUPPORT', 'adjust-support');
    const finance = await staff('FINANCE_ADMIN', 'adjust-finance-debit');
    const target = await createTestUser({ emailPrefix: 'adjust-debit-target' });
    const wallet = await createTestWallet(target);
    await fundWallet(wallet, 1_000n);

    const forbidden = await agent()
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', bearer(support.token))
      .set('X-Admin-Confirmation', wallet.id)
      .set('Idempotency-Key', idempotencyKey('support-adjust'))
      .send({ walletId: wallet.id, direction: 'CREDIT', amount: '5.00', reason: 'Support goodwill credit' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('ROLE_NOT_ALLOWED');

    const tooMuch = await agent()
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', bearer(finance.token))
      .set('X-Admin-Confirmation', wallet.id)
      .set('Idempotency-Key', idempotencyKey('over-debit'))
      .send({ walletId: wallet.id, direction: 'DEBIT', amount: '50.00', reason: 'Clawback attempt beyond balance' });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('runs reconciliation and reports a healthy, balanced ledger', async () => {
    const finance = await staff('FINANCE_ADMIN', 'reconcile-finance');
    const sender = await createTestUser({ emailPrefix: 'reconcile-sender' });
    const senderWallet = await createTestWallet(sender);
    const recipient = await createTestUser({ emailPrefix: 'reconcile-recipient' });
    const recipientWallet = await createTestWallet(recipient);
    await fundWallet(senderWallet, 50_000n);

    await agent()
      .post('/api/v1/transfers')
      .set('Authorization', bearer((await createSession(sender)).accessToken))
      .set('Idempotency-Key', idempotencyKey('reconcile-transfer'))
      .send({ sourceWalletId: senderWallet.id, destinationWalletId: recipientWallet.id, amount: '12.50', pin: TEST_PIN });

    const reconciliation = await agent()
      .post('/api/v1/admin/reconciliation/run')
      .set('Authorization', bearer(finance.token));
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body.data.healthy).toBe(true);
    expect(reconciliation.body.data.issues).toEqual([]);
    expect(reconciliation.body.data.trialBalance.balanced).toBe(true);

    const trialBalance = await agent()
      .get('/api/v1/admin/ledger/trial-balance')
      .set('Authorization', bearer(finance.token));
    expect(trialBalance.status).toBe(200);
    expect(trialBalance.body.data.balanced).toBe(true);
    expect(trialBalance.body.data.currencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ currency: 'USD', balanced: true })]),
    );

    const journal = await agent()
      .get('/api/v1/admin/ledger/journal-entries')
      .set('Authorization', bearer(finance.token));
    expect(journal.status).toBe(200);
    expect(journal.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('enforces immutable ledger and audit records at the database level', async () => {
    const finance = await staff('FINANCE_ADMIN', 'immutable-finance');
    const target = await createTestUser({ emailPrefix: 'immutable-target' });
    const wallet = await createTestWallet(target);
    await fundWallet(wallet, 5_000n);

    await agent()
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', bearer(finance.token))
      .set('X-Admin-Confirmation', wallet.id)
      .set('Idempotency-Key', idempotencyKey('immutable-adjust'))
      .send({ walletId: wallet.id, direction: 'CREDIT', amount: '1.00', reason: 'Immutability probe adjustment' });

    const attempts: Array<() => Promise<unknown>> = [
      () => prisma.$executeRawUnsafe(`UPDATE "journal_entries" SET "description" = 'tampered'`),
      () => prisma.$executeRawUnsafe(`DELETE FROM "journal_entry_lines"`),
      () => prisma.$executeRawUnsafe(`UPDATE "journal_entry_lines" SET "debitMinor" = "debitMinor" + 1`),
      () => prisma.$executeRawUnsafe(`UPDATE "audit_logs" SET "action" = 'tampered'`),
      () => prisma.$executeRawUnsafe(`DELETE FROM "audit_logs"`),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow(/NEXUS_IMMUTABLE_RECORD/);
    }

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "wallet_accounts" SET "balanceMinor" = "balanceMinor" + 1`),
    ).rejects.toThrow(/NEXUS_(BALANCE_DRIFT|HOLD_DRIFT|INSUFFICIENT_FUNDS)/);
  });

  it('changes roles and suspends accounts only with super-admin rights and confirmation', async () => {
    const superAdmin = await staff('SUPER_ADMIN', 'role-super');
    const finance = await staff('FINANCE_ADMIN', 'role-finance');
    const target = await createTestUser({ emailPrefix: 'role-target' });
    const targetSession = await createSession(target);

    const forbidden = await agent()
      .patch(`/api/v1/admin/users/${target.id}/role`)
      .set('Authorization', bearer(finance.token))
      .set('X-Admin-Confirmation', target.id)
      .send({ role: 'SUPPORT', reason: 'Finance attempts role promotion' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('ROLE_NOT_ALLOWED');

    const missingConfirmation = await agent()
      .patch(`/api/v1/admin/users/${target.id}/role`)
      .set('Authorization', bearer(superAdmin.token))
      .send({ role: 'SUPPORT', reason: 'Promoting for support rotation' });
    expect(missingConfirmation.status).toBe(428);

    const promoted = await agent()
      .patch(`/api/v1/admin/users/${target.id}/role`)
      .set('Authorization', bearer(superAdmin.token))
      .set('X-Admin-Confirmation', target.id)
      .send({ role: 'SUPPORT', reason: 'Promoting for support rotation' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.data.role).toBe('SUPPORT');

    const revokeToken = await agent()
      .get('/api/v1/auth/sessions')
      .set('Authorization', bearer(targetSession.accessToken));
    expect(revokeToken.status).toBe(401);

    const loginBlocked = await agent()
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: TEST_PASSWORD });
    expect(loginBlocked.status).toBe(200); // re-login is permitted until status is suspended

    const suspended = await agent()
      .patch(`/api/v1/admin/users/${target.id}/status`)
      .set('Authorization', bearer(superAdmin.token))
      .set('X-Admin-Confirmation', target.id)
      .send({ status: 'SUSPENDED', reason: 'Fraud investigation case 42' });
    expect(suspended.status).toBe(200);
    expect(suspended.body.data.status).toBe('SUSPENDED');

    const suspendedLogin = await agent()
      .post('/api/v1/auth/login')
      .send({ email: target.email, password: TEST_PASSWORD });
    expect(suspendedLogin.status).toBe(403);
    expect(suspendedLogin.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('lists security events and audit logs for staff readers', async () => {
    const support = await staff('SUPPORT', 'audit-support');
    const target = await createTestUser({ emailPrefix: 'audit-target' });
    const wallet = await createTestWallet(target);
    await fundWallet(wallet, 1_000n);

    const finance = await staff('FINANCE_ADMIN', 'audit-finance');
    await agent()
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', bearer(finance.token))
      .set('X-Admin-Confirmation', wallet.id)
      .set('Idempotency-Key', idempotencyKey('audit-adjust'))
      .send({ walletId: wallet.id, direction: 'CREDIT', amount: '3.00', reason: 'Audit trail verification entry' });

    const logs = await agent()
      .get('/api/v1/admin/audit-logs?action=LEDGER_ADJUSTMENT')
      .set('Authorization', bearer(support.token));
    expect(logs.status).toBe(200);
    expect(logs.body.data.length).toBeGreaterThanOrEqual(1);
    expect(logs.body.data[0].action).toBe('LEDGER_ADJUSTMENT');

    const stats = await agent().get('/api/v1/admin/stats').set('Authorization', bearer(support.token));
    expect(stats.status).toBe(200);
  });
});
