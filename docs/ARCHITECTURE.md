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

## 10. Purchasing and suppliers

Three events are kept apart because they happen at different times in a real shop:

| Event | Records | Effect |
| --- | --- | --- |
| Order | purchase, purchase lines | none: no stock, no debt |
| Goods receipt (all or part) | receipt, receipt lines, stock movements, supplier entry (`purchase_credit`) | raises stock and weighted-average value, creates the debt for what arrived |
| Payment | money entry (`supplier_payment`, out) + supplier entry (`payment`) | lowers the debt only |

- A delivery's cost is the share of the line cost for the units that arrived, using cumulative rounding,
  so partial deliveries add up exactly to the order cost (333 + 334 + 333 = 1,000).
- Order status (ordered, partly received, received) is derived from receipts, never stored.
- Never more received than ordered: refused on the device and again by the server (`check_receipt_consistency`).
  If two storekeepers record the same arrival offline, the second upload is refused and flagged for review,
  so stock is not counted twice.
- Paying a supplier is a `purchases.manage` action (manager or owner). Receiving goods needs `stock.receive`
  (storekeeper, manager, owner). A payment larger than the debt is refused.
- A supplier return takes stock out at its weighted-average cost and records the credit the supplier agrees to.
- Migration 0008 also added the manager permissions the app already assumed (`stock.receive`, `stock.count`,
  `payments.receive`, `products.read`), which the database had been missing.

### Purchasing limitations
- Not built: cancelling an order, editing an order, receipt photos or documents, purchase price history per supplier,
  reorder suggestions, supplier price comparison.
- A receipt is not tied to a specific supplier invoice document; the invoice number is a free-text field on the order.
- Supplier debts are recognised at receipt, not at invoice date.

## 11. Returns, refunds and cancellations

A return never edits the sale. It is a new record (`sale_returns` + lines) that points back at it, and
it does up to three separate things, each as its own ledger record:

1. **Stock:** goods fit to resell go back in (`return_in`, at the cost they left stock at). Damaged goods
   are refunded but not restocked, so their cost stays a cost.
2. **Debt first:** whatever the customer still owes on that sale is written off (a negative `reversal` entry).
3. **Money last:** only the remainder is refunded (`refund`, money out, method chosen), and never more than the
   customer really paid for that sale (at the till plus later repayments, minus refunds already paid).

- Partial returns use cumulative rounding, so 1 + 1 + 1 returns of a 999 FCFA line give back exactly 999.
- A **cancellation** is a return of everything left on the sale (it must cover everything).
- Sale status (complete / partly returned / returned / cancelled) is derived from the returns, never stored.
- A refund entered by hand is `recorded`, never provider-verified.
- **Approval:** only a manager or the owner can process a return. A cashier files a request (checked up front so
  it cannot be impossible); a manager approves (which performs the return) or rejects with a reason. A decision is
  its own immutable record, one per request.
- **Exchange** is a return followed by a new sale; there is no combined screen yet.
- **Reports:** returns reduce revenue and cost of goods in the period the goods came back; refunds are
  money out and are deducted from "money collected".
- **Server** (`check_return_consistency`, migration 0009): lines add up, refund + debt = total, money and customer
  entries match, stock put back matches, never more returned than sold, never more refunded than paid, never
  more debt written off than was owed. If two managers process the same return offline, the second is refused.

### Returns limitations
- No combined exchange screen; no store-credit / voucher refunds; no returns without the original sale.
- Returns after a customer was already refunded through another route are limited to what the ledger shows.
- Approval requests are checked when filed and again when approved, but a request can wait for a manager indefinitely.

## 12. Staff PIN login, registered devices and sessions

**Who signs in how.** The owner signs in with a phone number and SMS code. Staff (manager, cashier, storekeeper)
sign in with a PIN on a device the owner has registered. A successful staff login gives a normal Supabase session for
that person, so roles, row-level security and the audit trail apply to them exactly as before.

**Registering a device.** The owner creates a one-time enrollment code (10 characters, valid 15 minutes, used once;
only its hash is stored). The new device redeems it and receives a random secret; only the secret's hash is stored.
A device can be revoked at any time: its secret stops working and sync is refused.

**PIN checking happens on the server** (`verify_staff_pin`, called only by the `staff-auth` Edge Function):
- PINs are 4 to 6 digits and bcrypt-hashed. Sequences (1234), repeats (0000) and common PINs are refused by both the
  app and the database.
- 5 wrong PINs in a row lock the person for 5 minutes, doubling per further wrong PIN up to an hour. The owner can unlock.
- More than 20 wrong PINs from one device in 10 minutes throttles the whole device.
- A wrong PIN, an unknown person and an inactive person all get the same answer. Everything is written to the audit log.

**Minting the session.** After a correct PIN the Edge Function creates a session through the Auth admin API (a single-use
link verified on the server). No password exists for staff logins. The service-role key never leaves the function.

**Session controls.**
- The device locks after 5 minutes idle (and after a long gap, e.g. a closed tab). Unlocking needs the PIN again.
- After 12 hours the server must confirm the person again (when online).
- Deactivating a staff member deletes all their sessions at once and blocks their login.
- Owner-only actions: add staff, set or reset a PIN, deactivate, unlock, create a device code, revoke a device.

**Offline.** Unlocking a device that was already signed in works offline: the PIN is checked against a salted PBKDF2
verifier kept on the device (the PIN itself is never stored), with its own lockout.

### Staff login limitations (honest list)
- **Switching to a different person needs the internet.** Offline, only the person already signed in can unlock. A
  server-issued session is what attributes records to a person, so we do not let a device pretend to be someone else offline.
- The local lockout counter can be reset by someone who clears this browser's storage. It only protects an unattended
  device; it does not protect against someone with full control of the device.
- The device secret is kept in browser storage, so a script injected into the app (XSS) could read it. Keep the app free
  of third-party scripts.
- Per-person limits by plan (number of staff) are not enforced yet; that comes with subscriptions.
- The full end-to-end flow (`src/auth/staff.live.e2e.test.ts`) needs an owner test login and has not been run.

## 13. Subscriptions, billing, licensing and read-only mode

**States.** trial / active: full use. After the paid period ends there is a **7-day grace period** (setting `grace_days`):
full use with a warning. After that the business is **read-only**: it can still view and export everything but no new
records can be created. **Nothing is ever deleted** because a subscription lapsed. A suspended account is also read-only.

**Enforced on the server, mirrored on the device.**
- Database triggers (`SB402 subscription_expired`) refuse new business records once grace has ended. A sync that hits
  this keeps the data and retries after renewal. Plan limits for shops, staff and products are triggers too (`SB403`).
- A **signed licence** (ES256) is issued by the `licence` Edge Function and verified on the device with a public key, so the
  rules also work offline. It carries the plan, limits, period end and grace end, and is valid until the **earlier** of
  grace end and "issued + 30 days". So a device must sync every 30 days (read-only otherwise: "sync required", which does
  not mean unpaid), and a lapsed subscription stops new records by itself even with no connection. A device clock set
  backwards is noticed. Closing the till is always allowed.

**Pricing (all in the database, editable without changing code).** Plans live in `plans` (initial proposals: Starter 2,500,
Business 5,000, Pro 10,000 FCFA/month; Enterprise by quote). Terms live in `platform_settings.billing_terms`
(proposal: 1, 3, 6 months and 12 months, with 1 and 2 free months for paying 6 and 12). Renewing early extends from the
current end; renewing late starts from today. An **upgrade** is effective at once and costs the price difference for the
days left, rounded up. A **downgrade** is scheduled for the next renewal and is refused while usage exceeds the lower
plan's limits. During the trial a plan can be changed freely.

**Paying.** The owner creates a payment (amount computed by the database, a reference like `STK-XXXXXXXX`). It stays
`pending` until confirmed in one of two ways, and **only the server can do this**:
1. **Provider webhook** (`billing-webhook` Edge Function): the message must carry a valid HMAC-SHA256 signature made with a
   shared secret; the amount must equal what was asked for; a provider reference can never be used twice; a retried
   webhook never extends the subscription twice. Recorded as `provider_verified`.
2. **Platform admin** (`admin_confirm_payment`): for money received by hand, with a written note of the proof. Recorded as
   `recorded` (never `provider_verified`).
A confirmed payment extends the subscription, issues an invoice (`INV-YYYY-000001`) and writes an immutable event log.

### What you must set up before taking real payments (I cannot do these for you)
- **A payment provider / aggregator** account for MTN MoMo and Orange Money, and a small adapter that turns its callback
  into the signed message above. Nothing in this repository calls a real provider yet.
- **Merchant numbers** the owners send money to (until an aggregator is live), in `platform_settings`:
  `update platform_settings set value = '{"mtn_momo":"6XXXXXXXX","orange_money":"6XXXXXXXX"}' where key = 'merchant_numbers';`
- **Your first platform admin:** see section 14 (it needs a role, and the admin must set up two-step verification).
- **The webhook secret** (to give the provider): as that admin, call `select admin_webhook_secret();`

### Billing limitations (honest list)
- No real aggregator integration, no automatic USSD prompt: payment is "send money with this reference, then it is confirmed".
- Confirming manual payments and editing plans/prices is done in the admin app (section 14).
- Renewal reminders appear in the app (5 days, 2 days, then daily in grace) and staff can send WhatsApp reminders by hand (section 17). Automatic WhatsApp/SMS is not built.
- Invoices are records with a number, not PDFs; no tax invoice format has been reviewed for Cameroon.
- Per-staff limits are enforced on creation and reactivation; the existing staff list is not trimmed on a downgrade.
- The full flow with a real owner login (`src/billing/billing.live.e2e.test.ts`) has not been run.

## 14. Platform administration (the operators' dashboard)

A separate app (`admin.html`, built with `npm run build:admin` into `dist-admin/`; `npm run dev:admin` to develop). It is
hosted apart from the shop app: no service worker, no offline cache, `noindex`, its own session kept in `sessionStorage`
(gone when the tab closes). Put it on its own address and, ideally, behind an IP allow-list.

**Who may do what** (`platform_admins.role`, enforced in the database by `admin_check(perm)`, mirrored in `src/admin/permissions.ts`
with a test that fails if the two ever differ):

| Role | Can |
|---|---|
| `super` | everything, incl. system settings and revealing the webhook secret |
| `finance` | overview, payments (confirm / reject), extend subscriptions, plans and prices, revenue |
| `support` | overview, businesses (search, suspend / reactivate), support sessions, sync problems, audit log |

**Protection**
- Every admin function demands a signed-in user who is in `platform_admins` AND whose session is `aal2` (a TOTP code was
  entered). A password alone gets nothing. The first sign-in enrols an authenticator app. 15 minutes idle signs out.
- Admins are not members of any business, so row-level security already hides every shop's sales, customers and money.
  The admin functions only return operational metadata (counts, plan, status, devices, sync problems).
- To see one business's details (owner phone, devices, staff list, sync problems, last actions) the admin must open a
  **support session**: a written reason (10+ characters), valid 1 hour, ended on request. It is logged, and the business
  owner sees it in the app (More tab, "StockCM support access") with the reason.
- Suspending, reactivating, extending, confirming/rejecting payments, plan edits, setting changes, support sessions and
  secret reveals all go to `admin_audit_logs`, which cannot be updated or deleted (trigger). Suspension remembers the status
  before it, so reactivating restores it.
- Settings are validated server-side with a whitelist (ranges, formats, lengths); unknown keys are refused.

**Reaching the shop app:** `public_notices()` (callable without signing in) returns the announcement, maintenance notice and
feature flags. The app caches them for offline use and shows banners; notices inform only and never block selling.
Devices report refused sync events (`report_sync_issue`: kind + the server's own error text, no business data) so support can
see which shops need help; the report is marked resolved when the event finally goes through.

**Creating the first administrator (you must do this, it cannot be self-service):**
1. Create the user in Supabase Authentication (a real mailbox you control, a long unique password).
2. `insert into platform_admins (user_id, role) values ('<that user id>', 'super');`
3. Sign in to the admin app and scan the QR code with an authenticator app. Add `finance` / `support` colleagues the same way.
4. Enrolling an authenticator is only possible once signed in; if you lose the device, remove the factor in the Supabase dashboard.

**Tested:** 40-odd checks run against the live database inside a rolled-back transaction (non-admin refused; password-only
refused; each role allowed/refused per function; support detail refused without a session and after it ends; suspension
restores the prior status; every setting validation; audit log immutable; admin cannot read shop data through RLS; owner sees
support access). The screens were exercised in a browser with an in-memory fake API (`?dev=1`, compiled out of production).

### Admin limitations (honest list)
- Not yet exercised with a real admin login and a real authenticator (needs the user created above).
- "MRR" is an estimate: list price of every paying plan; discounts and free bonus months are not netted out.
- No per-admin management screen: roles are assigned in SQL. No IP allow-list or rate limiting in the app itself (do it at the host).
- Sync issues are shown as counts and per-business lists; there is no separate triage queue yet.
- WhatsApp/SMS sending is not built; the templates are stored for when it is.

## 15. Several shops

- **Who sees which shop:** the owner sees every active shop; staff see only the shops the owner ticked for them
  (`membership_shops`, changed with `set_member_shops`, owner only). A new shop starts owner-only (least privilege). Someone
  with no rows is never locked out: they get the first shop.
- **Working in a shop:** the header shows a shop switcher when a person may use more than one. The choice is remembered per
  person on the device and the screen is rebuilt on a switch, so a half-filled sale cannot leak into another shop. Stock,
  cost, sales summaries and cash sessions are all per shop already; products, customers and suppliers are shared by the business.
- **Managing shops** (More tab, owner, needs a connection because shops are shared set-up, not daily transactions):
  `create_shop`, `update_shop` (rename, town, switch off / on), staff access. The plan limit is enforced by the database
  (SB403) on creating AND on switching a shop back on; the last active shop cannot be switched off. All changes are audited.
- **Transfers** (Stock > Transfers, owner and manager): stock leaves the current shop at its weighted-average cost and enters the
  other at that same value, so no value is created or lost. Each product is two ledger rows sharing one reference and the whole
  transfer is one sync group (all or nothing). A transfer cannot take stock that is not there (even in "allow oversell" mode,
  which applies to sales). The database re-checks every transfer at commit (`check_transfer_consistency`): one out and one in,
  same product, quantity and value, two different shops. A second device rebuilds identical stock in both shops by replay.
- **Tested:** SQL (rolled back): plan limit, owner-only, name rules, last shop, staff access rules, balanced and unbalanced
  transfers. Unit tests for the rules and for transfers including sync to a second device and a tampered transfer.

### Multi-shop limitations (honest list)
- Reports compare nothing across shops yet: each screen shows the shop you are in. No "all shops" total.
- A transfer is instant: there is no "in transit" state or receiving confirmation, and no partial receipt.
- Transfers are in base units (as stock is counted), not cartons.
- Shop management needs a connection; staff who lose access to the shop they are in are moved to another at the next refresh.
- Customer debts are business-wide, not per shop. Receipt numbering is per shop on each device.
- Not run against a real owner login with two shops (needs the test owner account).

## 16. Reports and export

Money tab > Reports (owner and managers, `reports.operational`). Pick today / last 7 days / this month / last month / any dates,
and one shop or all shops (the first time all shops can be combined: the data is already on the device for the whole business).

**Tables** (all recomputed from the ledgers, never stored): summary (revenue, cost of goods, gross and operating profit,
expenses, tax, discounts, returns, money collected by method, customer debts, supplier debts), sales by day, sales by product
(quantity, revenue, profit, margin), stock value, customers who owe us, expenses by category.

**Reconciliation is tested:** the product table adds up exactly to the summary's revenue, cost of goods and gross profit, with
and without returns, for each shop and for all shops; the daily table adds up to the summary revenue. A table that disagreed
with the headline would be a bug, not a rounding choice.

**Export**
- *CSV per table* for Excel / Google Sheets: UTF-8 with a byte-order mark so accents (é, è, ç) read correctly; separator `;` when
  the app is in French (French Excel) and `,` in English; text beginning with `= + - @` gets a leading apostrophe so a product
  or customer name can never run as a spreadsheet formula when the file is opened. Numbers stay plain numbers.
- *PDF*: "Print / save as PDF" uses the browser's print dialog with the app's header, tabs and banners hidden. No server and no
  library, so it also works offline. It is the browser's PDF, not a designed invoice template.
- Files are created on the device and never uploaded.

### Report limitations (honest list)
- Stock value is "as of now" (the cost projection is current), not as of the end of the chosen period.
- Customer debts and the balance at period end are business-wide, not per shop. Supplier debts the same.
- No Excel (.xlsx) file, only CSV; no charts; no scheduled or emailed reports.
- A returned product that was not sold in the chosen period shows with a name of "—" in the product table (the return line does not carry the name).
- Reports use the device's local time zone for "today" and for the day boundaries.
- Operating profit is not accounting net profit (said on the screen too); no tax filing (VAT) report has been reviewed for Cameroon.

## 17. WhatsApp reminders (click-to-chat, sent by a person)

**Decision:** no WhatsApp Business API. That needs a Meta-verified business, a provider account, approved message templates and
per-message fees, none of which exist yet, and automatic sending to customers raises consent questions. Instead the app builds
a `https://wa.me/237XXXXXXXXX?text=...` link; tapping it opens WhatsApp with the message already typed and the person presses
Send. Zero cost, works on any phone with WhatsApp, and nobody receives a message a human did not choose to send.

- **Shop → customer debt reminders:** Money > Debts has a WhatsApp button per customer who owes (default message in French or
  English with first name, shop name and amount); the customer's page has the editable message. The Reports "customers who owe us"
  table has the same button (hidden when printing). "Reminded 3 d ago" is kept on the device so the owner does not nag twice.
  Customers without a valid Cameroon mobile number show "No number" instead of opening a wrong chat.
- **Platform → business renewal reminders:** admin app > Renewal reminders (finance and super roles). Lists businesses ending in
  ≤ 5 days or ended in the last 30 days with the right message (5 days / 2 days / grace / expired), in the owner's language
  (switchable), using the platform's own wording from System settings > Message templates when set. Because it shows the owner's
  FULL phone number it needs the billing role and a two-step login, and viewing the list (`reminders.viewed`) and opening a chat
  (`reminder.opened`, with the kind) are written to the immutable admin audit log. Migration 0017.
- **Tested:** link building (number formats, wrong numbers refused, accents / line breaks / symbols encoded), templates (no raw
  placeholders, known placeholders only), which message fits how many days remain, SQL permissions and audit (rolled back), both
  screens in a browser.

### Reminder limitations (honest list)
- Fully manual: a person must tap and press Send for every message. There is no automatic daily sending, no delivery or read status,
  and no way to know whether the message was actually sent (only that the chat was opened).
- The shop's debt message text is not saved between sessions (edit per message); platform templates are the only saved wording.
- Customer phone numbers must be Cameroon mobiles (6XXXXXXXX); other countries' numbers are not supported.
- SMS is not built. The same links pattern could be added (`sms:`) if wanted.
- Real automatic sending later = a provider (Meta Cloud API or an aggregator) behind an Edge Function reading the same templates.

