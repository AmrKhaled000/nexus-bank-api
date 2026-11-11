import type { Server } from 'node:http';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  // Telemetry is initialised before the application modules are loaded so auto-instrumentation
  // can hook HTTP and database clients. Dynamic imports preserve that ordering.
  const { config } = await import('./config/env');
  const { initTelemetry } = await import('./infrastructure/observability/telemetry');
  const { logger, safeError } = await import('./infrastructure/logging/logger');

  let telemetryShutdown: (() => Promise<void>) | null = null;
  try {
    telemetryShutdown = await initTelemetry(config);
  } catch (error) {
    logger.warn({ error: safeError(error) }, 'OpenTelemetry initialization failed; continuing without tracing');
  }

  const { prisma } = await import('./infrastructure/database/prisma');
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    logger.fatal(
      { error: safeError(error) },
      'Database is not reachable. Apply migrations and check DATABASE_URL before starting the API.',
    );
    await prisma.$disconnect().catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  const { createApplication } = await import('./app');
  const application = createApplication({ config });
  const { app, services } = application;

  const httpServer: Server = await new Promise((resolve, reject) => {
    const server = app.listen(config.PORT, () => resolve(server));
    server.once('error', reject);
  });

  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  httpServer.requestTimeout = 60_000;

  logger.info(
    {
      port: config.PORT,
      environment: config.NODE_ENV,
      apiPrefix: config.API_PREFIX,
      docsEnabled: config.DOCS_ENABLED,
      paymentProvider: config.PAYMENT_PROVIDER,
      queueEnabled: config.QUEUE_ENABLED,
    },
    'NEXUS BANK API listening',
  );

  // Expire abandoned deposit intents. Safe to run in every API replica: the update is guarded
  // by status and expiry, so concurrent workers cannot double-expire a deposit.
  const maintenanceTimer = setInterval(() => {
    void services.deposits
      .expireStale(100)
      .then((count) => {
        if (count > 0) logger.info({ count }, 'Expired stale deposit intents');
      })
      .catch((error) => {
        logger.error({ error: safeError(error) }, 'Deposit expiry maintenance failed');
      });
  }, 5 * 60_000);
  maintenanceTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing process exit');
      process.exit(exitCode === 0 ? 1 : exitCode);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    clearInterval(maintenanceTimer);
    try {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      await application.close();
      await prisma.$disconnect();
      await telemetryShutdown?.();
      clearTimeout(forceExit);
      logger.info('Shutdown complete');
      process.exit(exitCode);
    } catch (error) {
      logger.error({ error: safeError(error) }, 'Error during shutdown');
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ error: safeError(reason) }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ error: safeError(error) }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}

void main().catch((error) => {
  // The logger may not be available if configuration itself failed to load.
  console.error('Fatal startup error:', error);
  process.exit(1);
});
