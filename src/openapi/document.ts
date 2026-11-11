/**
 * Hand-authored OpenAPI 3.1 document. It intentionally stays dependency-free so the exported
 * contract is reviewable in source control and can be linted/generated without a build step.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const meta = {
  type: 'object',
  description: 'Optional response metadata. Pagination metadata is present on list endpoints.',
  properties: {
    page: { type: 'integer', example: 1 },
    pageSize: { type: 'integer', example: 20 },
    total: { type: 'integer', example: 42 },
    totalPages: { type: 'integer', example: 3 },
    hasNextPage: { type: 'boolean' },
    hasPreviousPage: { type: 'boolean' },
    idempotentReplay: { type: 'boolean', description: 'True when a stored idempotent response was replayed.' },
    unread: { type: 'integer', description: 'Unread notification count (notifications list only).' },
  },
  additionalProperties: true,
};

function ok(schema: any, description = 'Successful response') {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['success', 'data'],
          properties: {
            success: { type: 'boolean', enum: [true] },
            data: schema,
            meta,
          },
        },
      },
    },
  };
}

function okList(schema: any, description = 'Paginated list') {
  return ok({ type: 'array', items: schema }, description);
}

function okText(description: string) {
  return {
    description,
    content: {
      'text/csv': { schema: { type: 'string' } },
      'application/json': { schema: { type: 'object' } },
    },
  };
}

function errorResponse(code: string, description: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: { type: 'boolean', enum: [false] },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', example: code },
                message: { type: 'string' },
                details: {},
              },
            },
            requestId: { type: ['string', 'null'] },
          },
        },
      },
    },
  };
}

const errors = {
  validation: errorResponse('VALIDATION_ERROR', 'Request validation failed (422).'),
  unauthorized: errorResponse('UNAUTHORIZED', 'A valid Bearer access token is required.'),
  forbidden: errorResponse('ROLE_NOT_ALLOWED', 'The authenticated role does not permit this operation.'),
  notFound: errorResponse('NOT_FOUND', 'The resource does not exist or is not visible to this caller.'),
  conflict: errorResponse('CONFLICT', 'The request conflicts with current state or another request.'),
  rateLimited: errorResponse('TOO_MANY_REQUESTS', 'Rate limit exceeded. Retry later.'),
  server: errorResponse('INTERNAL_ERROR', 'Unexpected server failure.'),
};

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'cuid' },
  description: 'Resource identifier (CUID).',
};
const pageParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
  { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
];
const idempotencyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: { type: 'string', minLength: 16, maxLength: 128 },
  description:
    'Client-generated unique key. Retrying the same request with the same key and payload returns the stored response instead of repeating the financial operation.',
};

export const openapiDocument: any = {
  openapi: '3.1.0',
  info: {
    title: 'NEXUS BANK — Digital Banking & Wallet API',
    version: '1.0.0',
    description: [
      'Educational, simulation-only digital banking API demonstrating double-entry accounting,',
      'idempotent money movement, hold-based withdrawals, rotating refresh tokens and RBAC.',
      '',
      '**No real money is moved by this API.** Payouts are simulated and deposits settle through a',
      'signed simulated-provider webhook. Stripe test mode can be enabled for deposit intents.',
      '',
      'Money is represented as decimal strings for display and integer minor-unit strings for exact values.',
      'Clients must never use floating-point arithmetic on amounts.',
    ].join('\n'),
    license: { name: 'MIT' },
  },
  servers: [
    { url: '/api/v1', description: 'Current host' },
    { url: 'http://localhost:3000/api/v1', description: 'Local development' },
    { url: 'https://nexusbank.example.com/api/v1', description: 'Example production (fictional domain)' },
  ],
  tags: [
    { name: 'Auth', description: 'Registration, login, MFA, sessions, PINs and password recovery.' },
    { name: 'Users', description: 'Profile, security events and account closure.' },
    { name: 'Wallets', description: 'Multi-currency wallets, balances, statements and exports.' },
    { name: 'Transfers', description: 'Double-entry customer-to-customer transfers.' },
    { name: 'Transactions', description: 'Unified transaction history, details and receipts.' },
    { name: 'Deposits', description: 'Provider deposit intents and simulated settlement.' },
    { name: 'Withdrawals', description: 'Payout-method withdrawals with holds and admin review.' },
    { name: 'Payment methods', description: 'Payout bank account references (token + last four only).' },
    { name: 'Notifications', description: 'In-app notification inbox.' },
    { name: 'Admin', description: 'User administration, review queues, ledger and reconciliation.' },
    { name: 'Webhooks', description: 'Signed provider callbacks (public, signature-authenticated).' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Short-lived access token returned by login or refresh.',
      },
    },
    parameters: {
      IdempotencyKey: idempotencyHeader,
      Page: pageParams[0],
      PageSize: pageParams[1],
      SortOrder: pageParams[2],
      ResourceId: idParam,
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['success', 'error'],
        properties: {
          success: { type: 'boolean', enum: [false] },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
          },
          requestId: { type: ['string', 'null'] },
        },
      },
      Currency: {
        type: 'object',
        required: ['code', 'name', 'symbol', 'exponent'],
        properties: {
          code: { type: 'string', example: 'USD' },
          name: { type: 'string', example: 'US Dollar' },
          symbol: { type: 'string', example: '$' },
          exponent: { type: 'integer', example: 2 },
        },
      },
      Balance: {
        type: 'object',
        properties: {
          total: { type: 'string', example: '1250.00' },
          available: { type: 'string', example: '1200.00' },
          held: { type: 'string', example: '50.00' },
          totalMinor: { type: 'string', example: '125000' },
          availableMinor: { type: 'string', example: '120000' },
          heldMinor: { type: 'string', example: '5000' },
          currency: { type: 'string', example: 'USD' },
        },
        description: 'Decimal strings are for display; minor-unit strings are exact integers.',
      },
      PublicUser: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'cuid' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          role: { type: 'string', enum: ['CUSTOMER', 'SUPPORT', 'FINANCE_ADMIN', 'SUPER_ADMIN'] },
          status: { type: 'string', enum: ['ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED', 'FROZEN', 'CLOSED'] },
          emailVerifiedAt: { type: ['string', 'null'], format: 'date-time' },
          twoFactorEnabled: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          lastLoginAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      Wallet: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'cuid' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['PERSONAL', 'SAVINGS'] },
          status: { type: 'string', enum: ['ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED', 'FROZEN', 'CLOSED'] },
          isPrimary: { type: 'boolean' },
          currency: ref('Currency'),
          balance: ref('Balance'),
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          closedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      Transaction: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'cuid' },
          reference: { type: 'string', example: 'TXN-2026-ABCDEF123456' },
          type: {
            type: 'string',
            enum: ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'FEE', 'REFUND', 'REVERSAL', 'ADJUSTMENT'],
          },
          status: {
            type: 'string',
            enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVERSED'],
          },
          direction: { type: 'string', enum: ['DEBIT', 'CREDIT', 'INTERNAL', 'NONE'] },
          amount: { type: 'string', example: '250.00' },
          amountMinor: { type: 'string', example: '25000' },
          fee: { type: 'string', example: '0.00' },
          feeMinor: { type: 'string', example: '0' },
          currency: { type: 'string', example: 'USD' },
          description: { type: ['string', 'null'] },
          walletId: { type: ['string', 'null'] },
          sourceWalletId: { type: ['string', 'null'] },
          destinationWalletId: { type: ['string', 'null'] },
          counterparty: {
            type: ['object', 'null'],
            properties: { name: { type: 'string' }, walletId: { type: 'string' } },
          },
          failureReason: { type: ['string', 'null'] },
          journalReferences: { type: 'array', items: { type: 'string' } },
          depositStatus: { type: ['string', 'null'] },
          withdrawalStatus: { type: ['string', 'null'] },
          reversal: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      Transfer: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'cuid' },
          reference: { type: 'string' },
          type: { type: 'string', enum: ['TRANSFER'] },
          status: { type: 'string' },
          direction: { type: 'string', enum: ['DEBIT', 'CREDIT', 'NONE'] },
          amount: { type: 'string' },
          amountMinor: { type: 'string' },
          fee: { type: 'string' },
          feeMinor: { type: 'string' },
          totalDebit: { type: 'string' },
          currency: { type: 'string' },
          description: { type: ['string', 'null'] },
          sourceWallet: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
          destinationWallet: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
          counterparty: {
            type: 'object',
            properties: { name: { type: 'string' }, id: { type: 'string' } },
          },
          createdAt: { type: 'string', format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      Deposit: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'cuid' },
          reference: { type: 'string' },
          wallet: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
          amount: { type: 'string' },
          amountMinor: { type: 'string' },
          currency: { type: 'string' },
          provider: { type: 'string', enum: ['SIMULATED', 'STRIPE'] },
          providerReference: { type: 'string' },
          status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'] },
          failureReason: { type: ['string', 'null'] },
          checkoutUrl: { type: ['string', 'null'], format: 'uri' },
          expiresAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' },
          simulation: {
            type: ['object', 'null'],
            properties: {
              available: { type: 'boolean' },
              endpoint: { type: 'string' },
              note: { type: 'string' },
            },
          },
        },
      },
      Withdrawal: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'cuid' },
          reference: { type: 'string' },
          wallet: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
          amount: { type: 'string' },
          amountMinor: { type: 'string' },
          fee: { type: 'string' },
          feeMinor: { type: 'string' },
          total: { type: 'string' },
          totalMinor: { type: 'string' },
          currency: { type: 'string' },
          status: {
            type: 'string',
            enum: ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'FAILED', 'CANCELLED'],
          },
          payoutMethod: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              bankName: { type: 'string' },
              accountLast4: { type: 'string' },
              isDefault: { type: 'boolean' },
            },
          },
          payoutReference: { type: ['string', 'null'] },
          payoutAttempts: { type: 'integer' },
          lastPayoutError: { type: ['string', 'null'] },
          reviewedAt: { type: ['string', 'null'], format: 'date-time' },
          reviewNote: { type: ['string', 'null'] },
          rejectionReason: { type: ['string', 'null'] },
          failureReason: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      PaymentMethod: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'cuid' },
          type: { type: 'string', enum: ['PAYOUT_BANK_ACCOUNT'] },
          provider: { type: 'string', enum: ['SIMULATED', 'STRIPE'] },
          bankName: { type: 'string' },
          accountLast4: { type: 'string', pattern: '^\\d{4}$' },
          isDefault: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Notification: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'cuid' },
          type: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          data: { type: ['object', 'null'] },
          readAt: { type: ['string', 'null'], format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      SecurityEvent: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          ipHash: { type: ['string', 'null'] },
          userAgent: { type: ['string', 'null'] },
          metadata: { type: ['object', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Session: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          deviceName: { type: ['string', 'null'] },
          userAgent: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
          lastUsedAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
          current: { type: 'boolean' },
        },
      },
      TokenResponse: {
        type: 'object',
        properties: {
          user: ref('PublicUser'),
          accessToken: { type: 'string' },
          tokenType: { type: 'string', enum: ['Bearer'] },
          accessTokenExpiresIn: { type: 'integer', example: 900 },
          refreshToken: {
            type: 'string',
            description: 'Also set as an HttpOnly, SameSite=Strict cookie scoped to the auth path.',
          },
          refreshTokenExpiresAt: { type: 'string', format: 'date-time' },
          sessionId: { type: 'string' },
        },
      },
      LedgerAccount: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          code: { type: 'string', example: 'SYS:CASH:USD' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] },
          normalBalance: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
          currencyCode: { type: 'string' },
          isSystem: { type: 'boolean' },
          debitTotal: { type: 'string' },
          creditTotal: { type: 'string' },
          balance: { type: 'string' },
        },
      },
      JournalEntry: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reference: { type: 'string' },
          transactionId: { type: ['string', 'null'] },
          currencyCode: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['POSTED'] },
          createdAt: { type: 'string', format: 'date-time' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                ledgerAccountId: { type: 'string' },
                ledgerAccountCode: { type: 'string' },
                debitMinor: { type: 'string' },
                creditMinor: { type: 'string' },
                description: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
      AuditLog: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          actorUserId: { type: ['string', 'null'] },
          actorRole: { type: 'string' },
          action: { type: 'string' },
          entityType: { type: 'string' },
          entityId: { type: 'string' },
          reason: { type: ['string', 'null'] },
          requestId: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      AdminUser: {
        allOf: [
          ref('PublicUser'),
          {
            type: 'object',
            properties: {
              deletedAt: { type: ['string', 'null'], format: 'date-time' },
              counts: {
                type: 'object',
                properties: { wallets: { type: 'integer' }, sessions: { type: 'integer' } },
              },
            },
          },
        ],
      },
      ReconciliationReport: {
        type: 'object',
        properties: {
          generatedAt: { type: 'string', format: 'date-time' },
          healthy: { type: 'boolean' },
          trialBalance: {
            type: 'object',
            properties: {
              currencyCode: { type: 'string' },
              debitTotal: { type: 'string' },
              creditTotal: { type: 'string' },
              balanced: { type: 'boolean' },
            },
          },
          findings: { type: 'array', items: { type: 'object' } },
          checked: { type: 'object' },
        },
      },
      WebhookResult: {
        type: 'object',
        properties: {
          eventId: { type: 'string' },
          status: { type: 'string', enum: ['processed', 'ignored', 'duplicate', 'failed'] },
          duplicate: { type: 'boolean' },
          message: { type: 'string' },
          depositId: { type: 'string' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a customer account',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'email', 'password'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string', minLength: 2, maxLength: 120 },
                  email: { type: 'string', format: 'email' },
                  password: {
                    type: 'string',
                    minLength: 12,
                    maxLength: 128,
                    description: 'Must satisfy the password policy; cannot contain the email or name.',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: ok(
            {
              type: 'object',
              properties: { user: ref('PublicUser'), message: { type: 'string' } },
            },
            'Account created. A verification email is written by the configured dispatcher.',
          ),
          400: errors.validation,
          409: errorResponse('EMAIL_ALREADY_EXISTS', 'Email is already registered.'),
          429: errors.rateLimited,
        },
      },
    },
    '/auth/verify-email': {
      post: {
        tags: ['Auth'],
        summary: 'Verify an email address using the one-time token',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token'],
                additionalProperties: false,
                properties: { token: { type: 'string', minLength: 32, maxLength: 256 } },
              },
            },
          },
        },
        responses: {
          200: ok({ type: 'object', properties: { message: { type: 'string' } } }),
          400: errors.validation,
          429: errors.rateLimited,
        },
      },
    },
    '/auth/resend-verification': {
      post: {
        tags: ['Auth'],
        summary: 'Resend the verification email (enumeration-safe response)',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                additionalProperties: false,
                properties: { email: { type: 'string', format: 'email' } },
              },
            },
          },
        },
        responses: { 202: ok({ type: 'object' }), 429: errors.rateLimited },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Authenticate with email and password',
        security: [],
        description:
          'Returns tokens immediately, or an MFA challenge when TOTP is enabled. Five failed attempts lock the account for 15 minutes.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                additionalProperties: false,
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                  deviceName: { type: 'string', maxLength: 100 },
                },
              },
            },
          },
        },
        responses: {
          200: ok(
            {
              oneOf: [
                ref('TokenResponse'),
                {
                  type: 'object',
                  properties: {
                    mfaRequired: { type: 'boolean', enum: [true] },
                    mfaToken: { type: 'string' },
                    expiresInSeconds: { type: 'integer', example: 300 },
                  },
                },
              ],
            },
            'Authenticated or MFA challenge issued.',
          ),
          401: errorResponse('INVALID_CREDENTIALS', 'Invalid email or password.'),
          423: errorResponse('ACCOUNT_LOCKED', 'Too many failed attempts.'),
          429: errors.rateLimited,
        },
      },
    },
    '/auth/2fa/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Complete an MFA login challenge',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['mfaToken', 'code'],
                properties: {
                  mfaToken: { type: 'string' },
                  code: { type: 'string', pattern: '^\\d{6}$' },
                  deviceName: { type: 'string', maxLength: 100 },
                },
              },
            },
          },
        },
        responses: { 200: ok(ref('TokenResponse')), 401: errors.unauthorized, 422: errors.validation },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate a refresh token',
        security: [],
        description:
          'Accepts the HttpOnly refresh cookie or a refreshToken body field. Reuse of an already-rotated token revokes the entire session family and raises a critical security event.',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { refreshToken: { type: 'string', minLength: 32, maxLength: 500 } },
              },
            },
          },
        },
        responses: {
          200: ok(ref('TokenResponse')),
          401: errorResponse('REFRESH_TOKEN_REUSE', 'Refresh token invalid, expired, revoked or reused.'),
          429: errors.rateLimited,
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Revoke the current session',
        responses: { 200: ok({ type: 'object', properties: { message: { type: 'string' } } }), 401: errors.unauthorized },
      },
    },
    '/auth/logout-all': {
      post: {
        tags: ['Auth'],
        summary: 'Revoke every session for the current user',
        responses: { 200: ok({ type: 'object' }), 401: errors.unauthorized },
      },
    },
    '/auth/sessions': {
      get: {
        tags: ['Auth'],
        summary: 'List active sessions',
        responses: { 200: ok({ type: 'array', items: ref('Session') }), 401: errors.unauthorized },
      },
    },
    '/auth/sessions/{sessionId}': {
      delete: {
        tags: ['Auth'],
        summary: 'Revoke a specific session',
        parameters: [
          {
            name: 'sessionId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'cuid' },
          },
        ],
        responses: { 200: ok({ type: 'object' }), 401: errors.unauthorized, 404: errors.notFound },
      },
    },
    '/auth/forgot-password': {
      post: {
        tags: ['Auth'],
        summary: 'Request a password-reset email (enumeration-safe)',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email'],
                additionalProperties: false,
                properties: { email: { type: 'string', format: 'email' } },
              },
            },
          },
        },
        responses: { 202: ok({ type: 'object' }), 429: errors.rateLimited },
      },
    },
    '/auth/reset-password': {
      post: {
        tags: ['Auth'],
        summary: 'Reset a password with a one-time token',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token', 'newPassword'],
                additionalProperties: false,
                properties: {
                  token: { type: 'string' },
                  newPassword: { type: 'string', minLength: 12, maxLength: 128 },
                },
              },
            },
          },
        },
        responses: { 200: ok({ type: 'object' }), 400: errors.validation, 429: errors.rateLimited },
      },
    },
    '/auth/change-password': {
      post: {
        tags: ['Auth'],
        summary: 'Change the current password',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['currentPassword', 'newPassword'],
                additionalProperties: false,
                properties: {
                  currentPassword: { type: 'string' },
                  newPassword: { type: 'string', minLength: 12, maxLength: 128 },
                },
              },
            },
          },
        },
        responses: { 200: ok({ type: 'object' }), 401: errors.unauthorized, 422: errors.validation },
      },
    },
    '/auth/2fa/setup': {
      post: {
        tags: ['Auth'],
        summary: 'Start TOTP enrollment',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['password'],
                additionalProperties: false,
                properties: { password: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: ok({
            type: 'object',
            properties: {
              secret: { type: 'string', description: 'Base32 TOTP secret; show once.' },
              otpauthUrl: { type: 'string' },
            },
          }),
          401: errors.unauthorized,
          409: errors.conflict,
        },
      },
    },
    '/auth/2fa/enable': {
      post: {
        tags: ['Auth'],
        summary: 'Confirm and enable TOTP',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['code'],
                additionalProperties: false,
                properties: { code: { type: 'string', pattern: '^\\d{6}$' } },
              },
            },
          },
        },
        responses: { 200: ok({ type: 'object' }), 422: errors.validation },
      },
    },
    '/auth/2fa/disable': {
      post: {
        tags: ['Auth'],
        summary: 'Disable TOTP using password and a valid code',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['password', 'code'],
                additionalProperties: false,
                properties: {
                  password: { type: 'string' },
                  code: { type: 'string', pattern: '^\\d{6}$' },
                },
              },
            },
          },
        },
        responses: { 200: ok({ type: 'object' }), 401: errors.unauthorized },
      },
    },
    '/auth/pin': {
      put: {
        tags: ['Auth'],
        summary: 'Set the transaction PIN',
        description: 'Requires the password. The PIN is HMAC-peppered then Argon2id-hashed.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['password', 'pin'],
                additionalProperties: false,
                properties: {
                  password: { type: 'string' },
                  pin: { type: 'string', pattern: '^\\d{4,6}$' },
                },
              },
            },
          },
        },
        responses: { 200: ok({ type: 'object' }), 401: errors.unauthorized, 429: errors.rateLimited },
      },
      patch: {
        tags: ['Auth'],
        summary: 'Change the transaction PIN',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['password', 'currentPin', 'newPin'],
                additionalProperties: false,
                properties: {
                  password: { type: 'string' },
                  currentPin: { type: 'string', pattern: '^\\d{4,6}$' },
                  newPin: { type: 'string', pattern: '^\\d{4,6}$' },
                },
              },
            },
          },
        },
        responses: { 200: ok({ type: 'object' }), 401: errors.unauthorized },
      },
    },
    '/auth/config': {
      get: {
        tags: ['Auth'],
        summary: 'Public authentication metadata',
        security: [],
        responses: { 200: ok({ type: 'object' }) },
      },
    },
    '/users/me': {
      get: {
        tags: ['Users'],
        summary: 'Get the current profile',
        responses: { 200: ok(ref('PublicUser')), 401: errors.unauthorized },
      },
      patch: {
        tags: ['Users'],
        summary: 'Update the current profile',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                additionalProperties: false,
                properties: { name: { type: 'string', minLength: 2, maxLength: 120 } },
              },
            },
          },
        },
        responses: { 200: ok(ref('PublicUser')), 401: errors.unauthorized, 403: errors.forbidden },
      },
      delete: {
        tags: ['Users'],
        summary: 'Close the current account and revoke all sessions',
        description: 'Requires zero remaining wallet balance. Audit data is retained.',
        responses: { 200: ok({ type: 'object' }), 401: errors.unauthorized, 422: errors.validation },
      },
    },
    '/users/me/security-events': {
      get: {
        tags: ['Users'],
        summary: 'List recent security events for the current user',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }],
        responses: { 200: ok({ type: 'array', items: ref('SecurityEvent') }), 401: errors.unauthorized },
      },
    },
    '/wallets': {
      get: {
        tags: ['Wallets'],
        summary: 'List the current user’s wallets',
        responses: { 200: ok({ type: 'array', items: ref('Wallet') }), 401: errors.unauthorized },
      },
      post: {
        tags: ['Wallets'],
        summary: 'Create a wallet',
        description: 'Requires an active, verified account. The first wallet is primary.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'currencyCode'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 60 },
                  currencyCode: { type: 'string', pattern: '^[A-Z]{3}$', example: 'USD' },
                  type: { type: 'string', enum: ['PERSONAL', 'SAVINGS'], default: 'PERSONAL' },
                  isPrimary: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          201: ok(ref('Wallet'), 'Wallet created with a zero-balance ledger account.'),
          401: errors.unauthorized,
          403: errors.forbidden,
          422: errors.validation,
        },
      },
    },
    '/wallets/{id}': {
      get: {
        tags: ['Wallets'],
        summary: 'Get a wallet with its balance projection',
        parameters: [idParam],
        responses: { 200: ok(ref('Wallet')), 401: errors.unauthorized, 404: errors.notFound },
      },
      patch: {
        tags: ['Wallets'],
        summary: 'Rename a wallet',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                additionalProperties: false,
                properties: { name: { type: 'string', minLength: 1, maxLength: 60 } },
              },
            },
          },
        },
        responses: { 200: ok(ref('Wallet')), 401: errors.unauthorized, 404: errors.notFound },
      },
      delete: {
        tags: ['Wallets'],
        summary: 'Close a wallet',
        description: 'Only possible when the total and held balances are zero.',
        parameters: [idParam],
        responses: { 200: ok({ type: 'object' }), 401: errors.unauthorized, 422: errors.validation },
      },
    },
    '/wallets/{id}/transactions': {
      get: {
        tags: ['Wallets'],
        summary: 'List wallet transactions (CSV when format=csv)',
        parameters: [
          idParam,
          ...pageParams,
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
        ],
        responses: {
          200: ok({ type: 'array', items: ref('Transaction') }),
          401: errors.unauthorized,
          404: errors.notFound,
        },
      },
    },
    '/wallets/{id}/transactions/export': {
      get: {
        tags: ['Wallets'],
        summary: 'Export wallet transactions as CSV',
        parameters: [
          idParam,
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { 200: okText('CSV export'), 401: errors.unauthorized, 404: errors.notFound },
      },
    },
    '/wallets/{id}/statement': {
      get: {
        tags: ['Wallets'],
        summary: 'Generate an account statement',
        parameters: [
          idParam,
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
        ],
        responses: { 200: okText('Statement (JSON or CSV)'), 401: errors.unauthorized, 404: errors.notFound },
      },
    },
    '/transfers': {
      post: {
        tags: ['Transfers'],
        summary: 'Send money between wallets',
        description:
          'Double-entry transfer. Requires a transaction PIN and Idempotency-Key. Source and destination wallets are locked in deterministic order.',
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sourceWalletId', 'destinationWalletId', 'amount', 'pin'],
                additionalProperties: false,
                properties: {
                  sourceWalletId: { type: 'string', format: 'cuid' },
                  destinationWalletId: { type: 'string', format: 'cuid' },
                  amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,6})?$', example: '25.00' },
                  description: { type: 'string', maxLength: 140 },
                  pin: { type: 'string', pattern: '^\\d{4,6}$' },
                },
              },
            },
          },
        },
        responses: {
          201: ok({ type: 'object', properties: { transfer: ref('Transfer') } }),
          400: errors.validation,
          401: errors.unauthorized,
          409: errorResponse('IDEMPOTENCY_CONFLICT', 'The key was reused with a different payload.'),
          422: errorResponse('INSUFFICIENT_FUNDS', 'Available balance is insufficient, or a limit was exceeded.'),
          429: errors.rateLimited,
        },
      },
      get: {
        tags: ['Transfers'],
        summary: 'List transfers involving the current user',
        parameters: [
          ...pageParams,
          { name: 'direction', in: 'query', schema: { type: 'string', enum: ['all', 'sent', 'received'], default: 'all' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'currency', in: 'query', schema: { type: 'string', pattern: '^[A-Z]{3}$' } },
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { 200: okList(ref('Transfer')), 401: errors.unauthorized },
      },
    },
    '/transfers/{id}': {
      get: {
        tags: ['Transfers'],
        summary: 'Get a transfer',
        parameters: [idParam],
        responses: { 200: ok(ref('Transfer')), 401: errors.unauthorized, 404: errors.notFound },
      },
    },
    '/transactions': {
      get: {
        tags: ['Transactions'],
        summary: 'List all transactions visible to the current user',
        parameters: [
          ...pageParams,
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'currency', in: 'query', schema: { type: 'string' } },
          { name: 'walletId', in: 'query', schema: { type: 'string', format: 'cuid' } },
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'reference', in: 'query', schema: { type: 'string' } },
          { name: 'search', in: 'query', schema: { type: 'string', maxLength: 100 } },
          { name: 'minAmount', in: 'query', schema: { type: 'string' } },
          { name: 'maxAmount', in: 'query', schema: { type: 'string' } },
          { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['createdAt', 'amount'], default: 'createdAt' } },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
        ],
        responses: { 200: okList(ref('Transaction')), 401: errors.unauthorized, 422: errors.validation },
      },
    },
    '/transactions/{id}': {
      get: {
        tags: ['Transactions'],
        summary: 'Get transaction details',
        parameters: [idParam],
        responses: { 200: ok(ref('Transaction')), 401: errors.unauthorized, 404: errors.notFound },
      },
    },
    '/transactions/{id}/receipt': {
      get: {
        tags: ['Transactions'],
        summary: 'Generate a simulation receipt',
        parameters: [idParam],
        responses: { 200: ok({ type: 'object' }), 401: errors.unauthorized, 404: errors.notFound },
      },
    },
    '/deposits': {
      post: {
        tags: ['Deposits'],
        summary: 'Create a deposit intent',
        description:
          'Returns a provider checkout URL (Stripe test) or a simulated intent. Requires Idempotency-Key. Credits are posted only when a signature-verified webhook settles the deposit.',
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['walletId', 'amount'],
                additionalProperties: false,
                properties: {
                  walletId: { type: 'string', format: 'cuid' },
                  amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,6})?$', example: '100.00' },
                  description: { type: 'string', maxLength: 140 },
                  provider: { type: 'string', enum: ['SIMULATED', 'STRIPE'] },
                },
              },
            },
          },
        },
        responses: {
          201: ok(ref('Deposit'), 'Deposit intent created.'),
          400: errors.validation,
          422: errors.validation,
          429: errors.rateLimited,
        },
      },
      get: {
        tags: ['Deposits'],
        summary: 'List deposits',
        parameters: [{ ...pageParams[0] }, { ...pageParams[1] }, { ...pageParams[2] }, { name: 'status', in: 'query', schema: { type: 'string' } }],
        responses: { 200: okList(ref('Deposit')), 401: errors.unauthorized },
      },
    },
    '/deposits/{id}': {
      get: {
        tags: ['Deposits'],
        summary: 'Get a deposit',
        parameters: [idParam],
        responses: { 200: ok(ref('Deposit')), 401: errors.unauthorized, 404: errors.notFound },
      },
    },
    '/deposits/{id}/simulate': {
      post: {
        tags: ['Deposits'],
        summary: 'Settle or fail a simulated deposit',
        description:
          'Builds a signed simulated-provider event and processes it through the same signature-verification path as a real webhook. Disabled when NODE_ENV=production.',
        parameters: [idParam],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: { outcome: { type: 'string', enum: ['completed', 'failed'], default: 'completed' } },
              },
            },
          },
        },
        responses: {
          200: ok(ref('WebhookResult')),
          403: errors.forbidden,
          404: errors.notFound,
          422: errors.validation,
        },
      },
    },
    '/withdrawals': {
      post: {
        tags: ['Withdrawals'],
        summary: 'Request a withdrawal',
        description:
          'Places a hold for amount + fee and enters review at or above the configured threshold. Requires a transaction PIN and Idempotency-Key.',
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['walletId', 'payoutMethodId', 'amount', 'pin'],
                additionalProperties: false,
                properties: {
                  walletId: { type: 'string', format: 'cuid' },
                  payoutMethodId: { type: 'string', format: 'cuid' },
                  amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,6})?$', example: '75.00' },
                  description: { type: 'string', maxLength: 140 },
                  pin: { type: 'string', pattern: '^\\d{4,6}$' },
                },
              },
            },
          },
        },
        responses: {
          201: ok({ type: 'object', properties: { withdrawal: ref('Withdrawal') } }),
          400: errors.validation,
          422: errorResponse('INSUFFICIENT_FUNDS', 'Available balance (including the fee) is insufficient.'),
          429: errors.rateLimited,
        },
      },
      get: {
        tags: ['Withdrawals'],
        summary: 'List withdrawals',
        parameters: [...pageParams, { name: 'status', in: 'query', schema: { type: 'string' } }],
        responses: { 200: okList(ref('Withdrawal')), 401: errors.unauthorized },
      },
    },
    '/withdrawals/{id}': {
      get: {
        tags: ['Withdrawals'],
        summary: 'Get a withdrawal',
        parameters: [idParam],
        responses: { 200: ok(ref('Withdrawal')), 401: errors.unauthorized, 404: errors.notFound },
      },
    },
    '/withdrawals/{id}/cancel': {
      post: {
        tags: ['Withdrawals'],
        summary: 'Cancel a withdrawal before payout starts',
        parameters: [idParam],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } },
              },
            },
          },
        },
        responses: { 200: ok(ref('Withdrawal')), 401: errors.unauthorized, 409: errors.conflict },
      },
    },
    '/payment-methods': {
      get: {
        tags: ['Payment methods'],
        summary: 'List payout methods',
        responses: { 200: ok({ type: 'array', items: ref('PaymentMethod') }), 401: errors.unauthorized },
      },
      post: {
        tags: ['Payment methods'],
        summary: 'Create a payout method reference',
        description: 'Only bank name, last four digits and a generated provider token are stored.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['bankName', 'accountLast4'],
                additionalProperties: false,
                properties: {
                  bankName: { type: 'string', minLength: 2, maxLength: 120 },
                  accountLast4: { type: 'string', pattern: '^\\d{4}$' },
                  isDefault: { type: 'boolean', default: false },
                },
              },
            },
          },
        },
        responses: { 201: ok(ref('PaymentMethod')), 401: errors.unauthorized, 422: errors.validation },
      },
    },
    '/payment-methods/{id}/default': {
      patch: {
        tags: ['Payment methods'],
        summary: 'Make a payout method the default',
        parameters: [idParam],
        responses: { 200: ok(ref('PaymentMethod')), 401: errors.unauthorized, 404: errors.notFound },
      },
    },
    '/payment-methods/{id}': {
      delete: {
        tags: ['Payment methods'],
        summary: 'Soft-delete a payout method',
        parameters: [idParam],
        responses: { 200: ok({ type: 'object' }), 401: errors.unauthorized, 409: errors.conflict },
      },
    },
    '/notifications': {
      get: {
        tags: ['Notifications'],
        summary: 'List notifications',
        parameters: [
          { ...pageParams[0] },
          { ...pageParams[1] },
          { name: 'unreadOnly', in: 'query', schema: { type: 'boolean', default: false } },
        ],
        responses: { 200: ok({ type: 'array', items: ref('Notification') }), 401: errors.unauthorized },
      },
    },
    '/notifications/read-all': {
      post: {
        tags: ['Notifications'],
        summary: 'Mark all notifications as read',
        responses: { 200: ok({ type: 'object', properties: { updated: { type: 'integer' } } }), 401: errors.unauthorized },
      },
    },
    '/notifications/{id}/read': {
      patch: {
        tags: ['Notifications'],
        summary: 'Mark one notification as read',
        parameters: [idParam],
        responses: { 200: ok({ type: 'object' }), 401: errors.unauthorized, 404: errors.notFound },
      },
    },
    '/admin/users': {
      get: {
        tags: ['Admin'],
        summary: 'List users',
        description: 'Requires admin.read (SUPPORT, FINANCE_ADMIN or SUPER_ADMIN).',
        parameters: [
          ...pageParams,
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'role', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: okList(ref('AdminUser')), 401: errors.unauthorized, 403: errors.forbidden },
      },
    },
    '/admin/users/{id}': {
      get: {
        tags: ['Admin'],
        summary: 'Get a user with wallet and session counts',
        parameters: [idParam],
        responses: { 200: ok(ref('AdminUser')), 401: errors.unauthorized, 403: errors.forbidden, 404: errors.notFound },
      },
    },
    '/admin/users/{id}/status': {
      patch: {
        tags: ['Admin'],
        summary: 'Change a user status',
        description:
          'Requires users.manage and X-Admin-Confirmation equal to the target user id. A reason is mandatory and audited.',
        parameters: [
          idParam,
          {
            name: 'X-Admin-Confirmation',
            in: 'header',
            required: true,
            schema: { type: 'string' },
            description: 'Must exactly equal the target user id.',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status', 'reason'],
                additionalProperties: false,
                properties: {
                  status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'FROZEN'] },
                  reason: { type: 'string', minLength: 3, maxLength: 500 },
                },
              },
            },
          },
        },
        responses: {
          200: ok(ref('AdminUser')),
          401: errors.unauthorized,
          403: errors.forbidden,
          409: errors.conflict,
          428: errorResponse('CONFIRMATION_REQUIRED', 'The confirmation header is missing or mismatched.'),
        },
      },
    },
    '/admin/users/{id}/role': {
      patch: {
        tags: ['Admin'],
        summary: 'Change a user role',
        description: 'Requires roles.manage and X-Admin-Confirmation equal to the target user id.',
        parameters: [
          idParam,
          {
            name: 'X-Admin-Confirmation',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['role', 'reason'],
                additionalProperties: false,
                properties: {
                  role: { type: 'string', enum: ['CUSTOMER', 'SUPPORT', 'FINANCE_ADMIN', 'SUPER_ADMIN'] },
                  reason: { type: 'string', minLength: 3, maxLength: 500 },
                },
              },
            },
          },
        },
        responses: { 200: ok(ref('AdminUser')), 403: errors.forbidden, 428: errors.validation },
      },
    },
    '/admin/withdrawals': {
      get: {
        tags: ['Admin'],
        summary: 'List withdrawals for review',
        parameters: [...pageParams, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'userId', in: 'query', schema: { type: 'string' } }],
        responses: { 200: okList(ref('Withdrawal')), 401: errors.unauthorized, 403: errors.forbidden },
      },
    },
    '/admin/withdrawals/{id}': {
      get: {
        tags: ['Admin'],
        summary: 'Get a withdrawal for review',
        parameters: [idParam],
        responses: { 200: ok(ref('Withdrawal')), 403: errors.forbidden, 404: errors.notFound },
      },
    },
    '/admin/withdrawals/{id}/approve': {
      post: {
        tags: ['Admin'],
        summary: 'Approve a withdrawal and dispatch payout',
        parameters: [idParam],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: { note: { type: 'string', maxLength: 300 } },
              },
            },
          },
        },
        responses: { 200: ok(ref('Withdrawal')), 403: errors.forbidden, 409: errors.conflict },
      },
    },
    '/admin/withdrawals/{id}/reject': {
      post: {
        tags: ['Admin'],
        summary: 'Reject a withdrawal and release its hold',
        parameters: [idParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reason'],
                additionalProperties: false,
                properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } },
              },
            },
          },
        },
        responses: { 200: ok(ref('Withdrawal')), 403: errors.forbidden, 409: errors.conflict },
      },
    },
    '/admin/withdrawals/{id}/retry-payout': {
      post: {
        tags: ['Admin'],
        summary: 'Retry a payout stuck in PROCESSING',
        description: 'Uses the same provider idempotency key, so a payout cannot be duplicated by retrying.',
        parameters: [idParam],
        responses: { 200: ok(ref('Withdrawal')), 403: errors.forbidden, 409: errors.conflict },
      },
    },
    '/admin/transfers/{id}/reverse': {
      post: {
        tags: ['Admin'],
        summary: 'Reverse a completed transfer',
        description:
          'Requires transfers.reverse, X-Admin-Confirmation equal to the transfer id, and an Idempotency-Key. Posts a compensating journal; the original journal is never mutated.',
        parameters: [
          idParam,
          idempotencyHeader,
          {
            name: 'X-Admin-Confirmation',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reason'],
                additionalProperties: false,
                properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } },
              },
            },
          },
        },
        responses: { 200: ok({ type: 'object' }), 403: errors.forbidden, 409: errors.conflict, 428: errors.validation },
      },
    },
    '/admin/ledger/accounts': {
      get: {
        tags: ['Admin'],
        summary: 'List ledger accounts with debit/credit totals',
        parameters: [
          ...pageParams,
          { name: 'currency', in: 'query', schema: { type: 'string' } },
          { name: 'accountType', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: okList(ref('LedgerAccount')), 403: errors.forbidden },
      },
    },
    '/admin/ledger/trial-balance': {
      get: {
        tags: ['Admin'],
        summary: 'Trial balance by currency',
        responses: { 200: ok({ type: 'object' }), 403: errors.forbidden },
      },
    },
    '/admin/ledger/journal-entries': {
      get: {
        tags: ['Admin'],
        summary: 'List immutable journal entries',
        parameters: [
          ...pageParams,
          { name: 'currency', in: 'query', schema: { type: 'string' } },
          { name: 'transactionId', in: 'query', schema: { type: 'string' } },
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { 200: okList(ref('JournalEntry')), 403: errors.forbidden },
      },
    },
    '/admin/ledger/adjustments': {
      post: {
        tags: ['Admin'],
        summary: 'Post a manual ledger adjustment',
        description:
          'Requires ledger.adjust, Idempotency-Key and X-Admin-Confirmation equal to the wallet id. Posts a balanced journal against an adjustment system account.',
        parameters: [
          idempotencyHeader,
          {
            name: 'X-Admin-Confirmation',
            in: 'header',
            required: true,
            schema: { type: 'string' },
            description: 'Must exactly equal the target wallet id.',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['walletId', 'direction', 'amount', 'reason'],
                additionalProperties: false,
                properties: {
                  walletId: { type: 'string', format: 'cuid' },
                  direction: { type: 'string', enum: ['CREDIT', 'DEBIT'] },
                  amount: { type: 'string', example: '10.00' },
                  reason: { type: 'string', minLength: 3, maxLength: 500 },
                },
              },
            },
          },
        },
        responses: { 201: ok({ type: 'object' }), 403: errors.forbidden, 422: errors.validation, 428: errors.validation },
      },
    },
    '/admin/reconciliation': {
      get: {
        tags: ['Admin'],
        summary: 'Read the latest reconciliation snapshot',
        responses: { 200: ok(ref('ReconciliationReport')), 403: errors.forbidden },
      },
    },
    '/admin/reconciliation/run': {
      post: {
        tags: ['Admin'],
        summary: 'Run ledger reconciliation now',
        responses: { 200: ok(ref('ReconciliationReport')), 403: errors.forbidden },
      },
    },
    '/admin/audit-logs': {
      get: {
        tags: ['Admin'],
        summary: 'List append-only audit records',
        parameters: [
          ...pageParams,
          { name: 'actorUserId', in: 'query', schema: { type: 'string' } },
          { name: 'action', in: 'query', schema: { type: 'string' } },
          { name: 'entityType', in: 'query', schema: { type: 'string' } },
          { name: 'entityId', in: 'query', schema: { type: 'string' } },
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { 200: okList(ref('AuditLog')), 403: errors.forbidden },
      },
    },
    '/admin/stats': {
      get: {
        tags: ['Admin'],
        summary: 'Operational dashboard counters',
        responses: { 200: ok({ type: 'object' }), 403: errors.forbidden },
      },
    },
    '/webhooks/payments/{provider}': {
      post: {
        tags: ['Webhooks'],
        summary: 'Receive a signed payment provider event',
        security: [],
        description:
          'Authenticity is derived from the raw request body and the provider signature header, never from the source IP. Events are idempotent on (provider, eventId) and amount/currency are validated against the local deposit before settlement.',
        parameters: [
          {
            name: 'provider',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['simulated', 'stripe'] },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description:
                  'Opaque provider payload. For the simulated provider, signed with x-nexus-signature HMAC-SHA256.',
                additionalProperties: true,
              },
            },
          },
        },
        responses: {
          200: ok(ref('WebhookResult')),
          422: ok(ref('WebhookResult'), 'Event was well-formed but rejected (e.g., amount mismatch).'),
          401: errorResponse('WEBHOOK_SIGNATURE_INVALID', 'Signature verification failed.'),
          404: errors.notFound,
        },
      },
    },
  },
};
