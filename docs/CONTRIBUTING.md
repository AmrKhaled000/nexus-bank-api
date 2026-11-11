# Contributing to NEXUS BANK

## Ground rules

1. **Correctness before cleverness.** If a financial behavior cannot be made obviously correct,
   it does not ship. Read `docs/FINANCIAL_LEDGER.md` before changing anything under
   `src/modules/ledger`, `src/modules/transfers`, `src/modules/withdrawals` or
   `src/modules/deposits`.
2. **Never weaken an invariant to make a test pass.** Tests encode the invariants
   (`tests/integration/*`); if one fails, the *code* is wrong or the invariant genuinely changed
   (in which case update the invariant, the migration and the docs together).
3. **No production credentials, ever.** `.env*` stays out of git; examples use obviously fake
   values; demo secrets are fine only when documented as demo credentials.
4. **Tests must actually run.** PRs that adjust tests to match broken behavior will be reverted.

## Development setup

```bash
npm ci
createdb nexus_bank            # or docker compose up -d db
npx prisma migrate deploy
npx prisma db seed
npm run dev
```

Pre-commit checklist:

```bash
npm run typecheck && npm run lint && npm test
npm run build
```

## Tests policy

- **Unit tests** (`tests/unit`): no database, no network; deterministic; test properties
  (“any positive amount parses”, “the fee rounds up”), not just happy paths.
- **Integration tests** (`tests/integration`): real HTTP + real PostgreSQL
  (`nexus_bank_test`). Sequential, file-scoped app context, `resetDatabase()` per test.
  Every new financial behavior needs at minimum: success path, invariant path (e.g. balance
  verified via `wallet_accounts`), and failure/idempotency path.
- Coverage is currently concentrated on the money paths; keep it that way — `npm run test:coverage`
  for a snapshot, but do not chase a global percentage with vacuous assertions.
- The integration suite **refuses** to run against any non-`nexus_bank_test` database. Do not
  weaken that guard.

## Database & migration policy

- Schema changes are **only** via `npx prisma migrate dev --name <change>`; never edit an applied
  migration.
- Additive changes preferred: new columns nullable or with defaults, backfill, then enforce.
- Money is `BIGINT` minor units. If you add a `DECIMAL`/`float`, the migration is rejected.
- New invariant ⇒ add it to SQL **and** document it in `docs/DATABASE_DESIGN.md`.
- Append-only tables stay append-only; if you need history mutation, write a new row with a
  compensating entry (see transfer reversal for the pattern).

## Security policy for changes

- New endpoint ⇒ Zod `.strict()` schema, `authenticate`/`requirePermission` as applicable,
  idempotency if it mutates financial state, audit event if it changes another principal's data,
  tests (integration) proving the RBAC boundary.
- New secret ⇒ update `.env.example` (fake value), `src/config/env.ts` (validation),
  `docs/SECURITY.md`; never hardcode.
- Anything touching tokens/PINs/passwords ⇒ review against `docs/THREAT_MODEL.md` S2/S3/S6.

## Style

- TypeScript strict; no `any` without a comment; `import type` where possible.
- ESLint is the standard (0 errors policy); Prettier formats (`npm run format`).
- Naming: `camelCase` values, `PascalCase` types, `UPPER_SNAKE` constants; files `kebab-case.ts`;
  modules colocate `*.service.ts`, `*.controller.ts`, `*.routes.ts`, `*.schemas.ts`, `*.dto.ts`.
- Error handling: throw `AppError` with a stable `ErrorCode`; map at the edge; never `catch` and
  swallow; no `console.log` outside startup/maintenance paths (use `logger`).

## Commit & PR hygiene

- Conventional-ish prefixes appreciated (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- PR description: what changed, why, which invariant(s) affected, test evidence (paste the
  `npm test` summary).
- Small PRs beat large ones; pure refactors separate from behavior changes.
- Breaking API changes ⇒ new `/api/vN` prefix or never (public API).

## When in doubt

Read the code: the ledger (`src/modules/ledger/ledger.service.ts`), the idempotency service
(`src/modules/idempotency/idempotency.service.ts`), and one complete vertical slice
(`src/modules/transfers/*`). They are intentionally readable; the test suite demonstrates the
intended behavior end to end.
