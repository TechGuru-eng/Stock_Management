-- StockCM 0002: customers, sales, payments, financial ledger, purchases,
-- expenses, cash, approvals, billing, audit, sync metadata.
-- Source of truth = the append-only ledgers. Balances are views/projections.

create type public.verification_status as enum
  ('recorded','pending','provider_verified','failed','refunded');
create type public.payment_method as enum ('cash','mtn_momo','orange_money','credit');
create type public.sale_status as enum ('completed','cancelled','refunded','partially_refunded');
create type public.txn_type as enum (
  'sale_collection','debt_repayment','supplier_payment','expense','cash_deposit',
  'cash_withdrawal','refund','payment_adjustment','owner_contribution',
  'owner_withdrawal','reversal');

-- ---------------------------------------------------------------- customers
create table public.customers (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  phone text,
  address text,
  credit_limit bigint not null default 0 check (credit_limit >= 0),
  notes text,
  whatsapp_reminders boolean not null default false,   -- explicit permission to message
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.customers (tenant_id, name);

-- ---------------------------------------------------------------- sales
create table public.sales (
  id uuid primary key,                                  -- device-generated
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  shop_id uuid not null references public.shops(id) on delete restrict,
  sale_number text not null,                            -- device prefix + counter, e.g. A-0001
  customer_id uuid references public.customers(id),
  cashier_id uuid references auth.users(id),
  device_id uuid references public.devices(id),
  subtotal bigint not null check (subtotal >= 0),
  discount bigint not null default 0 check (discount >= 0),
  tax bigint not null default 0 check (tax >= 0),
  total bigint not null check (total >= 0),
  collected bigint not null default 0 check (collected >= 0),
  outstanding bigint not null default 0 check (outstanding >= 0),
  status public.sale_status not null default 'completed',
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  check (total = subtotal - discount + tax),
  check (collected + outstanding = total),
  unique (tenant_id, shop_id, sale_number)
);
create index on public.sales (tenant_id, shop_id, occurred_at desc);
create index on public.sales (customer_id) where outstanding > 0;

create table public.sale_lines (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  sale_id uuid not null references public.sales(id) on delete restrict,
  product_id uuid not null references public.products(id),
  unit_id uuid references public.product_units(id),
  quantity bigint not null check (quantity > 0),          -- in the sold unit
  base_quantity bigint not null check (base_quantity > 0),
  unit_price bigint not null check (unit_price >= 0),
  line_discount bigint not null default 0 check (line_discount >= 0),
  line_total bigint not null check (line_total >= 0),
  cost_of_goods bigint not null default 0 check (cost_of_goods >= 0) -- frozen at sale time
);
create index on public.sale_lines (sale_id);

-- ---------------------------------------------------------------- financial ledger
create table public.financial_transactions (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  shop_id uuid references public.shops(id),
  reference text not null,                              -- unique human-readable reference
  txn_type public.txn_type not null,
  amount bigint not null check (amount <> 0),           -- signed: + money in, - money out
  currency text not null default 'XAF',
  method public.payment_method not null,
  verification public.verification_status not null default 'recorded',
  provider_reference text,                              -- set only by a verified webhook
  staff_id uuid references auth.users(id),
  device_id uuid references public.devices(id),
  customer_id uuid references public.customers(id),
  supplier_id uuid references public.suppliers(id),
  sale_id uuid references public.sales(id),
  expense_id uuid,
  purchase_id uuid,
  reverses_id uuid references public.financial_transactions(id),
  description text,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (tenant_id, reference),
  -- a manual entry can never claim to be provider-verified
  check (verification <> 'provider_verified' or provider_reference is not null)
);
create index on public.financial_transactions (tenant_id, shop_id, occurred_at desc);
create trigger financial_transactions_immutable
  before update or delete on public.financial_transactions
  for each row execute function public.prevent_mutation();

-- Verification can only move forward through a controlled function (used by
-- the payment webhook), never by updating the ledger row.
create table public.transaction_verifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  transaction_id uuid not null references public.financial_transactions(id),
  status public.verification_status not null,
  provider_reference text,
  created_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  sale_id uuid references public.sales(id),
  customer_id uuid references public.customers(id),
  transaction_id uuid references public.financial_transactions(id),
  method public.payment_method not null,
  amount bigint not null check (amount > 0),
  created_at timestamptz not null default now()
);

-- Which sale a repayment pays off. Sale amounts are never edited.
create table public.payment_allocations (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  payment_id uuid not null references public.payments(id),
  sale_id uuid not null references public.sales(id),
  amount bigint not null check (amount > 0)
);

create table public.customer_account_entries (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  customer_id uuid not null references public.customers(id),
  amount bigint not null check (amount <> 0),           -- + owes more, - owes less
  kind text not null check (kind in ('sale_credit','repayment','adjustment','reversal')),
  sale_id uuid references public.sales(id),
  transaction_id uuid references public.financial_transactions(id),
  reverses_id uuid references public.customer_account_entries(id),
  occurred_at timestamptz not null,
  due_date date
);
create index on public.customer_account_entries (tenant_id, customer_id);
create trigger customer_entries_immutable before update or delete
  on public.customer_account_entries for each row execute function public.prevent_mutation();

create view public.customer_balances with (security_invoker = true) as
  select tenant_id, customer_id, sum(amount)::bigint as balance
  from public.customer_account_entries group by tenant_id, customer_id;

-- ---------------------------------------------------------------- purchases
create table public.purchases (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  shop_id uuid not null references public.shops(id),
  supplier_id uuid not null references public.suppliers(id),
  invoice_number text,
  status text not null default 'ordered'
    check (status in ('draft','ordered','partially_received','received','cancelled')),
  ordered_at timestamptz not null default now()
);

create table public.purchase_lines (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  purchase_id uuid not null references public.purchases(id),
  product_id uuid not null references public.products(id),
  base_quantity bigint not null check (base_quantity > 0),
  total_cost bigint not null check (total_cost >= 0)
);

-- Stock increases ONLY from a goods receipt, never from the order itself.
create table public.goods_receipts (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  purchase_id uuid not null references public.purchases(id),
  received_by uuid references auth.users(id),
  received_at timestamptz not null default now()
);

create table public.supplier_account_entries (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id),
  amount bigint not null check (amount <> 0),           -- + we owe more, - we owe less
  kind text not null check (kind in ('purchase_credit','payment','return','adjustment','reversal')),
  purchase_id uuid references public.purchases(id),
  transaction_id uuid references public.financial_transactions(id),
  reverses_id uuid references public.supplier_account_entries(id),
  occurred_at timestamptz not null
);
create trigger supplier_entries_immutable before update or delete
  on public.supplier_account_entries for each row execute function public.prevent_mutation();

-- ---------------------------------------------------------------- expenses & cash
create table public.expenses (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  shop_id uuid not null references public.shops(id),
  category text not null check (category in
    ('rent','electricity','water','salaries','transport','internet','maintenance','deliveries','other')),
  amount bigint not null check (amount > 0),
  method public.payment_method not null check (method <> 'credit'),
  description text,
  document_path text,
  staff_id uuid references auth.users(id),
  occurred_at timestamptz not null
);

create table public.cash_sessions (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  shop_id uuid not null references public.shops(id),
  opened_by uuid references auth.users(id),
  closed_by uuid references auth.users(id),
  opening_cash bigint not null check (opening_cash >= 0),
  expected_closing bigint,
  counted_closing bigint,
  difference bigint,                                    -- recorded permanently
  opened_at timestamptz not null,
  closed_at timestamptz
);

create table public.cash_movements (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  cash_session_id uuid not null references public.cash_sessions(id),
  transaction_id uuid references public.financial_transactions(id),
  amount bigint not null check (amount <> 0),           -- signed
  kind text not null,
  occurred_at timestamptz not null
);
create trigger cash_movements_immutable before update or delete
  on public.cash_movements for each row execute function public.prevent_mutation();

create table public.inventory_counts (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  shop_id uuid not null references public.shops(id),
  counted_by uuid references auth.users(id),
  counted_at timestamptz not null,
  lines jsonb not null                                  -- [{product_id, system_qty, counted_qty}]
);

create table public.approval_requests (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in
    ('price_change','stock_adjustment','large_discount','refund','reversal','data_export')),
  payload jsonb not null,
  requested_by uuid references auth.users(id),
  decided_by uuid references auth.users(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz
);

-- ---------------------------------------------------------------- billing
create table public.plans (
  code text primary key,                                -- starter, business, pro, enterprise
  name text not null,
  price_xaf bigint check (price_xaf >= 0),              -- null = custom pricing
  max_shops integer, max_staff integer, max_products integer,
  features jsonb not null default '{}',
  active boolean not null default true
);
-- Editable from the admin dashboard; these are initial proposals only.
insert into public.plans (code,name,price_xaf,max_shops,max_staff,max_products) values
  ('starter','Starter',2500,1,2,500),
  ('business','Business',5000,1,5,5000),
  ('pro','Pro',10000,3,15,null),
  ('enterprise','Enterprise',null,null,null,null);

create table public.platform_settings (
  key text primary key, value jsonb not null
);
insert into public.platform_settings values
  ('trial_days','30'), ('grace_days','7'), ('offline_limit_days','30');

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  plan_code text not null references public.plans(code),
  status text not null default 'trial'
    check (status in ('trial','active','grace','expired','suspended')),
  period_start timestamptz not null default now(),
  period_end timestamptz not null,
  updated_at timestamptz not null default now()
);

create table public.billing_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  plan_code text not null references public.plans(code),
  amount bigint not null check (amount > 0),
  provider text not null,
  provider_reference text not null,
  status public.verification_status not null default 'pending',
  created_at timestamptz not null default now(),
  -- a webhook retry carries the same reference and can never credit twice
  unique (provider, provider_reference)
);

-- ---------------------------------------------------------------- audit + sync
create table public.audit_logs (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants(id) on delete restrict,
  actor_id uuid,
  device_id uuid,
  action text not null,
  entity text,
  entity_id uuid,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);
create index on public.audit_logs (tenant_id, created_at desc);
create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function public.prevent_mutation();

-- Every offline operation carries a client-generated id; a second upload of
-- the same id is recognised and skipped (idempotency).
create table public.sync_operations (
  op_id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  device_id uuid references public.devices(id),
  op_type text not null,
  status text not null check (status in ('applied','rejected','conflict')),
  error text,
  received_at timestamptz not null default now()
);

create table public.sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  entity text not null,
  entity_id uuid not null,
  local_value jsonb,
  server_value jsonb,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array[
    'customers','sales','sale_lines','financial_transactions','transaction_verifications',
    'payments','payment_allocations','customer_account_entries','purchases','purchase_lines',
    'goods_receipts','supplier_account_entries','expenses','cash_sessions','cash_movements',
    'inventory_counts','approval_requests','subscriptions','billing_payments','audit_logs',
    'sync_operations','sync_conflicts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation_select on public.%I for select using (tenant_id in (select public.my_tenants()))', t);
  end loop;
end $$;

alter table public.plans enable row level security;
create policy plans_read on public.plans for select using (true);
alter table public.platform_settings enable row level security; -- no policy: server only

-- Money-moving inserts require a permission. Subscription and verification
-- state is written ONLY by Edge Functions using the service role (no policy).
create policy sales_insert on public.sales for insert
  with check (public.has_permission(tenant_id, 'sales.create'));
create policy sale_lines_insert on public.sale_lines for insert
  with check (public.has_permission(tenant_id, 'sales.create'));
create policy customers_write on public.customers for all
  using (public.has_permission(tenant_id, 'sales.create'))
  with check (public.has_permission(tenant_id, 'sales.create'));
create policy fin_txn_insert on public.financial_transactions for insert
  with check (
    verification in ('recorded','pending')               -- never self-declared verified
    and provider_reference is null
    and case txn_type
      when 'sale_collection' then public.has_permission(tenant_id, 'sales.create')
      when 'debt_repayment'  then public.has_permission(tenant_id, 'payments.receive')
      when 'expense'         then public.has_permission(tenant_id, 'expenses.write')
      else public.has_permission(tenant_id, 'finance.write')
    end);
create policy expenses_insert on public.expenses for insert
  with check (public.has_permission(tenant_id, 'expenses.write'));
create policy cust_entries_insert on public.customer_account_entries for insert
  with check (public.has_permission(tenant_id, 'payments.receive')
           or public.has_permission(tenant_id, 'sales.create'));
create policy approvals_insert on public.approval_requests for insert
  with check (tenant_id in (select public.my_tenants()));
create policy approvals_decide on public.approval_requests for update
  using (public.has_permission(tenant_id, 'stock.adjust_approve'));
