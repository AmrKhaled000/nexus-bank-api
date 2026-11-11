import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

/**
 * Vitest global setup. Applies pending Prisma migrations to the dedicated test database
 * before any suite runs. This file executes in its own process, so it loads `.env.test`
 * explicitly instead of relying on `NODE_ENV`-aware application config.
 */
export default function setup(): void {
  loadDotenv({ path: resolve(process.cwd(), '.env.test'), quiet: true });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.test first.');
  }
  if (!/nexus_bank_test/i.test(databaseUrl)) {
    throw new Error(
      `Refusing to run integration tests: DATABASE_URL must target the nexus_bank_test database (received ${databaseUrl}).`,
    );
  }

  execSync('npx prisma migrate deploy', {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}
