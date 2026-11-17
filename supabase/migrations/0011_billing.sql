-- StockCM 0011: subscriptions, billing, invoices, plan limits, and the read-only lock.
--
-- Rules (the database is the authority; the app mirrors them for messages and offline use)
--   * trial/active -> full use. After the paid period ends there is a grace period (setting 'grace_days', 7):
--     full use with a warning. After that the business is READ-ONLY: it can still view and export everything,
--     but no new records can be created. Nothing is ever deleted because a subscription lapsed.
--   * Plan limits (shops, staff, products) are enforced here, not only in the app.
--   * Only the SERVER can extend a subscription: a verified payment-provider webhook, or a platform admin
--     confirming a manual payment with a note. Clients cannot write subscriptions or payments at all.
--   * Payment confirmation is idempotent: the same payment can never extend a subscription twice.

-- ------------------------------------------------------------ platform staff and secrets
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.platform_secrets (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
alter table public.platform_secrets enable row level security;   -- no policy: service role only

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

create or replace function public.setting_int(p_key text, p_default int) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::int from public.platform_settings where key = p_key), p_default)
$$;

-- Initial proposals, all editable in the database (never in app code). Merchant numbers are deliberately EMPTY:
-- they must be your real business numbers.
insert into public.platform_settings (key, value) values
  ('billing_terms', '[{"months":1,"bonus":0},{"months":3,"bonus":0},{"months":6,"bonus":1},{"months":12,"bonus":2}]'),
  ('merchant_numbers', '{}'),
  ('payment_mode', '"manual"')
on conflict (key) do nothing;

alter table public.subscriptions add column next_plan_code text references public.plans(code);

-- ------------------------------------------------------------ read-only lock after grace
create or replace function public.subscription_allows_writes(p_tenant uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare s record;
begin
  select * into s from public.subscriptions where tenant_id = p_tenant;
  if not found then return true; end if;                       -- onboarding in progress
  if s.status = 'suspended' then return false; end if;
  return now() < s.period_end + make_interval(days => public.setting_int('grace_days', 7));
end $$;

create or replace function public.enforce_subscription_writes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.subscription_allows_writes(new.tenant_id) then
    raise exception 'subscription_expired' using errcode = 'SB402',
      hint = 'The subscription has ended. Renew to record new transactions; existing data stays available.';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['products','product_units','customers','stock_movements','sales','sale_lines',
      'financial_transactions','customer_account_entries','payments','payment_allocations','expenses','cash_sessions',
      'suppliers','purchases','purchase_lines','goods_receipts','goods_receipt_lines','supplier_account_entries',
      'sale_returns','sale_return_lines','approval_requests','approval_decisions']
  loop
    execute format('create trigger subscription_write_lock before insert on public.%I
                    for each row execute function public.enforce_subscription_writes()', t);
  end loop;
end $$;

-- ------------------------------------------------------------ plan limits
create or replace function public.enforce_plan_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare lim int; used int; kind text := tg_argv[0];
begin
  select case kind when 'products' then p.max_products when 'staff' then p.max_staff else p.max_shops end into lim
    from public.subscriptions s join public.plans p on p.code = s.plan_code where s.tenant_id = new.tenant_id;
  if lim is null then return new; end if;                      -- unlimited, or no subscription yet
  if kind = 'products' then
    select count(*) into used from public.products where tenant_id = new.tenant_id and active;
  elsif kind = 'staff' then
    if new.role = 'owner' or not new.active then return new; end if;
    select count(*) into used from public.memberships where tenant_id = new.tenant_id and active and role <> 'owner';
  else
    select count(*) into used from public.shops where tenant_id = new.tenant_id and active;
  end if;
  if used >= lim then
    raise exception 'plan_limit_%', kind using errcode = 'SB403',
      hint = 'This plan allows ' || lim || ' ' || kind || '. Upgrade the plan to add more.';
  end if;
  return new;
end $$;

create trigger plan_limit_products before insert on public.products
  for each row execute function public.enforce_plan_limit('products');
create trigger plan_limit_shops before insert on public.shops
  for each row execute function public.enforce_plan_limit('shops');
create trigger plan_limit_staff before insert on public.memberships
  for each row execute function public.enforce_plan_limit('staff');
create trigger plan_limit_staff_reactivate before update of active on public.memberships
  for each row when (old.active = false and new.active = true) execute function public.enforce_plan_limit('staff');

-- ------------------------------------------------------------ billing records
alter table public.billing_payments alter column provider_reference drop not null;
alter table public.billing_payments
  add column kind text not null default 'renewal' check (kind in ('renewal','upgrade')),
  add column reference text unique,
  add column term_months int,
  add column bonus_months int not null default 0,
  add column expected_amount bigint,
  add column method text check (method in ('mtn_momo','orange_money')),
  add column phone text,
  add column confirmed_at timestamptz,
  add column confirmed_by text,
  add column period_start timestamptz,
  add column period_end timestamptz,
  add column invoice_id uuid,
  add column note text;

create sequence public.invoice_seq;
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  number text not null unique,
  payment_id uuid not null unique references public.billing_payments(id),
  plan_code text not null references public.plans(code),
  amount bigint not null check (amount > 0),
  currency text not null default 'XAF',
  period_start timestamptz not null,
  period_end timestamptz not null,
  issued_at timestamptz not null default now()
);
create table public.billing_events (
  id bigint generated always as identity primary key,
  tenant_id uuid,
  payment_id uuid,
  event text not null,
  detail jsonb,
  at timestamptz not null default now()
);
alter table public.invoices enable row level security;
alter table public.billing_events enable row level security;       -- no policy: service role only
create policy invoices_select on public.invoices for select using (tenant_id in (select public.my_tenants()));
create trigger invoices_immutable before update or delete on public.invoices
  for each row execute function public.prevent_mutation();
create trigger billing_events_immutable before update or delete on public.billing_events
  for each row execute function public.prevent_mutation();

-- ------------------------------------------------------------ owner actions
create or replace function public.tenant_usage(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if p_tenant not in (select public.my_tenants()) then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'shops', (select count(*) from public.shops where tenant_id = p_tenant and active),
    'staff', (select count(*) from public.memberships where tenant_id = p_tenant and active and role <> 'owner'),
    'products', (select count(*) from public.products where tenant_id = p_tenant and active));
end $$;

create or replace function public.billing_info(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if p_tenant not in (select public.my_tenants()) then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'terms', (select value from public.platform_settings where key = 'billing_terms'),
    'merchant_numbers', (select value from public.platform_settings where key = 'merchant_numbers'),
    'payment_mode', (select value from public.platform_settings where key = 'payment_mode'),
    'grace_days', public.setting_int('grace_days', 7),
    'offline_days', public.setting_int('offline_limit_days', 30));
end $$;

create or replace function public.create_billing_payment(p_tenant uuid, p_kind text, p_plan text, p_months int, p_method text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  s record; cur record; target record; term jsonb; expected bigint; bonus int := 0; ref text; days_left int;
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; bytes bytea := extensions.gen_random_bytes(8); i int; pid uuid := gen_random_uuid();
begin
  if not public.has_permission(p_tenant, 'billing.manage') then
    raise exception 'only the owner can manage billing' using errcode = '42501';
  end if;
  if p_method not in ('mtn_momo','orange_money') then raise exception 'choose MTN MoMo or Orange Money' using errcode = '22023'; end if;
  if p_phone !~ '^\+2376[0-9]{8}$' then raise exception 'enter a Cameroon mobile number' using errcode = '22023'; end if;
  select * into s from public.subscriptions where tenant_id = p_tenant for update;
  if not found then raise exception 'no subscription' using errcode = 'P0002'; end if;
  select * into cur from public.plans where code = s.plan_code;

  if p_kind = 'renewal' then
    if p_plan is distinct from coalesce(s.next_plan_code, s.plan_code) then
      raise exception 'renew the plan you are on (or the one scheduled for renewal); change plan first' using errcode = '22023';
    end if;
    select * into target from public.plans where code = p_plan and active;
    if target.price_xaf is null then raise exception 'this plan has custom pricing: contact us' using errcode = '22023'; end if;
    select e into term from jsonb_array_elements((select value from public.platform_settings where key = 'billing_terms')) e
     where (e->>'months')::int = p_months;
    if term is null then raise exception 'that period is not offered' using errcode = '22023'; end if;
    bonus := (term->>'bonus')::int;
    expected := target.price_xaf * p_months;
  elsif p_kind = 'upgrade' then
    select * into target from public.plans where code = p_plan and active;
    if target.price_xaf is null or cur.price_xaf is null or target.price_xaf <= cur.price_xaf then
      raise exception 'that is not an upgrade' using errcode = '22023';
    end if;
    if s.status = 'trial' then raise exception 'during the trial, change plan directly: no payment is needed' using errcode = '22023'; end if;
    days_left := ceil(extract(epoch from (s.period_end - now())) / 86400.0)::int;
    if days_left <= 0 then raise exception 'the period has ended: renew first' using errcode = '22023'; end if;
    expected := ceil(((target.price_xaf - cur.price_xaf) * days_left) / 30.0)::bigint;
    p_months := null;
  else
    raise exception 'unknown payment kind' using errcode = '22023';
  end if;
  if expected is null or expected <= 0 then raise exception 'nothing to pay' using errcode = '22023'; end if;

  ref := 'STK-';
  for i in 0 .. 7 loop ref := ref || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1); end loop;
  insert into public.billing_payments (id, tenant_id, plan_code, amount, provider, status, kind, reference, term_months,
                                       bonus_months, expected_amount, method, phone)
  values (pid, p_tenant, p_plan, expected, 'manual', 'pending', p_kind, ref, p_months, bonus, expected, p_method, p_phone);
  insert into public.billing_events (tenant_id, payment_id, event, detail)
  values (p_tenant, pid, 'created', jsonb_build_object('kind', p_kind, 'plan', p_plan, 'amount', expected, 'by', auth.uid()));
  return jsonb_build_object('id', pid, 'reference', ref, 'expected_amount', expected, 'months', p_months, 'bonus', bonus, 'kind', p_kind);
end $$;

create or replace function public.change_plan(p_tenant uuid, p_plan text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s record; cur record; target record; usage jsonb; broken text[] := '{}';
begin
  if not public.has_permission(p_tenant, 'billing.manage') then
    raise exception 'only the owner can manage billing' using errcode = '42501';
  end if;
  select * into s from public.subscriptions where tenant_id = p_tenant for update;
  select * into cur from public.plans where code = s.plan_code;
  select * into target from public.plans where code = p_plan and active;
  if target.code is null then raise exception 'unknown plan' using errcode = '22023'; end if;
  if target.price_xaf is null then raise exception 'this plan has custom pricing: contact us' using errcode = '22023'; end if;

  if p_plan = s.plan_code then                                  -- also cancels a scheduled downgrade
    update public.subscriptions set next_plan_code = null, updated_at = now() where tenant_id = p_tenant;
    return jsonb_build_object('applied', 'cleared');
  end if;
  if s.status = 'trial' then
    update public.subscriptions set plan_code = p_plan, next_plan_code = null, updated_at = now() where tenant_id = p_tenant;
    return jsonb_build_object('applied', 'now');
  end if;
  if target.price_xaf > cur.price_xaf then
    return jsonb_build_object('requires_payment', true, 'kind', 'upgrade');
  end if;

  usage := public.tenant_usage(p_tenant);
  if target.max_shops is not null and (usage->>'shops')::int > target.max_shops then broken := broken || 'shops'; end if;
  if target.max_staff is not null and (usage->>'staff')::int > target.max_staff then broken := broken || 'staff'; end if;
  if target.max_products is not null and (usage->>'products')::int > target.max_products then broken := broken || 'products'; end if;
  if array_length(broken, 1) > 0 then
    raise exception 'downgrade_blocked: %', array_to_string(broken, ', ') using errcode = '22023';
  end if;
  update public.subscriptions set next_plan_code = p_plan, updated_at = now() where tenant_id = p_tenant;
  return jsonb_build_object('applied', 'at_renewal');
end $$;

-- ------------------------------------------------------------ confirming a payment (server only)
create or replace function public.apply_confirmed_payment(p_payment uuid, p_status public.verification_status, p_by text, p_provider text, p_provider_ref text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pay record; s record; base timestamptz; new_end timestamptz; inv_id uuid; inv_no text; started timestamptz;
begin
  select * into pay from public.billing_payments where id = p_payment for update;
  if pay.confirmed_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  select * into s from public.subscriptions where tenant_id = pay.tenant_id for update;
  started := now();

  if pay.kind = 'renewal' then
    base := greatest(now(), s.period_end);
    new_end := base + make_interval(months => pay.term_months + pay.bonus_months);
    update public.subscriptions
       set period_start = case when s.period_end < now() then now() else s.period_start end,
           period_end = new_end, status = 'active',
           plan_code = coalesce(s.next_plan_code, s.plan_code), next_plan_code = null, updated_at = now()
     where tenant_id = pay.tenant_id;
  else
    new_end := s.period_end;
    update public.subscriptions set plan_code = pay.plan_code, status = 'active', updated_at = now() where tenant_id = pay.tenant_id;
  end if;

  inv_id := gen_random_uuid();
  inv_no := 'INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.invoice_seq')::text, 6, '0');
  insert into public.invoices (id, tenant_id, number, payment_id, plan_code, amount, period_start, period_end)
  values (inv_id, pay.tenant_id, inv_no, pay.id, pay.plan_code, pay.expected_amount, started, new_end);
  update public.billing_payments
     set status = p_status, confirmed_at = now(), confirmed_by = p_by, provider = p_provider,
         provider_reference = coalesce(p_provider_ref, provider_reference), period_start = started, period_end = new_end, invoice_id = inv_id
   where id = pay.id;
  insert into public.billing_events (tenant_id, payment_id, event, detail)
  values (pay.tenant_id, pay.id, 'confirmed', jsonb_build_object('by', p_by, 'invoice', inv_no, 'period_end', new_end));
  insert into public.audit_logs (tenant_id, action, entity, entity_id, after_state)
  values (pay.tenant_id, 'billing.payment_confirmed', 'billing_payment', pay.id, jsonb_build_object('by', p_by, 'amount', pay.expected_amount));
  return jsonb_build_object('ok', true, 'invoice', inv_no, 'period_end', new_end);
end $$;

-- Called by the billing-webhook Edge Function AFTER it has verified the provider's signature.
create or replace function public.confirm_billing_payment(p_reference text, p_provider text, p_provider_ref text, p_amount bigint, p_outcome text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pay record;
begin
  select * into pay from public.billing_payments where reference = p_reference for update;
  if not found then
    insert into public.billing_events (event, detail) values ('unknown_reference', jsonb_build_object('reference', p_reference));
    return jsonb_build_object('ok', false, 'reason', 'unknown_reference');
  end if;
  if pay.confirmed_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;

  if p_outcome <> 'successful' then
    update public.billing_payments set status = 'failed' where id = pay.id and status = 'pending';
    insert into public.billing_events (tenant_id, payment_id, event, detail) values (pay.tenant_id, pay.id, 'failed', jsonb_build_object('provider', p_provider));
    return jsonb_build_object('ok', true, 'status', 'failed');
  end if;
  if p_amount is distinct from pay.expected_amount then
    insert into public.billing_events (tenant_id, payment_id, event, detail)
    values (pay.tenant_id, pay.id, 'amount_mismatch', jsonb_build_object('expected', pay.expected_amount, 'received', p_amount));
    return jsonb_build_object('ok', false, 'reason', 'amount_mismatch');
  end if;
  if exists (select 1 from public.billing_payments where provider = p_provider and provider_reference = p_provider_ref and id <> pay.id) then
    insert into public.billing_events (tenant_id, payment_id, event, detail)
    values (pay.tenant_id, pay.id, 'duplicate_provider_reference', jsonb_build_object('provider_reference', p_provider_ref));
    return jsonb_build_object('ok', false, 'reason', 'duplicate_provider_reference');
  end if;
  return public.apply_confirmed_payment(pay.id, 'provider_verified', 'webhook:' || p_provider, p_provider, p_provider_ref);
end $$;

-- A platform admin confirms a payment received by hand (e.g. MoMo sent to the business number). A note is required.
create or replace function public.admin_confirm_payment(p_payment uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay record; r jsonb;
begin
  if not public.is_platform_admin() then raise exception 'platform admins only' using errcode = '42501'; end if;
  if length(trim(coalesce(p_note, ''))) < 5 then raise exception 'write what proof you saw (reference, sender, time)' using errcode = '22023'; end if;
  select * into pay from public.billing_payments where id = p_payment;
  if not found then raise exception 'payment not found' using errcode = 'P0002'; end if;
  r := public.apply_confirmed_payment(p_payment, 'recorded', 'admin:' || auth.uid(), 'manual', 'manual:' || p_payment);
  update public.billing_payments set note = trim(p_note) where id = p_payment and note is null;
  return r;
end $$;

-- ------------------------------------------------------------ who may call what
revoke all on function public.is_platform_admin(), public.setting_int(text, int), public.subscription_allows_writes(uuid),
  public.tenant_usage(uuid), public.billing_info(uuid), public.create_billing_payment(uuid, text, text, int, text, text),
  public.change_plan(uuid, text), public.admin_confirm_payment(uuid, text) from public, anon;
grant execute on function public.is_platform_admin(), public.tenant_usage(uuid), public.billing_info(uuid),
  public.create_billing_payment(uuid, text, text, int, text, text), public.change_plan(uuid, text),
  public.admin_confirm_payment(uuid, text) to authenticated;
grant execute on function public.setting_int(text, int), public.subscription_allows_writes(uuid) to authenticated, service_role;

revoke all on function public.apply_confirmed_payment(uuid, public.verification_status, text, text, text),
  public.confirm_billing_payment(text, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.apply_confirmed_payment(uuid, public.verification_status, text, text, text),
  public.confirm_billing_payment(text, text, text, bigint, text) to service_role;
