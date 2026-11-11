# NEXUS BANK — API Conventions

The full endpoint catalogue is machine-readable OpenAPI 3.1 (`/openapi.json`, served at `/docs` via
Swagger UI) and mirrored by the Postman collection. This document covers what applies uniformly
across the API.

## Base URL, versioning and content type

- Base path: **`/api/v1`** (e.g. `GET /api/v1/wallets`). The prefix is configurable
  (`API_PREFIX`); the refresh cookie path tracks it (`/api/v1/auth`).
- Requests and responses are `application/json` (UTF-8). Exceptions: CSV exports
  (`application/json` requested via `format=csv` on statements/transactions, returned as
  `text/csv`).
- Breaking changes would ship under `/api/v2`; additive changes ship in place.

## Response envelope

Success:

```json
{
  "success": true,
  "data": { "...": "..." },
  "meta": { "page": 1, "pageSize": 20, "total": 42, "totalPages": 3, "idempotentReplay": false }
}
```

Failure:

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_FUNDS",
    "message": "Insufficient available balance",
    "details": { "availableMinor": "492450", "requiredMinor": "1000000" }
  },
  "requestId": "01J…"
}
```

- `meta` is present on list endpoints; `idempotentReplay: true` on replayed writes.
- `error.details` is only exposed for client-fixable errors (4xx). 5xx messages are generic and
  carry a `requestId` that maps to the server log.
- `X-Request-Id` response header matches `requestId` in the body (send your own to correlate).
- All API responses are `Cache-Control: no-store` (financial data must never be cached).

## Authentication

| Mechanism | Where | Notes |
|---|---|---|
| Bearer access token | `Authorization: Bearer <token>` | 15 min TTL; carries `sid` (session), `role`, `sub` |
| Refresh cookie | `nexus_rt` HttpOnly SameSite=Strict, path `/api/v1/auth` | Rotated on every refresh; value is hashed at rest |
| Refresh body token | `POST /auth/refresh` body `refreshToken` | Fallback for cookie-less clients; same rotation rules |
| Admin confirmation | `X-Admin-Confirmation: <id>` | Required for destructive admin routes (see below) |
| Idempotency | `Idempotency-Key: <8–128 chars>` | Required for all mutating financial operations |

Access-token verification checks the **session row** (`revokedAt`, `expiresAt`) and account status —
not only the JWT signature. Suspended/closed users are rejected even with a valid signature.

## Authorization model (RBAC)

| Role | Capabilities |
|---|---|
| `CUSTOMER` | Own wallets/transfers/deposits/withdrawals/payments methods; PIN management; 2FA |
| `SUPPORT` | Read-only admin: list users, withdrawals, audit logs, ledger accounts, trial balance, reconciliation |
| `FINANCE_ADMIN` | SUPPORT + withdrawal review (approve/reject/retry) + ledger adjustments + transfer reversals |
| `SUPER_ADMIN` | FINANCE_ADMIN + user status changes + role management (`roles.manage`) |

Permission checks happen in middleware (`requirePermission`) and are re-asserted inside services
for defense in depth (`assertPermission`).

## Idempotency (financial writes)

Applies to: deposits, withdrawals, transfers, ledger adjustments, transfer reversal.

- Header: `Idempotency-Key` (8–128 chars, `[A-Za-z0-9._:-]`).
- Scope is per `(user, operation, key)`; first-write-wins.
- Same key + same payload (secrets such as PINs excluded from the fingerprint) ⇒ stored 2xx
  response replayed: same body, `meta.idempotentReplay: true`.
- Same key + different payload ⇒ `422 IDEMPOTENCY_CONFLICT`.
- Keys expire after 24h. Reusing an expired key starts a fresh operation.
- In-flight duplicates (no stored response yet) block on the unique index, then replay — they do
  not double-execute.

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR`, `INVALID_AMOUNT`, `INVALID_JSON` | 400 | Malformed input (details list issues) |
| `UNAUTHORIZED`, `INVALID_TOKEN`, `TOKEN_EXPIRED` | 401 | Auth failure |
| `REFRESH_TOKEN_REUSE` | 401 | Rotated-token replay detected; session family revoked |
| `EMAIL_NOT_VERIFIED`, `ACCOUNT_SUSPENDED`, `ACCOUNT_FROZEN`, `ACCOUNT_CLOSED` | 403 | Account cannot perform the action |
| `EMAIL_ALREADY_EXISTS`, `PASSWORD_REUSE` | 409 | Conflict |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password (never reveals which) |
| `ACCOUNT_LOCKED` | 423 | Too many failed logins (15 min) |
| `PIN_LOCKED` | 423 | Too many failed PINs (15 min) |
| `INVALID_PIN` | 401 | Wrong transaction PIN |
| `PIN_REQUIRED` | 400 | PIN missing for a PIN-gated route |
| `INSUFFICIENT_FUNDS` | 422 | Available balance too low (held funds excluded) |
| `LIMIT_EXCEEDED` | 422 | Per-transaction / daily / monthly limit |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Missing header on a financial write |
| `IDEMPOTENCY_CONFLICT` | 422 | Key reused with a different payload |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | Duplicate in flight |
| `WALLET_NOT_FOUND`, `RECIPIENT_WALLET_NOT_FOUND`, `TRANSFER_NOT_FOUND`, `DEPOSIT_NOT_FOUND`, `WITHDRAWAL_NOT_FOUND`, `PAYMENT_METHOD_NOT_FOUND` | 404 | Not found or not yours |
| `WALLET_NOT_ACTIVE`, `CURRENCY_MISMATCH`, `INVALID_STATE_TRANSITION`, `TRANSFER_ALREADY_REVERSED` | 422 | Not valid in the current state |
| `CONFIRMATION_REQUIRED` | 428 | Missing/incorrect `X-Admin-Confirmation` |
| `ROLE_NOT_ALLOWED` | 403 | RBAC denial |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | Signed webhook failed verification or timestamp window |
| `WEBHOOK_REPLAY`, `DEPOSIT_EXPIRED` | 4xx | Duplicate or expired event |
| `PAYMENT_PROVIDER_ERROR` | 502 | Provider unavailable; no settlement applied |
| `LEDGER_IMBALANCE`, `RECONCILIATION_MISMATCH` | 500 | Integrity invariant tripped (page the on-call) |
| `TOO_MANY_REQUESTS` | 429 | Rate limit; honour `Retry-After` |
| `NOT_FOUND` | 404 | Unknown route |

### Administrative confirmations

Destructive admin routes additionally require `X-Admin-Confirmation` set to the **target id**:

| Route | Confirmation value |
|---|---|
| `PATCH /admin/users/:id/status` · `PATCH /admin/users/:id/role` | `:id` (user id) |
| `POST /admin/ledger/adjustments` | `walletId` from the body |
| `POST /admin/transfers/:id/reverse` | `:id` (transfer id) |

(Adjustments and reversals also require `Idempotency-Key`.)

## Pagination, sorting, filtering

List endpoints accept `page` (default 1), `pageSize` (default 20, max 100), `sortOrder`
(`asc|desc`, default `desc`), and resource-specific filters (e.g. `status`, `currency`,
`dateFrom`, `dateTo`, `walletId`). Unknown query parameters are rejected `400 VALIDATION_ERROR`
(strict schemas — silently ignored filters are how wrong reports get shipped).

## Rate limiting

In-process (or Redis-backed, see `RATE_LIMIT_REDIS`). Defaults:

| Bucket | Limit |
|---|---|
| Global | 600 req / 15 min / IP |
| Login | 10 per 15 min (successful logins not counted) |
| Registration | 5 per hour / IP |
| Password reset & verification emails | 5 per hour / IP |
| Financial writes | 60 per minute / user |

Exceeding any bucket yields `429` with `Retry-After`. In tests (`RATE_LIMIT_ENABLED=false`) the
limiters are inert.

## Health, metrics and docs

- `GET /health` (and `/health/live`) — liveness, no dependencies.
- `GET /health/ready` — readiness: PostgreSQL `SELECT 1` + Redis probe when `QUEUE_ENABLED=true`;
  `503` while degraded.
- `GET /metrics` — Prometheus text format; gated by `METRICS_ENABLED` and optional
  `METRICS_TOKEN` (constant-time comparison).
- `GET /docs` (Swagger UI) and `GET /openapi.json` — gated by `DOCS_ENABLED` (default on in
  development, **turn off in production** unless you want your contract public).

## CSV and statements

`GET /api/v1/wallets/:id/statement?format=csv`, `GET /api/v1/wallets/:id/transactions/export`
and transaction listing with `format=csv` return `text/csv` with a header row; formula-injection
safe (cells with `=`, `+`, `-`, `@` are prefixed with `'`). Receipts are available at
`GET /api/v1/transactions/:id/receipt`.

## Timestamps and locales

All timestamps are ISO-8601 UTC (`2026-11-11T12:34:56.789Z`, stored as `timestamptz`). Currency
formatting is presentation-layer: the API returns minor units and raw decimal strings; clients
format per locale.
