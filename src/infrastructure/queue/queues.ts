import { Queue } from 'bullmq';
import type { AppConfig } from '../../config/env';
import { logger } from '../logging/logger';

export const PAYOUT_QUEUE_NAME = 'nexus-payouts';
export const MAINTENANCE_QUEUE_NAME = 'nexus-maintenance';

export interface PayoutQueue {
  enqueuePayout(withdrawalId: string): Promise<boolean>;
  close(): Promise<void>;
}

export function redisConnectionOptions(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

const connectionFor = redisConnectionOptions;

/**
 * BullMQ is optional. When Redis or queueing is disabled the API processes payouts inline,
 * which keeps development and test environments dependency-free. Enqueue failures also fall
 * back to inline processing so a Redis outage does not strand an approved withdrawal.
 */
export function createPayoutQueue(config: AppConfig): PayoutQueue | null {
  if (!config.QUEUE_ENABLED || !config.REDIS_URL) return null;
  const queue = new Queue(PAYOUT_QUEUE_NAME, {
    connection: connectionFor(config.REDIS_URL),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 1_000,
    },
  });

  return {
    async enqueuePayout(withdrawalId: string): Promise<boolean> {
      try {
        await queue.add(
          'process-payout',
          { withdrawalId },
          { jobId: `payout-${withdrawalId}` },
        );
        return true;
      } catch (error) {
        logger.error(
          { withdrawalId, error: error instanceof Error ? error.message : 'unknown' },
          'Failed to enqueue payout; falling back to inline processing',
        );
        return false;
      }
    },
    async close(): Promise<void> {
      await queue.close();
    },
  };
}

export function createMaintenanceQueue(config: AppConfig): Queue | null {
  if (!config.QUEUE_ENABLED || !config.REDIS_URL) return null;
  return new Queue(MAINTENANCE_QUEUE_NAME, {
    connection: connectionFor(config.REDIS_URL),
    defaultJobOptions: {
      attempts: 2,
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  });
}
