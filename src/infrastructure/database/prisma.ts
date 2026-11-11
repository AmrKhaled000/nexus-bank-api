// Load environment before the generated client: @prisma/client auto-loads .env at import
// time, and its values must not outrank the file selected by NODE_ENV.
import { config } from '../../config/env';
import { Prisma, PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { nexusPrisma?: PrismaClient };

export const prisma =
  globalForPrisma.nexusPrisma ??
  new PrismaClient({
    log: config.isProduction ? ['error'] : config.isTest ? [] : ['warn', 'error'],
  });

if (!config.isProduction) {
  globalForPrisma.nexusPrisma = prisma;
}

export type TransactionClient = Prisma.TransactionClient;

export const TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 20_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
} as const;

export function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return ['P2034', 'P2028'].includes(error.code);
  }
  if (error instanceof Error) {
    return /deadlock detected|could not serialize access|40001|40P01/i.test(error.message);
  }
  return false;
}

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function isForeignKeyError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
