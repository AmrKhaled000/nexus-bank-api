import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Prisma's generated client auto-loads .env at import time before application modules run.
// In test mode the dedicated .env.test file must win, so it is applied with override semantics.
loadDotenv({
  path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
  quiet: true,
  override: process.env.NODE_ENV === 'test',
});

const booleanFromString = (defaultValue: 'true' | 'false' = 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    API_PREFIX: z.string().startsWith('/').default('/api/v1'),
    APP_BASE_URL: z.string().url().default('http://localhost:3000'),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).optional(),
    QUEUE_ENABLED: booleanFromString('true'),
    RATE_LIMIT_REDIS: booleanFromString('false'),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    JWT_ISSUER: z.string().min(1).default('nexus-bank'),
    JWT_AUDIENCE: z.string().min(1).default('nexus-bank-api'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    REFRESH_COOKIE_NAME: z.string().min(1).default('nexus_rt'),
    COOKIE_SECURE: booleanFromString('false'),
    MAX_ACTIVE_SESSIONS: z.coerce.number().int().min(1).max(100).default(10),

    ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32 bytes hex'),
    PIN_PEPPER: z.string().min(32),
    IP_HASH_SECRET: z.string().min(32),

    PAYMENT_PROVIDER: z.enum(['simulated', 'stripe']).default('simulated'),
    PAYMENT_WEBHOOK_SECRET: z.string().min(32),
    PAYMENT_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    PAYOUT_PROVIDER: z.enum(['simulated']).default('simulated'),
    SIMULATED_PAYOUT_OUTCOME: z.enum(['success', 'failure']).default('success'),

    CORS_ORIGINS: z.string().default(''),
    TRUST_PROXY: z.string().default('false'),
    RATE_LIMIT_ENABLED: booleanFromString('true'),
    MAX_WALLETS_PER_USER: z.coerce.number().int().min(1).max(50).default(10),
    WITHDRAWAL_REVIEW_THRESHOLD_MINOR: z.coerce.number().int().min(0).default(1_000_000),
    SUSPICIOUS_AMOUNT_MINOR: z.coerce.number().int().min(0).default(5_000_000),
    AUTO_APPROVE_WITHDRAWALS: booleanFromString('false'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DOCS_ENABLED: booleanFromString('true'),
    METRICS_ENABLED: booleanFromString('true'),
    METRICS_TOKEN: z.string().optional(),
    OTEL_ENABLED: booleanFromString('false'),
    OTEL_SERVICE_NAME: z.string().default('nexus-bank-api'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    EMAIL_FROM: z.string().default('no-reply@nexusbank.test'),
    DEV_MAIL_DIR: z.string().default('.dev-mail'),

    SEED_PASSWORD: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.PAYMENT_PROVIDER === 'stripe') {
      if (!env.STRIPE_SECRET_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_SECRET_KEY'],
          message: 'STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe',
        });
      }
      if (!env.STRIPE_WEBHOOK_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_WEBHOOK_SECRET'],
          message: 'STRIPE_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=stripe',
        });
      }
    }
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE must be true in production',
      });
    }
    if (env.NODE_ENV === 'production' && !env.CORS_ORIGINS.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must be configured in production',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema> & {
  isProduction: boolean;
  isTest: boolean;
  corsOrigins: string[];
  trustProxy: boolean | number | string;
};

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const env = parsed.data;
  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}

export const config: AppConfig = loadConfig();
