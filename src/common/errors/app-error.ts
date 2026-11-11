export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_JSON: 'INVALID_JSON',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',

  EMAIL_ALREADY_EXISTS: 'EMAIL_ALREADY_EXISTS',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_FROZEN: 'ACCOUNT_FROZEN',
  ACCOUNT_CLOSED: 'ACCOUNT_CLOSED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  REFRESH_TOKEN_REUSE: 'REFRESH_TOKEN_REUSE',
  TWO_FACTOR_REQUIRED: 'TWO_FACTOR_REQUIRED',
  INVALID_TWO_FACTOR_CODE: 'INVALID_TWO_FACTOR_CODE',
  TWO_FACTOR_ALREADY_ENABLED: 'TWO_FACTOR_ALREADY_ENABLED',
  PIN_REQUIRED: 'PIN_REQUIRED',
  INVALID_PIN: 'INVALID_PIN',
  PIN_LOCKED: 'PIN_LOCKED',
  PASSWORD_REUSE: 'PASSWORD_REUSE',

  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  WALLET_NOT_ACTIVE: 'WALLET_NOT_ACTIVE',
  WALLET_LIMIT_REACHED: 'WALLET_LIMIT_REACHED',
  WALLET_NOT_EMPTY: 'WALLET_NOT_EMPTY',
  CURRENCY_NOT_SUPPORTED: 'CURRENCY_NOT_SUPPORTED',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  RECIPIENT_WALLET_NOT_FOUND: 'RECIPIENT_WALLET_NOT_FOUND',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  TRANSFER_NOT_FOUND: 'TRANSFER_NOT_FOUND',
  TRANSFER_ALREADY_REVERSED: 'TRANSFER_ALREADY_REVERSED',
  DEPOSIT_NOT_FOUND: 'DEPOSIT_NOT_FOUND',
  DEPOSIT_EXPIRED: 'DEPOSIT_EXPIRED',
  WITHDRAWAL_NOT_FOUND: 'WITHDRAWAL_NOT_FOUND',
  PAYMENT_METHOD_NOT_FOUND: 'PAYMENT_METHOD_NOT_FOUND',
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  WEBHOOK_REPLAY: 'WEBHOOK_REPLAY',
  PAYOUT_FAILED: 'PAYOUT_FAILED',
  PAYOUT_NOT_ELIGIBLE: 'PAYOUT_NOT_ELIGIBLE',

  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_INVALID: 'IDEMPOTENCY_KEY_INVALID',
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',

  LEDGER_IMBALANCE: 'LEDGER_IMBALANCE',
  LEDGER_IMMUTABLE: 'LEDGER_IMMUTABLE',
  RECONCILIATION_MISMATCH: 'RECONCILIATION_MISMATCH',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  ROLE_NOT_ALLOWED: 'ROLE_NOT_ALLOWED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

interface AppErrorOptions {
  details?: unknown;
  cause?: unknown;
  expose?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(code: ErrorCode, message: string, statusCode = 400, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
    this.expose = options.expose ?? statusCode < 500;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  static badRequest(code: ErrorCode, message: string, details?: unknown): AppError {
    return new AppError(code, message, 400, { details });
  }

  static unauthorized(code: ErrorCode = ErrorCode.UNAUTHORIZED, message = 'Authentication required'): AppError {
    return new AppError(code, message, 401);
  }

  static forbidden(code: ErrorCode = ErrorCode.FORBIDDEN, message = 'Insufficient permissions'): AppError {
    return new AppError(code, message, 403);
  }

  static notFound(code: ErrorCode, message: string): AppError {
    return new AppError(code, message, 404);
  }

  static conflict(code: ErrorCode, message: string, details?: unknown): AppError {
    return new AppError(code, message, 409, { details });
  }

  static unprocessable(code: ErrorCode, message: string, details?: unknown): AppError {
    return new AppError(code, message, 422, { details });
  }

  static tooManyRequests(message = 'Too many requests'): AppError {
    return new AppError(ErrorCode.TOO_MANY_REQUESTS, message, 429);
  }

  static internal(message = 'An unexpected error occurred'): AppError {
    return new AppError(ErrorCode.INTERNAL_ERROR, message, 500, { expose: false });
  }
}

export class DomainError extends AppError {}
