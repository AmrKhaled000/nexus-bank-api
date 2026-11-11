import { defineConfig } from 'vitest/config';

// Fast, database-free unit tests. Integration tests use vitest.integration.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    globals: true,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/openapi/**', 'src/types/**'],
    },
  },
});
