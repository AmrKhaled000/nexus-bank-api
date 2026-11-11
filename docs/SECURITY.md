# NEXUS BANK — Security

This document is both the controls catalogue and the operator guide. It assumes the deployment
notes in `docs/DEPLOYMENT.md` are followed. Nothing here is a guarantee of safety; it is a
description of the intended posture and its limits.

## Attacker model in one paragraph

We assume: (a) remote attackers with no credentials, (b) compromised customer credentials
(including stolen refresh tokens) trying to transact or take over accounts, (c) malicious
insiders limited to the permissions of their role, (d) integrity attacks on the API transport,
and (e) post-breach attackers holding the database dump. We do **not** model a fully compromised
host (root + process memory) or physical access to the server — those collapse every control.

## Credential security

- **Passwords** — Argon2id (`memoryCost 19456 KiB, timeCost 2, parallelism 1`, 32-byte output).
  Policy: ≥ 12 chars, three of four classes (lower/upper/digit/symbol), must not be derived from
  the email local-part or the name; `PASSWORD_REUSE` rejected on change; reset revokes all sessions.
- **PINs** — 6 digits, peppered with `PIN_PEPPER` (HMAC-SHA256) before Argon2id; 5 failed attempts
  lock the PIN for 15 minutes; lockouts emit `PIN_LOCKED` (HIGH) security events. PINs are
  verified outside financial transactions so a rollback cannot erase the signal.
- **TOTP 2FA** — `otplib`, 30s step, ±1 window, replay-protected per step (`totpLastUsedStep`),
  secret stored AES-256-GCM-encrypted (`ENCRYPTION_KEY`, 32-byte hex) in `totpSecretEncrypted`.
- **Refresh tokens** — 48 random bytes, base64url; only SHA-256 digests stored; delivered as
  HttpOnly `SameSite=Strict` cookie scoped to `/api/v1/auth` (`COOKIE_SECURE=true` in production).
  Rotation on every use; reuse ⇒ family revocation + `REFRESH_TOKEN_REUSE` (CRITICAL) event.
- **Verification/reset tokens** — 32 random bytes; SHA-256 at rest; single use; expiry checked
  inside the consuming transaction.
- **JWTs** — HS256, issuer/audience enforced, `typ` claim distinguishes access vs MFA tokens.

## Transport & browser hardening

- **Helmet** on every route; docs get a stricter CSP (no `objectSrc`, `frameAncestors 'none'`).
- **CORS** allowlist (`CORS_ORIGINS`); credentials allowed only from listed origins; disallowed
  origins rejected before reaching handlers.
- **HSTS/HTTPS** — `COOKIE_SECURE=true` mandatory in production (config fails otherwise).
- **Caching** — `Cache-Control: no-store` on all API responses (financial data).
- **Body limits** — `1mb` JSON, `32kb` urlencoded.
- **JSON escape** — `app.set('json escape', true)` serializes `<`, `>`, `&` to unicode escapes in
  JSON responses (reflected-XSS hardening for any client that misrenders).
- **`X-Powered-By` disabled**; `etag` disabled (prevents cache heuristics on signed responses).

## Request validation

- **Zod schemas, `.strict()` objects** on every route (unknown keys rejected).
- All path params validated (`cuid`), all query strings validated (pagination enums, ISO datetimes,
  ISO currency), all bodies policy-checked (password/PIN/amounts/enums).
- **Idempotency-Key** required for financial mutations; format-validated; payload fingerprint
  excludes secrets (`pin`, `password`, `code`) so replay doesn't depend on peppered material.
- **Mass assignment impossible**: DTOs are built field-by-field from explicit selects.

## Idempotency & transactional integrity

See `docs/FINANCIAL_LEDGER.md` §Idempotency. Financial-op + idempotency record commit together;
partial execution is structurally impossible. Replayed responses carry `meta.idempotentReplay`.

## Administrative controls

- RBAC with four roles; permissions mapped in `common/security/permissions.ts`; middleware +
  service-level assertions (defense in depth).
- Destructive actions additionally require `X-Admin-Confirmation` equal to the **target id**
  (user, wallet or transfer) and are written to the append-only `audit_logs` (immutable by trigger).
- Self-lockout is forbidden: admins cannot suspend/close/demote themselves.
- Sessions die on role/status change; password change revokes other sessions.

## Webhook integrity

- HMAC-SHA256 over `t=<unix seconds>.<raw bytes>` in `X-Nexus-Signature: t=…,v1=…`; constant-time
  compare; ±300s tolerance (`PAYMENT_WEBHOOK_TOLERANCE_SECONDS`).
- Raw bytes captured via `express.json({ verify })` — signature verifiable even when JSON parsing
  succeeds on a modified body.
- `(provider, eventId)` unique constraint = replay guard; amount/currency of the event are
  cross-checked against the local deposit before settlement; mismatches → `FAILED` event,
  CRITICAL security event, deposit untouched.

## Rate limiting & abuse controls

Login (5 failures ⇒ lockout), PIN lockouts, registration/password-reset throttles (5/h/IP),
financial writes (60/min/user), global 600/15min/IP, 429 + `Retry-After`. In-memory by default;
Redis-backed via `RATE_LIMIT_REDIS=true` + `REDIS_URL` for multi-replica (Redis becomes a hard
dependency — see DEPLOYMENT.md).

## Secrets & configuration

- `.env` is git-ignored; `.env.example` documents shape, never secrets. `.env.test` holds
  test-only values and is also git-ignored; CI writes it from the workflow file (test-only keys).
- Production config **fails to boot** when: `COOKIE_SECURE=false`, empty `CORS_ORIGINS`,
  `PAYMENT_PROVIDER=stripe` without Stripe keys.
- Rotation: `JWT_ACCESS_SECRET` rotates cheaply (access tokens are short-lived; refresh tokens
  are opaque digests and unaffected). `PIN_PEPPER` rotation invalidates every PIN (forcing
  PIN re-setup). `PAYMENT_WEBHOOK_SECRET` must be rotated in lockstep with the provider.
  `ENCRYPTION_KEY` rotation requires re-encrypting stored TOTP secrets.
- Grep your forks for hardcoded secrets; never paste real keys into issue trackers or screenshots.

## Logging & privacy

- pino JSON logs with `request.id`, `userId` (when authenticated), route template, status, latency.
- Redaction: passwords, PINs, TOTP codes, refresh/access tokens, authorization headers,
  idempotency keys, raw webhook bodies — never logged.
- IPs are stored only HMAC-hashed (`IP_HASH_SECRET`).
- Email dispatchers: development/test use the `.dev-mail` file transport (git-ignored, mode 600);
  production refuses to boot without `SMTP_HOST`.

## Dependency & build hygiene

- `npm ci` everywhere (lockfile-verified). Dependabot-style review recommended.
- TypeScript strict + `noUncheckedIndexedAccess`, strict zod objects, `npm run build` in CI.
- ESLint `@typescript-eslint/no-unused-vars` as errors; zero-warning goal for `no-console` outside
  startup/maintenance paths.
- `Math.random` banned for security-sensitive values via ESLint rule; `crypto.*` only.

## Known gaps (be honest internally)

- **No HSM/KMS** — keys live in env vars; envelope encryption of `ENCRYPTION_KEY` is on your
  platform (vault sidecar, sealed secrets, managed KMS) in real deployments.
- **No SIEM integration** — `security_events` and audit logs are queryable via staff endpoints;
  wiring them into a SIEM is deliberate, not yet built.
- **No refresh-token device fingerprinting** beyond deviceName/userAgent stored (not enforced).
- **No anomaly-based fraud scoring** — velocity checks are naive thresholds.
- **No mTLS** for provider callbacks (HMAC is the auth).
- **Single logical writer** — advisory locks, not distributed consensus; multi-datacenter writes
  are out of scope.
- **Session revocation is polled** on each request (cheap), not pushed.

## Incident response (minimum viable)

1. Freeze: lower `SUSPICIOUS_AMOUNT_MINOR` alerting, review withdrawals in `UNDER_REVIEW`,
   confirm `AUTO_APPROVE_WITHDRAWALS=false` (default), narrow limits via `transaction_limits`;
   stop the payout worker to halt outbound payouts.
2. Revoke: global `logout-all` for impacted users (or suspend accounts); rotate
   `JWT_ACCESS_SECRET` if token theft suspected.
3. Investigate: `GET|POST /admin/reconciliation/run`, `/admin/audit-logs`, `/admin/security-events`,
   `/admin/withdrawals` (status sweep), `/admin/ledger/trial-balance`.
4. Remediate: reverse fraudulent transfers (`/admin/transfers/:id/reverse`), pin-reset affected
   users, force password resets, file the postmortem.
5. Notify affected users through the normal account-update notification path if applicable.
