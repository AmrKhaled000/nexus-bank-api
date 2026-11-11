# NEXUS BANK — The Financial Ledger

How money moves, invariants, and how to read a journal. Cross-reference
`docs/DATABASE_DESIGN.md` for the tables and triggers.

## The one rule

> **No `journal_entry` is valid unless the sum of its debit lines equals the sum of its credit
> lines, using at least two accounts, in a single currency. This is enforced by PostgreSQL at
> COMMIT, not just by application code.**

Money is represented exclusively as **integer minor units** (`BIGINT`, suffix `Minor`). One USD
= `100` minor. A `120.00 USD` deposit is `12000`. There are no floats anywhere in the financial
path. JSON responses expose both the minor-unit integer and a formatted decimal string.

## Chart of accounts

| Code | Type | Normal balance | Meaning |
|---|---|---|---|
| `SYS:CASH:<CUR>` | ASSET | DEBIT | Custodial cash position (simulated) |
| `SYS:PAYOUT_CLEARING:<CUR>` | ASSET | DEBIT | Funds that left customer liability but have not settled at the bank yet |
| `SYS:FEE_REVENUE:<CUR>` | REVENUE | CREDIT | Fee income |
| `SYS:ADJUSTMENT_EXPENSE:<CUR>` | EXPENSE | DEBIT | Debit side of administrative credits (the bank "pays" the customer) |
| `SYS:ADJUSTMENT_INCOME:<CUR>` | REVENUE | CREDIT | Credit side of administrative debits (the bank "claws back") |
| `WALLET:<walletId>` | LIABILITY | CREDIT | What the bank owes one customer wallet |

Equation of the books per currency:

```
Σ(debit balances) − Σ(credit balances) = 0  (trial balance)
```

i.e. total debits posted == total credits posted, per currency, always. `GET /api/v1/admin/ledger/trial-balance`
computes this live from `journal_entry_lines`.

## Normal balances and sign

- ASSET and EXPENSE accounts increase with **DEBIT**.
- LIABILITY, EQUITY and REVENUE accounts increase with **CREDIT**.
- A wallet is a LIABILITY of the bank to the customer: deposits **credit** it, withdrawals
  **debit** it.
- Wallet `balanceMinor` projection = `Σ(creditMinor − debitMinor)` over that wallet's ledger
  account (SQL triggers verify equality at COMMIT).

## Wallet projection and holds

`wallet_accounts.balanceMinor` is the spendable-ish balance; `heldMinor` is reserved by
`ACTIVE` withdrawals (`amount + fee`). Available = balance − held. Holds exist so that a customer
cannot double-spend funds that are already committed to a payout; the database re-checks at
COMMIT that `heldMinor` equals Σ active hold amounts for the wallet, and that `heldMinor ≤ balanceMinor`.

## Worked examples

Amounts in minor units; negative balances impossible; all journals shown as `account | DEBIT | CREDIT`.

### 1) Deposit 1000.00 USD into Alice's wallet (simulated provider settles)

```
SYS:CASH:USD              | 100000 |
WALLET:<alice-usd>        |        | 100000
```

Effect: Alice's wallet liability grows, the bank's cash position grows symmetrically. No income.

### 2) Alice transfers 75.00 USD to Bob

```
WALLET:<alice-usd>        | 7500   |
WALLET:<bob-usd>          |        | 7500
```

Fee policy TRANSFER is 0 for now (flat 0, 0%); the same entry shape carries
`SYS:FEE_REVENUE:USD | fee` when fees are enabled.

### 3) Alice withdraws 120.00 USD (fee 0.50)

Hold created first: `heldMinor += 12050` (amount + fee), no journal yet. Money only moves when the
payout succeeds:

Hold consumed, then:

```
WALLET:<alice-usd>        | 12050  |
SYS:PAYOUT_CLEARING:USD   |        | 12000
SYS:FEE_REVENUE:USD       |        | 50
```

Effect: liability to Alice drops by 120.50; payout clearing grows by 120.00; fee revenue by 0.50.

### 4) Admin credits Alice 25.00 (goodwill)

```
SYS:ADJUSTMENT_EXPENSE:USD| 2500   |
WALLET:<alice-usd>        |        | 2500
```

### 5) Reversing a transfer (admin)

No new "negative" entries are invented: the original journal's lines are mirrored with opposite
directions and tagged `reversesEntryId` to the original entry (unique). The original transaction
is set `REVERSED`; balances return exactly.

## Invariants checked twice (domain + database)

| Invariant | Domain check | Database check |
|---|---|---|
| Entry balances, ≥ 2 lines, ≥ 2 accounts | `LedgerService.post` | `nexus_assert_journal_balanced` (deferred trigger) |
| All lines in journal's currency | account fetch check | same trigger (`NEXUS_JOURNAL_CURRENCY_MISMATCH`) |
| Projection == ledger sum | none (single writer) | `nexus_assert_wallet_account` (`NEXUS_BALANCE_DRIFT`) |
| `heldMinor` == Σ active holds | none (single writer) | `nexus_assert_wallet_account` (`NEXUS_HOLD_DRIFT`) |
| Held ≤ balance | domain (`INSUFFICIENT_FUNDS`) | `nexus_assert_wallet_account` |
| Negative money impossible | CHECK constraints | `journal_lines_amounts_nonnegative`, `*_amount_positive`, `wallet_accounts_balance_nonnegative` |

Reconciliation (`GET|POST /api/v1/admin/reconciliation`) re-runs the checks out-of-band and reports
trial balance, projection drift, expired deposits, stuck withdrawals, failed webhooks and stale
idempotency keys.

## Idempotency of financial operations

Every mutating financial endpoint requires `Idempotency-Key`. The record is created in the same
transaction as the financial effect. Replay returns the stored response with
`meta.idempotentReplay: true` and the same resource id; a different payload under the same key is
rejected with `422 IDEMPOTENCY_CONFLICT`. Keys expire after 24h (plus a cleanup pass on boot).

## Failure semantics

- **Deposit expires** (provider never settles): deposit `EXPIRED`, transaction `CANCELLED`, zero
  ledger effect. Any funds that arrive later via a late webhook are still settled — the webhook
  path does not consult expiry.
- **Payout fails explicitly** (simulated provider rejects): withdrawal `FAILED`, hold released,
  transaction `FAILED`, zero ledger effect.
- **Payout result unknown** (timeout/5xx): withdrawal stays `PROCESSING`, hold kept; admin retries
  with `POST /api/v1/admin/withdrawals/:id/retry-payout`.
- **Ledger posting fails inside a transaction**: the whole operation rolls back, including the
  idempotency record; nothing partial persists.
