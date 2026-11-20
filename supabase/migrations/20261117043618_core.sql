-- StockCM 0001: tenancy, staff, permissions, catalogue, stock ledger.
-- Conventions
--   * every business table has tenant_id and RLS enabled
--   * primary keys are UUIDs generated on the device (offline-safe)
--   * money is bigint XAF (no decimals); quantities are bigint BASE units
--   * ledgers (stock_movements, financial_transactions, account entries,
--     audit_logs) are append-only: UPDATE/DELETE are blocked by trigger

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- helpers
create or replace function public.prevent_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not allowed: this table is an immutable ledger. Post a reversal instead.',
    tg_op, tg_table_name using errcode = '42501';
end $$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------------------------------------------------------------- tenancy
create type public.business_category as enum (
  'general_store','supermarket','pharmacy','hardware','clothing','cosmetics',
  'wholesale','electronics','agri_supply','other');

create type public.staff_role as enum ('owner','manager','cashier','storekeeper');

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category public.business_category not null default 'general_store',
  currency text not null default 'XAF' check (currency = 'XAF'),
  language text not null default 'fr' check (language in ('fr','en')),
  tax_id text,
  oversell_policy text not null default 'allow_and_flag'
    check (oversell_policy in ('allow_and_flag','block')),
  costing_method text not null default 'weighted_average'
    check (costing_method = 'weighted_average'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  name text not null,
  town text,
  receipt_header text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.shops (tenant_id);

-- one row per person with access to a tenant
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.staff_role not null,
  full_name text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index on public.memberships (user_id);

-- which shops a member may work in
create table public.membership_shops (
  membership_id uuid not null references public.memberships(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  primary key (membership_id, shop_id)
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  last_sync_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.devices (tenant_id);

-- Permissions: default per role, overridable per tenant.
create table public.role_permissions (
  tenant_id uuid references public.tenants(id) on delete cascade, -- null = platform default
  role public.staff_role not null,
  permission text not null,
  allowed boolean not null default true
);
-- A primary key cannot include the nullable tenant_id, so uniqueness is two partial indexes.
create unique index role_permissions_tenant_uq on public.role_permissions (tenant_id, role, permission)
  where tenant_id is not null;
create unique index role_permissions_default on public.role_permissions (role, permission)
  where tenant_id is null;

insert into public.role_permissions (tenant_id, role, permission) values
  (null,'owner','*'),
  (null,'manager','sales.create'),(null,'manager','sales.refund_approve'),
  (null,'manager','stock.adjust_approve'),(null,'manager','purchases.manage'),
  (null,'manager','cash.close'),(null,'manager','reports.operational'),
  (null,'manager','products.write'),(null,'manager','expenses.write'),
  (null,'cashier','sales.create'),(null,'cashier','sales.request_refund'),
  (null,'cashier','products.read'),(null,'cashier','payments.receive'),
  (null,'storekeeper','stock.receive'),(null,'storekeeper','stock.count'),
  (null,'storekeeper','products.read'),(null,'storekeeper','stock.adjust_request');

-- ---------------------------------------------------------------- access functions
-- SECURITY DEFINER so the lookup itself is not blocked by RLS (no recursion).
create or replace function public.my_tenants() returns setof uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from public.memberships where user_id = auth.uid() and active
$$;

create or replace function public.has_permission(p_tenant uuid, p_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.memberships m
    join public.role_permissions rp
      on rp.role = m.role and (rp.tenant_id is null or rp.tenant_id = m.tenant_id)
    where m.user_id = auth.uid() and m.tenant_id = p_tenant and m.active
      and rp.allowed and (rp.permission = '*' or rp.permission = p_permission)
  )
$$;

-- ---------------------------------------------------------------- catalogue
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  unique (tenant_id, name)
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.suppliers (tenant_id);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  name text not null,
  description text,
  sku text,
  barcode text,
  image_path text,
  is_service boolean not null default false,      -- services never touch stock
  base_unit text not null default 'piece',
  min_stock bigint not null default 0 check (min_stock >= 0),
  tax_rate_bp integer not null default 0 check (tax_rate_bp between 0 and 10000), -- basis points
  track_batches boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.products (tenant_id, name);
create unique index products_barcode_uq on public.products (tenant_id, barcode) where barcode is not null;
create unique index products_sku_uq on public.products (tenant_id, sku) where sku is not null;

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,                 -- e.g. "Size 42 / Black"
  sku text,
  barcode text
);
create index on public.product_variants (product_id);

create table public.product_units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,                              -- bottle, carton, kg ...
  factor bigint not null check (factor > 0),       -- base units per this unit
  sell_price bigint not null check (sell_price >= 0),
  is_base boolean not null default false
);
create index on public.product_units (product_id);
create unique index one_base_unit on public.product_units (product_id) where is_base;

create table public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  batch_number text not null,
  expiry_date date,
  unique (shop_id, product_id, batch_number)
);

-- ---------------------------------------------------------------- stock ledger
create type public.movement_type as enum (
  'opening','purchase_receipt','sale','return_in','damaged','expired','missing',
  'giveaway','personal_use','count_adjustment','transfer_out','transfer_in','reversal');

create table public.stock_movements (
  id uuid primary key,                                   -- created on the device
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  shop_id uuid not null references public.shops(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  variant_id uuid references public.product_variants(id),
  batch_id uuid references public.inventory_batches(id),
  quantity bigint not null check (quantity <> 0),         -- signed, base units
  movement_type public.movement_type not null,
  reason text,
  staff_id uuid references auth.users(id),
  device_id uuid references public.devices(id),
  reference_type text,                                    -- 'sale','purchase','count','transfer'
  reference_id uuid,
  reverses_id uuid references public.stock_movements(id),
  unit_cost bigint,                                       -- cost per base unit, informational
  occurred_at timestamptz not null,                       -- device clock
  received_at timestamptz not null default now()          -- server clock
);
create index on public.stock_movements (tenant_id, shop_id, product_id);
create index on public.stock_movements (reference_type, reference_id);
create trigger stock_movements_immutable before update or delete on public.stock_movements
  for each row execute function public.prevent_mutation();

-- Projection for fast reads. The ledger above is the source of truth.
create table public.stock_levels (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity bigint not null default 0,
  value_xaf bigint not null default 0 check (value_xaf >= 0), -- weighted-average value
  last_unit_cost numeric(18,6) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (shop_id, product_id)
);

create or replace function public.apply_stock_movement() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.stock_levels (tenant_id, shop_id, product_id, quantity)
  values (new.tenant_id, new.shop_id, new.product_id, new.quantity)
  on conflict (shop_id, product_id)
  do update set quantity = public.stock_levels.quantity + excluded.quantity,
                updated_at = now();
  return new;
end $$;
create trigger stock_movements_project after insert on public.stock_movements
  for each row execute function public.apply_stock_movement();

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array[
    'shops','memberships','membership_shops','devices','categories','suppliers',
    'products','product_variants','product_units','inventory_batches',
    'stock_movements','stock_levels']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation_select on public.%I for select using (tenant_id in (select public.my_tenants()))', t);
  end loop;
end $$;

alter table public.tenants enable row level security;
create policy tenants_select on public.tenants for select using (id in (select public.my_tenants()));
create policy tenants_update on public.tenants for update
  using (public.has_permission(id, 'settings.write'))
  with check (public.has_permission(id, 'settings.write'));

alter table public.role_permissions enable row level security;
create policy role_permissions_select on public.role_permissions for select
  using (tenant_id is null or tenant_id in (select public.my_tenants()));

-- Writes to catalogue require a permission.
create policy products_write on public.products for all
  using (public.has_permission(tenant_id, 'products.write'))
  with check (public.has_permission(tenant_id, 'products.write'));
create policy product_units_write on public.product_units for all
  using (public.has_permission(tenant_id, 'products.write'))
  with check (public.has_permission(tenant_id, 'products.write'));
create policy categories_write on public.categories for all
  using (public.has_permission(tenant_id, 'products.write'))
  with check (public.has_permission(tenant_id, 'products.write'));
create policy suppliers_write on public.suppliers for all
  using (public.has_permission(tenant_id, 'purchases.manage'))
  with check (public.has_permission(tenant_id, 'purchases.manage'));

-- Stock ledger: insert only, and only with the right permission. Clients can
-- never insert a type they are not allowed to (e.g. a cashier cannot adjust).
create policy stock_movements_insert on public.stock_movements for insert
  with check (
    tenant_id in (select public.my_tenants())
    and case movement_type
      when 'sale'             then public.has_permission(tenant_id, 'sales.create')
      when 'return_in'        then public.has_permission(tenant_id, 'sales.create')
      when 'purchase_receipt' then public.has_permission(tenant_id, 'stock.receive')
      when 'opening'          then public.has_permission(tenant_id, 'stock.receive')
      when 'count_adjustment' then public.has_permission(tenant_id, 'stock.count')
      else public.has_permission(tenant_id, 'stock.adjust_approve')
    end);
