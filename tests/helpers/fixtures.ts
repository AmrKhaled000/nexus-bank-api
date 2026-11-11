import { randomUUID } from 'node:crypto';
import type { UserRole } from '@prisma/client';
import { hashPassword, hashPin } from '../../src/common/crypto/crypto';
import { config } from '../../src/config/env';
import { prisma } from './db';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { publicReference } from '../../src/common/ids/reference';
import { WalletService } from '../../src/modules/wallets/wallet.service';
import { TokenService } from '../../src/modules/auth/token.service';

export const TEST_PASSWORD = 'N3xus!Test#Passw0rd';
export const TEST_PIN = '246810';

let sequence = 0;
let passwordHashPromise: Promise<string> | null = null;
let pinHashPromise: Promise<string> | null = null;

function cachedPasswordHash(): Promise<string> {
  passwordHashPromise ??= hashPassword(TEST_PASSWORD);
  return passwordHashPromise;
}

function cachedPinHash(): Promise<string> {
  pinHashPromise ??= hashPin(TEST_PIN, config.PIN_PEPPER);
  return pinHashPromise;
}

function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}@nexusbank.test`;
}

export interface TestUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  password: string;
  pin: string;
}

export async function createTestUser(options: { role?: UserRole; name?: string; emailPrefix?: string } = {}): Promise<TestUser> {
  const role = options.role ?? 'CUSTOMER';
  const name = options.name ?? (role === 'CUSTOMER' ? 'Test Customer' : 'Test Staff');
  const email = uniqueEmail(options.emailPrefix ?? role.toLowerCase().replace(/_/g, '-'));
  const [passwordHash, pinHash] = await Promise.all([cachedPasswordHash(), cachedPinHash()]);
  const user = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash,
      pinHash,
      pinSetAt: new Date(),
      role,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  return { id: user.id, email: user.email, name: user.name, role: user.role, password: TEST_PASSWORD, pin: TEST_PIN };
}

export interface TestWallet {
  id: string;
  currencyCode: string;
  ledgerAccountId: string;
}

export async function createTestWallet(
  user: TestUser,
  options: { currencyCode?: string; name?: string; type?: 'PERSONAL' | 'SAVINGS'; isPrimary?: boolean } = {},
): Promise<TestWallet> {
  const service = new WalletService();
  const wallet = await service.create(user.id, {
    name: options.name ?? 'Everyday Wallet',
    currencyCode: options.currencyCode ?? 'USD',
    type: options.type ?? 'PERSONAL',
    isPrimary: options.isPrimary,
  });
  const account = await prisma.walletAccount.findUniqueOrThrow({ where: { walletId: wallet.id } });
  return { id: wallet.id, currencyCode: wallet.currency.code, ledgerAccountId: account.ledgerAccountId };
}

/** Posts a balanced ADJUSTMENT credit directly so tests can fund wallets without an admin round-trip. */
export async function fundWallet(wallet: TestWallet, amountMinor: bigint): Promise<string> {
  if (amountMinor <= 0n) {
    throw new Error('fundWallet requires a positive amount in minor units');
  }
  const ledger = new LedgerService();
  return prisma.$transaction(async (tx) => {
    const system = await ledger.systemAccount(tx, 'ADJUSTMENT_EXPENSE', wallet.currencyCode);
    const reference = publicReference('ADJ');
    const transaction = await tx.financialTransaction.create({
      data: {
        reference,
        type: 'ADJUSTMENT',
        status: 'COMPLETED',
        amountMinor,
        feeMinor: 0n,
        currencyCode: wallet.currencyCode,
        description: 'Integration-test funding adjustment',
        completedAt: new Date(),
      },
    });
    await ledger.post({
      tx,
      currencyCode: wallet.currencyCode,
      description: `Integration-test funding ${reference}`,
      transactionId: transaction.id,
      lines: [
        { ledgerAccountId: system.id, direction: 'DEBIT', amountMinor, description: 'Test funding expense' },
        { ledgerAccountId: wallet.ledgerAccountId, direction: 'CREDIT', amountMinor, description: 'Test wallet credit' },
      ],
    });
    return transaction.reference;
  });
}

export async function createSession(user: TestUser): Promise<{ accessToken: string; sessionId: string }> {
  const tokens = new TokenService(config);
  const expiresAt = new Date(Date.now() + 30 * 86_400_000);
  const session = await prisma.userSession.create({
    data: { userId: user.id, deviceName: 'vitest', expiresAt },
  });
  const access = tokens.signAccessToken({ userId: user.id, role: user.role, sessionId: session.id });
  return { accessToken: access.token, sessionId: session.id };
}

export async function createPayoutMethod(user: TestUser): Promise<{ id: string }> {
  return prisma.paymentMethodReference.create({
    data: {
      userId: user.id,
      type: 'PAYOUT_BANK_ACCOUNT',
      provider: 'SIMULATED',
      providerToken: `simulated:${randomUUID()}`,
      bankName: 'Nexus Test Bank',
      accountLast4: '4242',
      isDefault: true,
    },
    select: { id: true },
  });
}

export function idempotencyKey(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
