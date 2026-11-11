import { config } from '../../src/config/env';
import { prisma } from '../../src/infrastructure/database/prisma';
import { seedReferenceData } from '../../prisma/reference-data';

if (config.isTest && !/nexus_bank_test/i.test(config.DATABASE_URL)) {
  throw new Error(
    `Refusing to reset the database: NODE_ENV=test but DATABASE_URL targets ${config.DATABASE_URL}. ` +
      'Point DATABASE_URL at nexus_bank_test (.env.test) before running integration tests.',
  );
}

let cachedTableList: string | null = null;

/**
 * Resets the shared integration-test database. Row-level triggers forbid deleting ledger and
 * audit rows, so a TRUNCATE of every application table is the only reliable isolation boundary.
 * `_prisma_migrations` is preserved so `migrate deploy` remains idempotent.
 */
export async function resetDatabase(): Promise<void> {
  if (!cachedTableList) {
    const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      ORDER BY tablename
    `;
    cachedTableList = rows
      .map((row) => `"${row.tablename.replace(/"/g, '""')}"`)
      .join(', ');
  }

  if (cachedTableList) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${cachedTableList} RESTART IDENTITY CASCADE`);
  }

  await seedReferenceData(prisma);
}

export { prisma };
