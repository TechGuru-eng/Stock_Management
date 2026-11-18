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
- **Switching person offline now works for people who have signed in on this device before** (section 19). Someone who has
  never signed in on this device needs the internet once.
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
- Invoices can be saved or shared as PDF (section 18); no tax invoice format has been reviewed for Cameroon.
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

## 18. PDF invoices

Real A4 PDF files made in the browser with `jspdf` (standard Helvetica, so French accents print correctly). The library is loaded
only when someone asks for a PDF (a separate chunk), and everything the invoice needs is read from the device, so it works offline.

- **Sale invoices:** Sales > Invoices lists this shop's sales (search by number or customer) with "PDF invoice" and "Share"; the same
  two buttons appear after every sale. "Share" opens the phone's share sheet (WhatsApp, email…) with the PDF attached; where the
  device cannot share files it downloads instead. The invoice shows the business (name, address, phone, tax number if known), the
  customer, lines (quantity, unit price, amount), subtotal, discount, tax, total, payments by method, returns, later debt repayments,
  and the balance still owed (or "Paid in full").
- **Subscription invoices:** Billing > Invoices has a PDF button per invoice (number, plan, period, amount, payment method), issued by
  "StockCM" to the business.
- **Correct by construction:** `buildSaleInvoice` is pure; lines must add to the subtotal and subtotal - discount + tax must equal
  the total, checked (`invoiceProblems`) before a PDF is produced. The tests use the real cart arithmetic including fractional
  quantities, line discounts and 19.25% tax, read the PDF bytes back, and check multi-page flow with page numbers. The layout was
  also rendered to an image and inspected.
- **Business details** (tax number NIU, address, phone) are fetched when online and cached on the device; missing ones are left off.

### Invoice limitations (honest list)
- The invoice number is the sale number (e.g. A1B2-0042): unique per device/shop but not a legally sequential national series.
  Whether this satisfies Cameroon invoicing rules (DGI: sequential numbering, NIU, VAT 19.25% breakdown, mandatory mentions, e-invoicing)
  has NOT been reviewed. Do not present it as a compliant tax invoice before an accountant has checked it.
- Tax is shown as one total, not broken down per rate; prices are tax-exclusive when a rate is set (as in the till).
- StockCM's own legal details (company name, address, NIU) are not configured, so subscription invoices show only "StockCM".
- Language is the app's language at the time; no logo, no custom template, no thermal-printer (80 mm) layout (the plain-text receipt remains).
- Standard font only: names in scripts outside Latin-1 (e.g. some symbols) would not print correctly.

## 19. Several staff on one shared device, switching offline

**Problem.** A shop till is shared. The server attributes records to whoever uploads them, but offline the next cashier cannot get
a server session. Letting the device simply "be" that person would let anyone claim to be anyone.

**Design: a session and a person are separate things.**
- The device stays signed in under ONE session. The person at the till (the "actor") can change offline: the lock screen (idle, or
  the header's "Switch person" button) lists everyone who has signed in on this device, you pick your name and type your PIN. The
  PIN is checked on the device against that person's own salted PBKDF2 verifier, with their own lockout (5 wrong = locked for them,
  others unaffected). Roles, shop access and the screen follow the new person at once; their own saved shop is restored.
- Every record queued for upload is stamped with the actor. On upload each group goes up *as* that person (`sync_push_as`).
- **The server decides whether to believe it** (migration 0018), because it cannot check a PIN: it accepts only when the person has
  signed in on THIS device while online (`device_actors`, filled by every sync), is an active non-owner member of the business, the
  device is not revoked, and the session vouching is the owner or someone enrolled on the same device. Then it runs the normal upload
  with the actor as the signed-in identity, so row-level security and role permissions apply to THEM (a cashier cannot slip in a
  manager's stock adjustment; a manager's offline adjustment is accepted). Each such upload is written to the audit log
  (`sync.uploaded_as`, with who vouched). A forged or unknown actor makes that group "refused" without holding up the others.
- **Owners are never switched to.** They sign in online with their phone; an owner session has no lock screen and no roster.
- After each sync the app asks the server who is still allowed on the device and removes deactivated people from the list together
  with their offline PIN, so a deactivated cashier stops working offline at the next sync. Setting a new PIN for someone is
  likewise picked up when they next sign in online.

**Tested.** SQL (rolled back, live): enrolment on sync, owner never enrolled, a cashier cannot do manager-only work as herself but a
manager's work uploaded by the cashier session is stamped as the manager and audited; refused for people never seen on the device,
owners, strangers, a session not enrolled on the device, an outsider, a revoked device, a deactivated person. App tests: records
stamped per person across switches, uploaded per group in order, unknown actor refused without blocking others, independent PIN
lockouts, roster pruning. The lock screen was exercised in a browser (picker, wrong PIN, correct PIN, role change).

### Shared-device limitations (honest list)
- **Trust is in the device.** The server can only check that a person *has been* on this device, not that they typed a PIN today. Someone
  with full control of the device (or its storage) could attribute records to any other person enrolled on that same device. They cannot
  reach beyond that device's enrolled people, owners, or other businesses, and every such upload is audited with the device and the voucher.
- A person deactivated *while a device is offline* can still work on it until it next syncs; their records made in between are
  then refused (shown as refused sync events for the owner) rather than silently credited.
- A PIN changed by the owner takes effect offline only after that person signs in online on the device once.
- The acting person's shop list is the one saved when they last signed in; shop changes made later reach them at their next online sign-in.
- Non-sales server calls (licence refresh, staff and billing screens) use the signed-in session, not the acting person; those screens are owner-only.
- The offline idle lock is still 5 minutes and the 12-hour session expiry still needs a connection to renew.

## 20. Stock counts (stock-takes)

Stock > Counts (people with the right to count: owner, manager, storekeeper; deciding needs the right to approve adjustments: owner, manager).

**Flow.** Start a count of the current shop (name, blind or not). Counters enter the real quantity per product. For each figure the app
also records what the system *expected* and the average cost at that moment, so sales made while counting continues do not distort
the difference. A *blind* count hides the expected number from counters (they count more honestly); reviewers always see it.
Counting a product again adds a newer line; the newest wins; nothing is edited or deleted.
A manager then reviews: differences sorted by value, missing vs surplus value, accuracy, and a "recount?" flag when a difference is 10% of the
expected quantity or worth 10 000 FCFA or more. Products not counted are left alone (the screen says how many). The review exports to CSV.

**Approving** posts one `count_adjustment` movement per product that differs, for the DIFFERENCE only (so sales made after the count are
not undone), gains at the current average cost and losses leaving at it, together with the decision in ONE sync group (all or nothing).
**Rejecting** needs a reason and changes no stock. A decided count cannot be changed and takes no more lines.

**Server rules (migration 0019, tested live in a rolled-back transaction).** Three append-only synced tables (`stock_counts`,
`stock_count_lines`, `stock_count_decisions`, one decision per count). At commit the database checks that an approved count's adjustments
equal exactly what its newest lines call for (right product, right quantity, one per product, same shop, nothing for products that matched
or were not counted) and that a rejected count has none. `count_adjustment` can no longer be posted any other way: it needs the right to
approve and must belong to an approved count (before, any counter could post one directly). Lines after a decision are refused.
Uploads made as another person on a shared till are checked against that person's rights (section 19).

### Count limitations (honest list)
- Counting is by whole base units (as stock is kept), not cartons or kilograms with decimals.
- No partial scopes (by category or aisle) and no scheduled / recurring counts; a count covers whatever products people choose to enter.
- Two people counting the same product on different devices: the newest line wins, with no warning that they differ.
- A line that reaches the server after the count was decided is refused (shown as a refused sync event); counting devices should sync before approval.
- Adjustment cost uses the average cost at approval time, not at counting time, so the value shown in the review can differ slightly from what is posted if costs moved in between.
- Camera scanning is available in counts (section 21); each scan adds one to a tally that the counter checks and saves.

## 21. Barcode scanning

Three ways to enter a barcode, all working offline:
1. **Camera** (the barcode button beside search and barcode fields). It uses the browser's built-in `BarcodeDetector` where there is one
   (Chrome / Edge on Android and desktop: fast, nothing to download); elsewhere (iPhone Safari, Firefox) it loads a small JavaScript reader
   (`@zxing/browser`) the first time it is opened. Both are loaded on demand, so the app starts no slower. Images never leave the device.
2. **A scanner that types** (USB / Bluetooth "keyboard" scanners): they type the code and press Enter, which the till's search box already
   accepts; codes now also match when a scanner reports a UPC-A code as EAN-13 or the other way round.
3. **Typing the code** in the scanner window, so a dirty label or a refused camera permission never blocks a sale.

**Where it works.** Till: continuous mode (stays open for a whole basket; each scan adds the product, scanning the same item again adds one
more; shows "added" or "unknown product"). Product form: fills the barcode, warns when it is already used by another product or when the last
digit does not fit (a misread), and can make an in-store code for goods that have none (EAN-13 starting with 20, the range reserved for
in-store use, never clashing with a manufacturer's code). Stock list search. Counts and transfers: each scan adds one to that product's tally,
which the person checks and saves (transfers are capped at the stock available).

**Reliability rules (tested).** Retail codes (EAN-13, EAN-8, UPC-A, ITF-14) are checked with their check digit and a misread frame is ignored;
the same code seen again within 1.5 s is ignored (same item still in view); text is cleaned (spaces, line breaks, case). Product barcodes are
stored cleaned, and the same code in UPC-A / EAN-13 spelling counts as a duplicate. The scanner window is drawn outside the till's form so
a typed code can never submit the sale form.

### Barcode limitations (honest list)
- Camera scanning needs a secure connection (https or localhost) and the user's permission; the camera was NOT exercised on real devices
  here (the test browser has no camera), only the logic, the screens, the typed fallback and the denied-permission message.
- Low light, glossy labels and damaged codes are harder; the torch button appears only where the phone allows it.
- One barcode per product (not per unit such as carton); cartons are sold by choosing the unit after scanning the base product.
- QR codes and mobile-money QR payments are not read. Labels can be printed from the app (section 22).
- Wedge-scanner bursts are recognised by the search boxes (code then Enter), not by a global listener, so the right field must be focused.

## 22. Barcode labels

Stock > Labels. Choose products and the number of labels for each, the sticker sheet, optionally the price and cutting lines, and get a
PDF (download or share). It works offline.

- **Sheets:** A4 sheets of 21, 24 or 65 labels and 50x30 / 40x25 mm rolls (one label per page, page = label size). "Start at cell n"
  lets a partly used sheet be finished without wasting stickers. Each label shows the name (two lines at most), the bars, the number
  and the base-unit price. Copies are limited to 200 per product and 2000 labels per job.
- **Bars are drawn as rectangles** (not an image), so they stay sharp at any printer resolution. EAN-13, EAN-8 and UPC-A with a correct
  check digit use their own pattern; anything else (letters, odd lengths, a retail-looking code with a wrong digit) is printed as
  Code 128, which every normal scanner reads. A test decodes the drawn EAN-13 bars back into the exact number.
- **Goods without a barcode:** "Make in-store codes" gives each selected product a code from the range reserved for in-store use
  (EAN-13 starting with 20) and saves it on the product so the till and counts can scan it. Needs the right to edit products.
  This needed one new narrow upload operation (migration 0020, `product_barcode`): products are otherwise insert-only, so this only
  fills an EMPTY barcode, never changes one, runs under the person's row-level security, and a clash with another product is refused
  by the unique index. If two devices give the same code to different products, the second shows as a sync conflict which "resolve"
  clears (that product goes back to having no barcode, nothing else is lost).
- **Tested:** layouts (every preset fits its page, filling order, start cell, page counts), copies and limits, bar decoding, PDF page
  counts and contents, assigning codes (rules, upload, second device, conflict), live SQL (manager allowed, cashier refused, no
  overwrite, duplicate refused). A rendered sheet was inspected as an image.

### Label limitations (honest list)
- The sheet presets are common sizes; your stickers must match one of them (check the size on the box). There is no custom size editor yet.
- Print at "actual size" (100%, no fit-to-page); a printer that rescales will shift the labels. Margins differ a little between printers.
- A real scanner was not available here: bar correctness is verified by decoding the drawn pattern, not by scanning a printed label.
  Print a test sheet and scan it before labelling a whole shop.
- The label shows the price of the base unit only, in FCFA; no logo, no per-unit labels, no QR codes.
- Giving a barcode to a product uses the narrow operation of migration 0020; changing or clearing a barcode and every other edit is covered in section 23.

## 23. Editing products and prices

Stock > a product > **Edit product** (owner and manager: the right to edit products).

- **Editable:** name, barcode (set, change or clear; must stay unique, scanner and "make an in-store code" available), reference (sku, unique),
  minimum-stock alert, tax rate (typed as a percent such as 19.25, stored in basis points), hide / show, each unit's selling price and
  name, and adding a bigger unit (a carton of 24) to an existing product.
- **Fixed on purpose:** the base unit, a unit's size (factor) and whether it is a service. Changing them would change what the stock
  numbers mean or how old movements add up. A mistake there is fixed by hiding the product and creating a new one (the screen says so).
- **History is safe:** every sale line stores the price it was sold at, so a price change only affects new sales (tested). Tax changes
  likewise only affect future sales. Hiding a product keeps its stock, cost and history; hidden products leave the till and the default
  list ("Show hidden" brings them back). Showing a hidden product again respects the plan's product limit.
- **Only real changes are saved**, together with the old values. The client whitelists the editable fields, so a stray field (such as a
  factor) can never be changed through this path.
- **Sync (migration 0021, tested live in a rolled-back transaction):** two new upload operations, `product_edit` and `unit_edit`, run under the
  person's row-level security; blank names, negative stock minimums or prices, tax outside 0-100%, duplicate barcodes / references /
  unit names are refused; the factor is ignored even if sent. Each change is written to an append-only server log (`product_changes`: who,
  when, new and old values), shown in the edit screen when online. An edit not yet uploaded is not overwritten by a download of the same
  product. If an edit clashes with another device's (the same barcode), it is flagged and "resolve" discards it and puts the old values back.
- **Tested:** validation, only-real-changes, duplicate rules, hide / show, price history, factor protection, upload and a second device,
  download-versus-pending-edit, conflict and restore; live SQL for permissions, validations, duplicates and the log.

### Product editing limitations (honest list)
- Two people editing the same product on different devices: the later upload wins field by field (only the fields each changed are sent,
  so unrelated edits do not erase each other), and there is no merge screen.
- The change log is only on the server (not on the device), so history needs a connection.
- A price can not be scheduled for a date, and there are no bulk edits (change many prices at once) or CSV import.
- Services cannot be turned into goods or the reverse, and the base unit cannot be renamed into a different unit of measure.

