import { defineConfig } from 'vitest/config';

// Integration tests share one PostgreSQL database, so they run sequentially in a single fork.
// Each test calls resetDatabase(), which truncates every application table and re-seeds
// currencies, system ledger accounts, limits and fee policies.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globals: true,
    globalSetup: ['./tests/helpers/global-setup.ts'],
    setupFiles: ['./tests/helpers/setup.ts'],
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
