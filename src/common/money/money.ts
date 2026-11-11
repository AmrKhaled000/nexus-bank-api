import { AppError, ErrorCode } from '../errors/app-error';

/**
 * All monetary values are integer minor units (piastres/cents) represented as bigint.
 * This module is intentionally the only place that converts between major and minor units.
 */

export const MINOR_UNITS_PER_UNIT = 100n;

/** Guard rail below PostgreSQL BIGINT max (9.22e18) and JavaScript safe integer range. */
export const MAX_AMOUNT_MINOR = 9_000_000_000_000_000n;

/** Maximum accepted decimal places in an API amount. Currency exponent validates the rest. */
const DECIMAL_AMOUNT_PATTERN = /^\d{1,15}(?:\.\d{1,6})?$/;

export function parseAmountToMinor(input: string, exponent = 2): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, 'Invalid currency exponent', 500, { expose: false });
  }
  const normalized = input.trim();
  if (!DECIMAL_AMOUNT_PATTERN.test(normalized)) {
    throw AppError.badRequest(ErrorCode.INVALID_AMOUNT, 'Amount must be a positive decimal string');
  }
  const [wholePart, fractionalPart = ''] = normalized.split('.');
  if (fractionalPart.length > exponent) {
    throw AppError.badRequest(
      ErrorCode.INVALID_AMOUNT,
      `Amount supports at most ${exponent} decimal places for this currency`,
    );
  }
  const padded = fractionalPart.padEnd(exponent, '0');
  const minor = BigInt(`${wholePart}${padded}`);
  if (minor <= 0n) {
    throw AppError.badRequest(ErrorCode.INVALID_AMOUNT, 'Amount must be greater than zero');
  }
  if (minor > MAX_AMOUNT_MINOR) {
    throw AppError.unprocessable(ErrorCode.INVALID_AMOUNT, 'Amount exceeds the supported maximum');
  }
  return minor;
}

export function formatMinor(minor: bigint, exponent = 2): string {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new Error('Invalid currency exponent');
  }
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  if (exponent === 0) return `${negative ? '-' : ''}${absolute.toString()}`;
  const divisor = 10n ** BigInt(exponent);
  const whole = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(exponent, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

export function minorUnitsForDisplay(minor: bigint): string {
  return minor.toString();
}

export function assertPositiveMinor(amount: bigint): void {
  if (amount <= 0n) {
    throw AppError.badRequest(ErrorCode.INVALID_AMOUNT, 'Amount must be greater than zero');
  }
  if (amount > MAX_AMOUNT_MINOR) {
    throw AppError.unprocessable(ErrorCode.INVALID_AMOUNT, 'Amount exceeds the supported maximum');
  }
}

export interface FeeCalculation {
  flatMinor: bigint;
  percentBps: number;
  minFeeMinor: bigint;
  maxFeeMinor: bigint | null;
}

export interface FeeResult {
  feeMinor: bigint;
  percentageMinor: bigint;
}

/**
 * Computes a fee without floating point. Percentage fees round up to the next minor unit,
 * which prevents systematic undercharging. A zero-fee policy always yields zero.
 */
export function calculateFee(amountMinor: bigint, policy: FeeCalculation): FeeResult {
  assertPositiveMinor(amountMinor);
  if (policy.percentBps < 0 || policy.percentBps > 10_000) {
    throw new Error('Fee percentage must be between 0 and 10000 basis points');
  }
  let percentageMinor = 0n;
  if (policy.percentBps > 0) {
    const bps = BigInt(policy.percentBps);
    percentageMinor = (amountMinor * bps + 9_999n) / 10_000n;
  }
  let fee = policy.flatMinor + percentageMinor;
  if (fee < policy.minFeeMinor) fee = policy.minFeeMinor;
  if (policy.maxFeeMinor !== null && fee > policy.maxFeeMinor) fee = policy.maxFeeMinor;
  return { feeMinor: fee, percentageMinor };
}

export function sumMinor(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}
