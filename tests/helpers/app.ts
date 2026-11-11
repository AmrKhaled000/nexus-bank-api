import type { Express } from 'express';
import request from 'supertest';
import { loadConfig, type AppConfig } from '../../src/config/env';
import { createApplication, type Application } from '../../src/app';
import type { AppServices } from '../../src/container';

export interface TestContext {
  application: Application;
  app: Express;
  services: AppServices;
  config: AppConfig;
  /** Fresh Supertest agent bound to this application instance. */
  agent(): ReturnType<typeof request>;
  close(): Promise<void>;
}

/**
 * Boots the full HTTP application against the test database. BullMQ is always disabled in
 * tests; payouts execute inline, mirroring the queue-disabled development configuration.
 */
export function createTestContext(envOverrides: Record<string, string> = {}): TestContext {
  const testConfig = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    ...envOverrides,
    QUEUE_ENABLED: 'false',
  });
  const application = createApplication({ config: testConfig, payoutQueue: null });

  return {
    application,
    app: application.app,
    services: application.services,
    config: testConfig,
    agent() {
      return request(application.app);
    },
    async close() {
      await application.close();
    },
  };
}

/** Bearer authorization header value for an already-authenticated session. */
export function bearer(accessToken: string): string {
  return `Bearer ${accessToken}`;
}
