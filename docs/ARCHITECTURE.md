# StockCM — Architecture and Decisions

Status: Phase 1 foundation (in progress). Reference: the StockCM SRS (16 Nov 2026)
and the revised master prompt. Where they differ, the master prompt wins.

## 1. Decisions taken (17 Nov 2026)

| Topic | Decision | Consequence |
| --- | --- | --- |
| Costing | Weighted average | Stock value is tracked as an integer total in XAF; COGS is proportional, so rounding never drifts and value hits exactly 0 at zero stock (`src/domain/costing.ts`). |
| Offline oversell | Allow and flag (per-shop setting `allow_and_flag` or `block`) | Counter is never blocked; negative stock raises a manager alert. Oversold units are costed at the last known unit cost. |
| Offline limit | 30 days, then read-only | A sync issues a licence token valid for `min(paid period end + grace, last sync + 30 days)`. Past that the device is read-only until it syncs. Unsynced data is never promised to be recoverable. |
| Tax | Optional per-product rate (basis points) | Shown on receipts and reports. No legal invoice-compliance claim until reviewed. |
| Plan prices | Starter 2,500 / Business 5,000 / Pro 10,000 FCFA | Stored in the `plans` table, editable by platform admin, not in code. Supersedes the SRS table. |

## 2. Principles

1. **Ledgers are the source of truth.** `stock_movements`, `financial_transactions`,
   `customer_account_entries`, `supplier_account_entries`, `cash_movements`, `audit_logs`
   are append-only (database triggers block UPDATE and DELETE). A correction is a new row
   linked by `reverses_id`.
2. **Balances are derived.** Stock levels and customer balances are projections; they can
   be rebuilt from the ledgers.
3. **Money is integer XAF.** No decimals, no floating point in totals.
4. **Quantities are integer base units.** 1 carton = 24 bottles is a `factor`.
5. **Business rules live in `src/domain`**, pure TypeScript with no UI or database imports,
   so the same rules run on the device and (later) on the server for validation.
6. **IDs are created on the device (UUID)** so offline work never collides, and every
   offline operation is idempotent by its id.
7. **A manual MoMo / Orange entry is only `recorded`.** `provider_verified` requires a
   provider reference from a verified webhook (database check constraint).

## 3. Layers

```
src/domain      pure rules: money, units, costing, payments, cash, inventory   (done, tested)
src/data        Dexie (IndexedDB) repositories + outbox                        (Phase 4)
src/sync        outbox upload, pull by cursor, conflict handling              (Phase 4)
src/features    screens per module                                            (Phases 1-3)
supabase/       migrations, RLS, Edge Functions (sync, billing webhook)
```

## 4. Sync conflict policy

| Record kind | Policy |
| --- | --- |
| Stock movements, sales, payments, financial transactions, account entries | Append-only. Never overwritten, never last-write-wins. Duplicates skipped by id. |
| Stock level | Sum of movements. Negative stock is allowed under `allow_and_flag` and raises an alert. |
| Product name, description, category | Latest edit wins; the earlier value stays in the audit log. |
| Prices, units, factors | Owner/manager only. If two edits conflict, a `sync_conflicts` row is created and an owner resolves it. |
| Stock transfers | Two linked movements (out, in). In transit until the receiving shop confirms, so stock is never counted twice. |
| Subscription / licence | Server only. Devices never write it. |

The server re-validates totals during sync; client-calculated totals are never trusted
(database checks already enforce `total = subtotal - discount + tax` and
`collected + outstanding = total`).

## 5. Reporting definitions

Revenue (sales total) is not cash collected. Receivables are open customer balances.
Gross profit = revenue − cost of goods sold (weighted average). Operating profit = gross
profit − operating expenses. This is an operating measure, not fully compliant accounting
net profit.

## 6. Status of the original SRS

All FR-01…FR-28 and NFR-01…NFR-14 remain in scope. Phase 1 covers the domain rules, the
schema and tenant isolation. Nothing below is claimed complete until its tests pass.

## 7. Known limitations (honest list)

- The Postgres stock projection updates quantity only. Weighted-average value, per-sale COGS
  and moving-average maths run in the sync Edge Function (not written yet).
- Write policies exist for catalogue, stock, sales, customers, expenses and ledger inserts.
  Policies for purchases, goods receipts, cash sessions and approvals' reads/decisions
  arrive with their phases.
- No Edge Functions, payment-aggregator integration or admin dashboard yet.
- Row-level security is written but not yet tested against a live Supabase project; the
  cross-tenant test (scenario 13) needs one.
- Multiple-shop UI, batches/expiry UI, receipts, printing and reports are not built.
- Nothing has been benchmarked on real low-end devices.
- Cameroon data-protection, cybersecurity and tax obligations have not been legally reviewed.

## 8. Synchronisation (Phase 4)

**Upload.** Every local write is queued in the outbox in *groups*: a sale and its lines, stock
movements, payments and debt form one group; a product with its units and opening stock form
another. A group is sent to `sync_push` and applied atomically. Operation ids are recorded, so a
repeat (lost reply, retry, duplicate request) is skipped and never applied twice. The server
re-checks every sale when it commits (`check_sale_consistency`): lines must add up to the total,
recorded payments to `collected`, customer debt to `outstanding`, stock movements to the sold
quantities, and unit conversions to the product's factors. A sale that fails is refused whole.

**Failure handling.** Network or expired-session errors keep the data and retry with back-off
(5 s doubling to 15 min; a manual "Sync now" ignores the wait). Server refusals mark the group
`rejected` (never retried automatically); clashes with another device mark it `conflict`
(currently: duplicate barcode, resolved by removing the barcode). Every attempt is logged.

**Download.** `sync_pull` is a change feed ordered by `changed_at`. Devices ask from the last
cursor minus a 2-minute overlap (rows committed slightly late are not missed; repeats are
harmless). A new or replacement device simply pulls from the beginning.

**Stock after sync.** Stock and weighted-average value are a projection rebuilt by replaying the
movements in one fixed order (time, then stock-in before stock-out, then id), so devices holding
the same ledger always show the same stock and value, even after selling the same product offline.

**Status shown to the user:** synchronised, N waiting, synchronising, failed, conflict. A warning
appears after 48 hours unsynchronised and after 30 days without any sync.

### Sync limitations
- The 30-day offline limit is detected and shown but not yet enforced (read-only mode arrives with licensing).
- Product/customer *edits* and stock transfers do not exist yet, so their conflict rules are not exercised.
- Sale-line cost of goods is fixed when the sale is made on a device; after offline sales on
  several devices the replayed ledger value can differ slightly from the per-line figure.
- The live end-to-end test (`src/sync/live.e2e.test.ts`) needs a test user and was not run.
- Existing pre-release dev databases lose their old outbox on upgrade (schema v3).

## 9. Money module (Phase 3)

- **Debt repayment** = a ledger entry (`debt_repayment`, money in) + a payment + allocations to the
  sales it settles (oldest first, or chosen) + a negative customer-account entry. Original sales are
  never changed. The server refuses a repayment whose pieces disagree (`check_payment_consistency`).
- **Policy: repayments are never refused for being too large.** If two phones both take the same
  repayment offline, both are kept (the money was received); the customer's balance goes negative and
  is shown as a credit in their favour.
- **Expenses** are one record plus one negative ledger entry. Reports sum the expense records only, so an
  expense is never counted twice. **Till deposits/withdrawals** are owner-only and need a reason.
- **Cash sessions:** expected cash is computed from the ledger (cash only, this cashier, this shop,
  since opening). Closing writes an immutable `cash_session_closures` row with the difference;
  one closing per session (a second one from another device is flagged as a conflict).
- **Reports** (`src/domain/reports.ts`) keep revenue, money collected, receivables, COGS, gross profit and
  operating profit separate, and are always computed from the records, never stored. Operating
  profit is not accounting net profit. Profit figures are hidden from roles without `reports.operational`.

### Money limitations
- Not built: returns/refunds/cancellations, supplier purchases and balances, expense receipts, per-employee and per-product reports, PDF/Excel export, inventory valuation report.
- Reports read whole tables into memory; fine for a small shop, to be indexed by date for large histories.
- Cash sessions track one open session per user per shop; a session left open is not auto-closed.
