import { randomInt } from 'node:crypto';
import { logger } from '../../infrastructure/logging/logger';

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes a function with bounded exponential backoff + jitter.
 * Only retry when `shouldRetry` is true (defaults to transient transaction errors).
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (error: unknown, attempt: number) => void;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const maxDelayMs = options.maxDelayMs ?? 1_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !(options.shouldRetry?.(error) ?? false)) throw error;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = backoff + randomInt(0, Math.max(1, Math.floor(backoff / 2)));
      options.onRetry?.(error, attempt);
      logger.warn({ attempt, delayMs: delay, error: (error as Error).message }, 'Retrying transient operation');
      await sleep(delay);
    }
  }
  throw lastError;
}
