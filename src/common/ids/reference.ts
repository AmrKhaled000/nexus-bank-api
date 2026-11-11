import { randomBytes } from 'node:crypto';

const REFERENCE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function publicReference(prefix: string, date = new Date()): string {
  const year = date.getUTCFullYear().toString();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const random = randomBytes(9);
  let suffix = '';
  for (let i = 0; i < 14; i += 1) {
    suffix += REFERENCE_ALPHABET[random[i % random.length]! % REFERENCE_ALPHABET.length];
  }
  return `${prefix}-${year}${month}${day}-${suffix}`;
}

export function requestId(): string {
  return randomBytes(16).toString('hex');
}
