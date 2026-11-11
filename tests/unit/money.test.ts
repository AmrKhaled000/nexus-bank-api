import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/app-error';
import {
  MAX_AMOUNT_MINOR,
  assertPositiveMinor,
  calculateFee,
  formatMinor,
  minorUnitsForDisplay,
  parseAmountToMinor,
  sumMinor,
} from '../../src/common/money/money';

describe('parseAmountToMinor', () => {
  it('parses whole and fractional amounts into minor units', () => {
    expect(parseAmountToMinor('10.00', 2)).toBe(1000n);
    expect(parseAmountToMinor('0.01', 2)).toBe(1n);
    expect(parseAmountToMinor('1.5', 2)).toBe(150n);
    expect(parseAmountToMinor('123.45', 2)).toBe(12345n);
    expect(parseAmountToMinor('7', 2)).toBe(700n);
    expect(parseAmountToMinor('1.234567', 6)).toBe(1234567n);
    expect(parseAmountToMinor('25', 0)).toBe(25n);
  });

  it('handles leading zeros and pads short fractions correctly', () => {
    expect(parseAmountToMinor('00.50', 2)).toBe(50n);
    expect(parseAmountToMinor('1.10', 2)).toBe(110n);
    expect(parseAmountToMinor('0.1', 2)).toBe(10n);
  });

  it('rejects zero and negative amounts', () => {
    expect(() => parseAmountToMinor('0', 2)).toThrow(AppError);
    expect(() => parseAmountToMinor('0.00', 2)).toThrow(AppError);
    expect(() => parseAmountToMinor('-5.00', 2)).toThrow(AppError);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'abc', '1,000.00', '1..00', 'NaN', 'Infinity', '1e3', '99999999999999999999.00']) {
      expect(() => parseAmountToMinor(bad, 2)).toThrow(AppError);
    }
  });

  it('rejects more fractional digits than the currency exponent allows', () => {
    expect(() => parseAmountToMinor('1.234', 2)).toThrow(/at most 2 decimal places/);
    expect(() => parseAmountToMinor('1.0000000', 6)).toThrow(AppError);
  });

  it('rejects exponents outside the supported range', () => {
    expect(() => parseAmountToMinor('1', 7)).toThrow(/Invalid currency exponent/);
    expect(() => parseAmountToMinor('1', -1)).toThrow(/Invalid currency exponent/);
    expect(() => parseAmountToMinor('1', 1.5)).toThrow(/Invalid currency exponent/);
  });

  it('rejects amounts above the safe maximum', () => {
    expect(() => parseAmountToMinor('90000000000000.01', 2)).toThrow(/supported maximum/);
  });
});

describe('formatMinor', () => {
  it('formats minor units with the requested exponent', () => {
    expect(formatMinor(12345n, 2)).toBe('123.45');
    expect(formatMinor(1n, 2)).toBe('0.01');
    expect(formatMinor(100n, 2)).toBe('1.00');
    expect(formatMinor(1234567n, 6)).toBe('1.234567');
    expect(formatMinor(42n, 0)).toBe('42');
  });

  it('formats negative values', () => {
    expect(formatMinor(-50n, 2)).toBe('-0.50');
    expect(formatMinor(-12345n, 2)).toBe('-123.45');
  });
});

describe('assertPositiveMinor', () => {
  it('accepts positive amounts and rejects zero / oversized values', () => {
    expect(() => assertPositiveMinor(1n)).not.toThrow();
    expect(() => assertPositiveMinor(0n)).toThrow(AppError);
    expect(() => assertPositiveMinor(-1n)).toThrow(AppError);
    expect(() => assertPositiveMinor(MAX_AMOUNT_MINOR + 1n)).toThrow(/supported maximum/);
  });
});

describe('calculateFee', () => {
  it('returns a fixed flat fee when no percentage is configured', () => {
    const fee = calculateFee(10_000n, { flatMinor: 50n, percentBps: 0, minFeeMinor: 0n, maxFeeMinor: null });
    expect(fee.feeMinor).toBe(50n);
  });

  it('rounds percentage fees up to the next minor unit', () => {
    const fee = calculateFee(1n, { flatMinor: 0n, percentBps: 100, minFeeMinor: 0n, maxFeeMinor: null });
    expect(fee.percentageMinor).toBe(1n);

    const even = calculateFee(10_000n, { flatMinor: 0n, percentBps: 100, minFeeMinor: 0n, maxFeeMinor: null });
    expect(even.percentageMinor).toBe(100n);
  });

  it('enforces minimum and maximum fee boundaries', () => {
    const min = calculateFee(1_000n, { flatMinor: 0n, percentBps: 50, minFeeMinor: 100n, maxFeeMinor: null });
    expect(min.feeMinor).toBe(100n);

    const max = calculateFee(1_000_000n, { flatMinor: 25n, percentBps: 100, minFeeMinor: 0n, maxFeeMinor: 75n });
    expect(max.feeMinor).toBe(75n);
  });

  it('handles a zero-fee policy', () => {
    const fee = calculateFee(50_000n, { flatMinor: 0n, percentBps: 0, minFeeMinor: 0n, maxFeeMinor: 0n });
    expect(fee.feeMinor).toBe(0n);
  });

  it('rejects invalid amounts and basis points', () => {
    expect(() => calculateFee(0n, { flatMinor: 0n, percentBps: 0, minFeeMinor: 0n, maxFeeMinor: null })).toThrow(AppError);
    expect(() =>
      calculateFee(100n, { flatMinor: 0n, percentBps: 10_001, minFeeMinor: 0n, maxFeeMinor: null }),
    ).toThrow(/basis points/i);
    expect(() =>
      calculateFee(100n, { flatMinor: 0n, percentBps: -1, minFeeMinor: 0n, maxFeeMinor: null }),
    ).toThrow(/basis points/i);
  });
});

describe('sumMinor', () => {
  it('sums minor units exactly', () => {
    expect(sumMinor([1n, 2n, 3n])).toBe(6n);
    expect(sumMinor([])).toBe(0n);
  });
});

describe('minorUnitsForDisplay', () => {
  it('renders the bigint as a decimal string', () => {
    expect(minorUnitsForDisplay(12345n)).toBe('12345');
  });
});
