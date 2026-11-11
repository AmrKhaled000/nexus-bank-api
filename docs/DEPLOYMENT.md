# NEXUS BANK — Deployment

## Environment matrix

| | Development | Test (CI) | Production |
|---|---|---|---|
| `NODE_ENV` | `development` | `test` | `production` |
| Database | local `nexus_bank` | `nexus_bank_test` | managed PostgreSQL 17 |
| Docs (`/docs`) | on | on (irrelevant) | **off** (`DOCS_ENABLED=false`) |
| `COOKIE_SECURE` | false | false | **true** (required, enforced) |
| `CORS_ORIGINS` | localhost | localhost | explicit allowlist (required) |
| Email | `.dev-mail` file transport | file transport | SMTP required (boot fails otherwise) |
| Payouts | simulated | simulated | **simulated** (no real rails exist by design) |
| Rate limit store | memory | disabled | Redis (`RATE_LIMIT_REDIS=true`) or memory + proxy limits |
| Queue | inline or BullMQ+Redis | inline | BullMQ + Redis recommended |

## Production checklist

1. **Configuration**
   - All secrets from a manager (not baked into the image): `JWT_ACCESS_SECRET` (≥ 32 random
     bytes), `ENCRYPTION_KEY` (hex-32), `PIN_PEPPER`, `IP_HASH_SECRET`, `PAYMENT_WEBHOOK_SECRET`.
   - `COOKIE_SECURE=true`, `CORS_ORIGINS=https://nexusbank.example.com`, `DOCS_ENABLED=false`.
   - Terminate TLS for the deployment domain — e.g. the fictional `nexusbank.example.com` used in
     this repository's documentation — at your edge (see the example tree below).
   - `SEED_PASSWORD` unset/empty — the seed refuses to run in production regardless.
   - `METRICS_ENABLED=true` with `METRICS_TOKEN` if metrics are scraped across networks.
2. **Database**
   - `DATABASE_URL` points at a TLS-required role with least privilege
     (`sslmode=require`, own schema or dedicated DB per environment).
   - Migrations applied via `npm run prisma:deploy` (never `migrate dev`) before rollout.
   - Backups: PITR (WAL) + encrypted dumps; tested restore procedure documented.
3. **Boot behavior**
   - API refuses to start if PostgreSQL is unreachable (fails the readiness probe first).
   - Worker retries BullMQ jobs with backoff; a stuck `PROCESSING` payout is visible via
     `GET /admin/withdrawals?status=PROCESSING` and resolved via `retry-payout`.
4. **Network**
   - Terminate TLS at your proxy/LB; HSTS on; LB health check → `GET /health/ready`.
   - `/metrics` reachable only from the monitoring network (token + firewall).
   - Webhook URL is public but requires a valid signature — do not add IP allowlists that
     break provider rotation without coordination.
5. **Supply chain**
   - CI builds the image from the lockfile; scan with your container scanner; run as non-root
     (`Dockerfile` already drops privileges); pin base images by digest in your fork.
6. **Observability & alerts** (minimum)
   - Burn alerts on: 5xx rate, `ledger_journal_entries_total` flatline, reconciliation issues
     (`/admin/reconciliation` non-empty `issues`), `webhook_events_total{status="failed"}`,
     `withdrawals stuck in PROCESSING`, DB connections near pool limit.
   - Log shipping to your SIEM; `security_events` polled by a scheduled job.

## Docker

```bash
docker build -t nexus-bank-api .
docker run --rm -p 3000:3000 --env-file .env nexus-bank-api
```

`Dockerfile` is multi-stage: `npm ci` (full) → prisma generate + `tsc` build + `npm prune
--omit=dev` → minimal runtime (non-root `nexus` user, healthcheck on `/health`).

Image contents: `dist/`, production `node_modules`, `prisma/` (schema + migrations + seed for
one-shot admin jobs). Tests, sources, docs and Postman are excluded via `.dockerignore`.

## Docker Compose (demo)

```bash
docker compose up --build                # db, redis, migrate, api, worker
docker compose --profile demo up --build # + seed demo data
docker compose --profile observability up # + prometheus (:9090) + grafana (:3001, admin/admin)
```

The compose file is a **demo topology** (credentials `postgres/postgres`, `admin/admin`, in-repo
secrets). Do not expose it to the internet. Services: `db` (Postgres 17, volume `nexus-pgdata`),
`redis` (7-alpine), `migrate` (one-shot `prisma migrate deploy`), `seed` (one-shot, `demo`
profile), `api`, `worker`, `prometheus`, `grafana`.

## GitHub Actions CI

`.github/workflows/ci.yml` runs on push/PR: checkout → Node 20 → `npm ci` → prisma generate →
typecheck → lint → unit tests → integration tests against a PostgreSQL 17 service container →
`npm run build` → verifies the OpenAPI/Postman exports parse.

Extend with: image build/push, `npm audit --omit=dev`, SBOM generation, e2e job against the
compose stack, deployment gates (environment protection rules) for your fork.

## Scaling notes

- **Stateless API** behind a load balancer; sessions live in PostgreSQL, not memory — any replica
  can serve any request (refresh rotates are serialized by row locks).
- **Payouts** funnel through the queue consumer; run **one** worker per environment (or shard by
  currency) to avoid payout thundering herd. With `QUEUE_ENABLED=false`, the API executes payouts
  inline (fine for dev/demo).
- **Advisory locks** serialize mutations per user; hot rows (system accounts like
  `SYS:CASH:USD`) are the natural contention point under load — budget `maxWait` and monitor lock
  waits; move to per-currency sharded counters if you exceed ~1k financial tx/s.
- **Connection pool**: default Prisma pool ≈ `num_cpus * 2 + 1`; set `connection_limit` in the
  DATABASE_URL when running many replicas (`…?connection_limit=10&pool_timeout=20`).

## Disaster recovery drill

1. `pg_dump` latest backup into a scratch DB; apply migrations; run integration suite against it
   (`DATABASE_URL=… nexus_bank_test npm run test:integration`) — all green proves the restore.
2. Reconcile: `POST /admin/reconciliation/run` must report `healthy: true`.
3. Point a standby API at the scratch DB and exercise login + a transfer on test accounts.

## Common operational tasks

| Task | Command |
|---|---|
| Apply migrations | `npm run prisma:deploy` |
| Check migration status | `npm run prisma:status` |
| Seed demo data (non-production) | `npx prisma db seed` |
| Reconcile ledger | `POST /api/v1/admin/reconciliation/run` (SUPER/FINANCE) |
| Expire stale deposits now | runs automatically; worker also performs it |
| Export contract | `npm run openapi:export && npm run postman:export` |
| Drain payout queue | stop worker; items remain `ENQUEUED`; restart to resume |
