import express, { type Express, type Request, type RequestHandler, Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { AppError, ErrorCode } from './common/errors/app-error';
import { asyncHandler } from './common/http/async-handler';
import { sendSuccess } from './common/http/http';
import type { AppConfig } from './config/env';
import { createServices, type AppServices, type CreateServicesOptions } from './container';
import { logger } from './infrastructure/logging/logger';
import { metricsHandler, httpMetricsMiddleware } from './infrastructure/observability/metrics';
import { HealthService } from './infrastructure/observability/health.service';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestContext, requestLogger } from './middleware/request-context';
import { createRateLimiters, type RateLimiters } from './middleware/rate-limit';
import { openapiDocument } from './openapi/document';
import { createAuthRouter } from './modules/auth/auth.routes';
import { AuthController } from './modules/auth/auth.controller';
import { createUserRouter } from './modules/users/user.routes';
import { createWalletRouter } from './modules/wallets/wallet.routes';
import { WalletController } from './modules/wallets/wallet.controller';
import { createTransferRouter } from './modules/transfers/transfer.routes';
import { TransferController } from './modules/transfers/transfer.controller';
import { createTransactionRouter } from './modules/transactions/transaction.routes';
import { TransactionController } from './modules/transactions/transaction.controller';
import { createDepositRouter } from './modules/deposits/deposit.routes';
import { DepositController } from './modules/deposits/deposit.controller';
import { createWithdrawalRouter } from './modules/withdrawals/withdrawal.routes';
import { WithdrawalController } from './modules/withdrawals/withdrawal.controller';
import { createPaymentMethodRouter } from './modules/payment-methods/payment-method.routes';
import { PaymentMethodController } from './modules/payment-methods/payment-method.controller';
import { createNotificationRouter } from './modules/notifications/notification.routes';
import { NotificationController } from './modules/notifications/notification.controller';
import { createAdminRouter } from './modules/admin/admin.routes';
import { AdminController } from './modules/admin/admin.controller';
import { createWebhookRouter } from './modules/webhooks/webhook.routes';

export interface CreateApplicationOptions extends CreateServicesOptions {
  services?: AppServices;
  rateLimiters?: RateLimiters;
}

export interface Application {
  app: Express;
  services: AppServices;
  close(): Promise<void>;
}

function corsMiddleware(config: AppConfig): RequestHandler {
  const allowed = new Set(config.corsOrigins);
  return cors({
    credentials: true,
    origin(origin, callback) {
      // Same-origin and non-browser clients do not send an Origin header.
      if (!origin || allowed.has(origin)) {
        callback(null, true);
        return;
      }
      callback(
        new AppError(ErrorCode.FORBIDDEN, 'Origin is not allowed by the CORS policy', 403, {
          expose: true,
        }),
      );
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Admin-Confirmation',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });
}

function docsSecurity(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }) as RequestHandler;
}

function buildApiRouter(services: AppServices, limiters: RateLimiters): Router {
  const api = Router();
  const { config } = services;

  const authController = new AuthController(config, services.auth);
  const walletController = new WalletController(
    services.walletService,
    services.statements,
    services.transactionService,
  );
  const adminController = new AdminController(services.admin, services.withdrawals, services.transfers);

  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  api.use(limiters.global);

  api.get('/', (_req, res) => {
    sendSuccess(res, {
      service: 'nexus-bank-api',
      version: '1.0.0',
      documentation: config.DOCS_ENABLED ? '/docs' : null,
      simulation: true,
    });
  });

  api.use(
    '/auth',
    createAuthRouter({ config, controller: authController, tokens: services.tokens, limiters }),
  );
  api.use('/users', createUserRouter({ tokens: services.tokens, service: services.users }));
  api.use('/wallets', createWalletRouter({ tokens: services.tokens, controller: walletController }));
  api.use(
    '/transfers',
    createTransferRouter({
      tokens: services.tokens,
      controller: new TransferController(services.transfers),
      limiters,
    }),
  );
  api.use(
    '/transactions',
    createTransactionRouter({
      tokens: services.tokens,
      controller: new TransactionController(services.transactionService),
    }),
  );
  api.use(
    '/deposits',
    createDepositRouter({
      tokens: services.tokens,
      controller: new DepositController(services.deposits, services.webhooks),
      limiters,
    }),
  );
  api.use(
    '/withdrawals',
    createWithdrawalRouter({
      tokens: services.tokens,
      controller: new WithdrawalController(services.withdrawals),
      limiters,
    }),
  );
  api.use(
    '/payment-methods',
    createPaymentMethodRouter({
      tokens: services.tokens,
      controller: new PaymentMethodController(services.paymentMethods),
    }),
  );
  api.use(
    '/notifications',
    createNotificationRouter({
      tokens: services.tokens,
      controller: new NotificationController(services.notifications),
    }),
  );
  api.use(
    '/admin',
    createAdminRouter({ tokens: services.tokens, controller: adminController, limiters }),
  );
  api.use('/webhooks', createWebhookRouter({ service: services.webhooks }));

  return api;
}

/**
 * Builds the complete HTTP application. Kept free of `listen()` and process-signal handling so
 * integration tests can drive it in-process with Supertest.
 */
export function createApplication(options: CreateApplicationOptions = {}): Application {
  const services = options.services ?? createServices(options);
  const config = services.config;
  const limiters = options.rateLimiters ?? createRateLimiters(config);
  const health = new HealthService(config);

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', config.trustProxy);
  app.set('json escape', true);

  app.use(requestLogger());
  app.use(requestContext());
  app.use(httpMetricsMiddleware());
  app.use(helmet());
  app.use(corsMiddleware(config));

  app.get(['/health', '/health/live'], (_req, res) => {
    res.json(health.liveness());
  });
  app.get(
    '/health/ready',
    asyncHandler(async (_req, res) => {
      const result = await health.readiness();
      res.status(result.ready ? 200 : 503).json(result);
    }),
  );
  app.get('/metrics', metricsHandler(config));

  // The JSON parser records the exact raw bytes for webhook routes. Signatures must be verified
  // over the original payload, never over a re-serialized object.
  app.use(
    express.json({
      limit: '1mb',
      type: ['application/json', 'application/*+json'],
      verify: (incoming, _res, buffer) => {
        const req = incoming as Request;
        const path = req.originalUrl.split('?')[0] ?? '';
        if (path.startsWith(`${config.API_PREFIX}/webhooks/`)) {
          req.rawBody = Buffer.from(buffer);
        }
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  if (config.DOCS_ENABLED) {
    app.use('/docs', docsSecurity(), swaggerUi.serve, swaggerUi.setup(openapiDocument));
    app.get('/openapi.json', (_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(openapiDocument);
    });
  }

  app.get('/', (_req, res) => {
    res.json({
      name: 'NEXUS BANK API',
      description: 'Educational digital banking and wallet management simulation. Not a real bank.',
      api: config.API_PREFIX,
      health: '/health',
      documentation: config.DOCS_ENABLED ? '/docs' : null,
    });
  });

  app.use(config.API_PREFIX, buildApiRouter(services, limiters));

  app.use(notFoundHandler());
  app.use(errorHandler());

  let closed = false;
  return {
    app,
    services,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await services.close();
    },
  };
}

export { logger };
