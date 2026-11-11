import { Worker, type Job } from 'bullmq';
import { config } from '../config/env';
import { createServices } from '../container';
import { prisma } from '../infrastructure/database/prisma';
import { logger, safeError } from '../infrastructure/logging/logger';
import { PAYOUT_QUEUE_NAME, redisConnectionOptions } from '../infrastructure/queue/queues';

interface PayoutJobData {
  withdrawalId: string;
}

async function main(): Promise<void> {
  if (!config.QUEUE_ENABLED || !config.REDIS_URL) {
    logger.fatal(
      'The worker requires QUEUE_ENABLED=true and REDIS_URL. Set both, or run the API with inline payout processing.',
    );
    process.exitCode = 1;
    return;
  }

  const services = createServices({ config, payoutQueue: null });
  const connection = redisConnectionOptions(config.REDIS_URL);

  // Workers own their own connection because blocking commands (BRPOPLPUSH) cannot share a
  // connection with regular commands.
  const payoutWorker = new Worker<PayoutJobData>(
    PAYOUT_QUEUE_NAME,
    async (job: Job<PayoutJobData>) => {
      const { withdrawalId } = job.data;
      if (typeof withdrawalId !== 'string' || withdrawalId.length === 0) {
        throw new Error('Payout job is missing withdrawalId');
      }
      logger.info({ jobId: job.id, withdrawalId, attempt: job.attemptsMade + 1 }, 'Processing payout job');
      const result = await services.withdrawals.processPayout(withdrawalId);
      return { withdrawalId, status: result.status };
    },
    {
      connection,
      concurrency: 2,
      lockDuration: 30_000,
    },
  );

  payoutWorker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, result }, 'Payout job completed');
  });
  payoutWorker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, withdrawalId: job?.data.withdrawalId, error: safeError(error) },
      'Payout job failed',
    );
  });
  payoutWorker.on('error', (error) => {
    logger.error({ error: safeError(error) }, 'Payout worker error');
  });

  // Maintenance runs inside the worker process. The expiry query is guarded by status and
  // expiry timestamps, so multiple replicas cannot corrupt state by racing.
  const runMaintenance = async (): Promise<void> => {
    try {
      const expired = await services.deposits.expireStale(100);
      if (expired > 0) logger.info({ expired }, 'Expired stale deposits');
    } catch (error) {
      logger.error({ error: safeError(error) }, 'Maintenance run failed');
    }
  };
  await runMaintenance();
  const maintenanceTimer = setInterval(() => void runMaintenance(), 5 * 60_000);
  maintenanceTimer.unref();

  logger.info(
    { environment: config.NODE_ENV, queues: [PAYOUT_QUEUE_NAME], concurrency: 2 },
    'NEXUS BANK worker started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Worker shutting down');
    clearInterval(maintenanceTimer);

    const forceExit = setTimeout(() => {
      logger.error('Worker shutdown timed out; forcing process exit');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    try {
      await payoutWorker.close();
      await services.close();
      await prisma.$disconnect();
      clearTimeout(forceExit);
      logger.info('Worker shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ error: safeError(error) }, 'Worker shutdown failed');
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((error) => {
  console.error('Fatal worker startup error:', error);
  process.exit(1);
});
