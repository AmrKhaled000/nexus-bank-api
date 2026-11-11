import type { UserRole } from '@prisma/client';
import { config } from '../src/config/env';
import { hashPassword, hashPin, sha256 } from '../src/common/crypto/crypto';
import { createServices } from '../src/container';
import { prisma } from '../src/infrastructure/database/prisma';
import { seedReferenceData } from './reference-data';

const DEMO_PIN = '246810';
const DEMO_PASSWORD = config.SEED_PASSWORD;

interface DemoUser {
  email: string;
  name: string;
  role: UserRole;
  openingUsd?: string;
}

const DEMO_USERS: DemoUser[] = [
  { email: 'alice@nexusbank.test', name: 'Alice Morgan', role: 'CUSTOMER', openingUsd: '5000.00' },
  { email: 'bob@nexusbank.test', name: 'Bob Chen', role: 'CUSTOMER', openingUsd: '2000.00' },
  { email: 'finance@nexusbank.test', name: 'Fiona Finance', role: 'FINANCE_ADMIN' },
  { email: 'admin@nexusbank.test', name: 'Sam Superuser', role: 'SUPER_ADMIN' },
];

async function main(): Promise<void> {
  if (config.isProduction) {
    throw new Error('The demo seed must never run in production.');
  }
  if (!DEMO_PASSWORD) {
    throw new Error('SEED_PASSWORD must be set before seeding demo accounts.');
  }

  console.log('Seeding currencies, ledger accounts, limits and fee policies...');
  await seedReferenceData(prisma);

  const services = createServices({ config, payoutQueue: null });
  try {
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    const pinHash = await hashPin(DEMO_PIN, config.PIN_PEPPER);

    // Phase 1: identity records. Wallet provisioning and funding happen in phase 2 so that the
    // funding actor (the super admin) is guaranteed to exist.
    const users = new Map<string, { id: string; role: UserRole }>();
    for (const demo of DEMO_USERS) {
      const user = await prisma.user.upsert({
        where: { email: demo.email },
        create: {
          email: demo.email,
          name: demo.name,
          passwordHash,
          pinHash,
          pinSetAt: new Date(),
          role: demo.role,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
        update: {
          name: demo.name,
          role: demo.role,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          passwordHash,
          pinHash,
          pinSetAt: new Date(),
        },
      });
      users.set(demo.email, { id: user.id, role: user.role });
    }

    const admin = users.get('admin@nexusbank.test');
    if (!admin) throw new Error('Super-admin demo account is missing');
    const fundingActor = { userId: admin.id, role: admin.role };

    for (const demo of DEMO_USERS) {
      // Phase 2: wallets, opening balances and payout methods for the already-created users.
      const user = users.get(demo.email)!;
      const userId = user.id;

      let wallet = await prisma.wallet.findFirst({
        where: { userId, currencyCode: 'USD' },
        include: { currency: true, walletAccount: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!wallet) {
        const created = await services.walletService.create(userId, {
          name: demo.role === 'CUSTOMER' ? 'Everyday USD' : 'Operations USD',
          currencyCode: 'USD',
          type: 'PERSONAL',
          isPrimary: true,
        });
        wallet = await prisma.wallet.findUniqueOrThrow({
          where: { id: created.id },
          include: { currency: true, walletAccount: true },
        });
        console.log(`  Created USD wallet for ${demo.email}`);
      }

      if (demo.email === 'alice@nexusbank.test') {
        const eurWallet = await prisma.wallet.findFirst({
          where: { userId, currencyCode: 'EUR' },
        });
        if (!eurWallet) {
          await services.walletService.create(userId, {
            name: 'Euro Savings',
            currencyCode: 'EUR',
            type: 'SAVINGS',
            isPrimary: false,
          });
          console.log('  Created EUR savings wallet for alice@nexusbank.test');
        }
      }

      if (demo.openingUsd && wallet) {
        const key = `seed-opening-${demo.email.split('@')[0]}-usd-v1`;
        const alreadySeeded = await prisma.idempotencyKey.findUnique({
          where: { userId_scope_key: { userId: fundingActor.userId, scope: 'admin.ledger.adjust', key } },
        });
        if (!alreadySeeded) {
          await services.admin.adjustLedger(
            fundingActor,
            {
              walletId: wallet.id,
              direction: 'CREDIT',
              amount: demo.openingUsd,
              reason: 'Demo opening balance (educational simulation)',
            },
            {
              key,
              requestHash: sha256(`seed:${demo.email}:${demo.openingUsd}`),
            },
          );
          console.log(`  Funded ${demo.email} with ${demo.openingUsd} USD of simulated money`);
        }
      }

      const paymentMethodCount = await prisma.paymentMethodReference.count({
        where: { userId, deletedAt: null },
      });
      if (paymentMethodCount === 0 && demo.role === 'CUSTOMER') {
        await services.paymentMethods.create(user.id, {
          bankName: demo.email.startsWith('alice') ? 'Nexus Test Bank' : 'Sandbox Credit Union',
          accountLast4: demo.email.startsWith('alice') ? '4242' : '9876',
          isDefault: true,
        });
        console.log(`  Created a payout method for ${demo.email}`);
      }
    }

    console.log('');
    console.log('Seed complete. Demo credentials (simulation only):');
    for (const demo of DEMO_USERS) {
      console.log(`  ${demo.role.padEnd(13)} ${demo.email} / ${DEMO_PASSWORD} (PIN ${DEMO_PIN})`);
    }
    console.log(
      'Deposits must be confirmed through POST /api/v1/deposits/:id/simulate or a signed provider webhook.',
    );
  } finally {
    await services.close();
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error('Seed failed:', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
