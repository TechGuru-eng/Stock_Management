-- StockCM 0026: mobile money collected at the till (MTN MoMo prompt / Orange Money page), paid straight into the BUSINESS's own provider account.
--
--   tenant_provider_secrets : the business's own provider credentials. Server-only; the owner can set or remove them and can never read them back.
--   till_collections        : one request to collect one amount from a customer's phone. Truth comes only from asking the provider (the edge function does
--                             that); a callback is never believed. Money collected but not yet used by a sale stays visible.
--   financial_transactions.collection_id : a sale's mobile-money payment claims a collection. The database checks the claim against its own record
--                             (successful, same business and shop, exact amount, same method, never used before) and ITSELF sets the payment to
--                             provider_verified with the provider's reference. A device saying "verified" proves nothing.
-- A failed collection changes nothing about any sale.

create table public.tenant_provider_secrets (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null check (provider in ('mtn_momo', 'orange_money')),
  config text not null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, provider)
);
alter table public.tenant_provider_secrets enable row level security;   -- no policy: service role only
revoke all on public.tenant_provider_secrets from anon, authenticated;

create or replace function public.set_tenant_provider(p_tenant uuid, p_provider text, p_config jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_permission(p_tenant, 'settings.write') then raise exception 'only the owner can do this' using errcode = '42501'; end if;
  if p_provider not in ('mtn_momo', 'orange_money') then raise exception 'unknown provider' using errcode = '22023'; end if;
  if p_config is null or p_config = 'null'::jsonb then
    delete from public.tenant_provider_secrets where tenant_id = p_tenant and provider = p_provider;
  else
    if jsonb_typeof(p_config) <> 'object' then raise exception 'config must be an object' using errcode = '22023'; end if;
    insert into public.tenant_provider_secrets (tenant_id, provider, config, updated_by) values (p_tenant, p_provider, p_config::text, auth.uid())
      on conflict (tenant_id, provider) do update set config = excluded.config, updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into public.audit_logs (tenant_id, action, entity, entity_id, after_state)
  values (p_tenant, 'till_provider.set', 'tenant_provider', null, jsonb_build_object('provider', p_provider, 'removed', p_config is null or p_config = 'null'::jsonb));
end $$;

-- Which providers this business has switched on (booleans only: what a cashier needs to know to show the button).
create or replace function public.tenant_providers(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if p_tenant not in (select public.my_tenants()) then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'mtn_momo', exists (select 1 from public.tenant_provider_secrets where tenant_id = p_tenant and provider = 'mtn_momo'),
    'orange_money', exists (select 1 from public.tenant_provider_secrets where tenant_id = p_tenant and provider = 'orange_money'));
end $$;

create table public.till_collections (
  id uuid primary key default gen_random_uuid(),         -- also the reference the provider knows the payment by (repeating a request cannot charge twice)
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  shop_id uuid not null references public.shops(id),
  provider text not null check (provider in ('mtn_momo', 'orange_money')),
  phone text not null check (phone ~ '^\+2376[0-9]{8}$'),
  amount bigint not null check (amount between 100 and 2000000),
  status text not null default 'initiated' check (status in ('initiated', 'pending', 'successful', 'failed', 'error')),
  pay_token text,
  payment_url text,
  provider_reference text,
  reason text,
  sale_id uuid references public.sales(id),              -- set by the database when a sale uses it
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  last_checked_at timestamptz,
  check_count int not null default 0,
  finished_at timestamptz
);
create index on public.till_collections (tenant_id, shop_id, created_at desc);
create index on public.till_collections (status) where status in ('initiated', 'pending');
create unique index till_collections_provider_ref on public.till_collections (tenant_id, provider, provider_reference) where provider_reference is not null;

alter table public.till_collections enable row level security;
create policy till_collections_select on public.till_collections for select using (public.has_permission(tenant_id, 'sales.create'));
revoke all on public.till_collections from anon, authenticated;
grant select (id, tenant_id, shop_id, provider, phone, amount, status, payment_url, provider_reference, reason, sale_id, created_by, created_at, finished_at)
  on public.till_collections to authenticated;           -- never pay_token

-- The cashier asks to collect (called as the cashier).
create or replace function public.begin_till_collection(p_shop uuid, p_provider text, p_phone text, p_amount bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tid uuid; cid uuid; live int;
begin
  select tenant_id into tid from public.shops where id = p_shop and active;
  if tid is null or not public.has_permission(tid, 'sales.create') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_provider not in ('mtn_momo', 'orange_money') then raise exception 'unknown provider' using errcode = '22023'; end if;
  if p_phone !~ '^\+2376[0-9]{8}$' then return jsonb_build_object('ok', false, 'reason', 'phone'); end if;
  if p_amount is null or p_amount < 100 or p_amount > 2000000 then return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
  if not exists (select 1 from public.tenant_provider_secrets where tenant_id = tid and provider = p_provider) then
    return jsonb_build_object('ok', false, 'reason', 'not_configured');
  end if;
  select count(*) into live from public.till_collections where created_by = auth.uid() and status in ('initiated', 'pending') and created_at > now() - interval '3 minutes';
  if live >= 3 then return jsonb_build_object('ok', false, 'reason', 'too_many_open'); end if;
  insert into public.till_collections (tenant_id, shop_id, provider, phone, amount, created_by) values (tid, p_shop, p_provider, p_phone, p_amount, auth.uid()) returning id into cid;
  return jsonb_build_object('ok', true, 'id', cid, 'tenant', tid, 'provider', p_provider, 'phone', p_phone, 'amount', p_amount);
end $$;

-- ------------------------------------------------------------ server-side steps (service role only)
create or replace function public.till_collection_get(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(c) from public.till_collections c where c.id = p_id
$$;

create or replace function public.till_collection_sent(p_id uuid, p_pay_token text, p_payment_url text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.till_collections set status = 'pending', pay_token = p_pay_token, payment_url = p_payment_url where id = p_id and status = 'initiated';
end $$;

create or replace function public.till_collection_error(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.till_collections set status = 'error', reason = left(p_reason, 200), finished_at = now() where id = p_id and status in ('initiated', 'pending');
end $$;

create or replace function public.till_collection_touch(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from public.till_collections where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  if c.status not in ('initiated', 'pending') then return jsonb_build_object('ok', true, 'done', true, 'status', c.status); end if;
  if c.last_checked_at is not null and c.last_checked_at > now() - interval '3 seconds' then
    return jsonb_build_object('ok', true, 'throttled', true, 'status', c.status);
  end if;
  update public.till_collections set last_checked_at = now(), check_count = check_count + 1 where id = c.id;
  return jsonb_build_object('ok', true, 'status', c.status);
end $$;

-- What the provider said. A success whose amount differs from what was asked is NOT usable: it becomes an 'error' the owner can see
-- (money moved, a person must look). A provider reference can belong to one collection only.
create or replace function public.settle_till_collection(p_id uuid, p_state text, p_amount bigint, p_provider_ref text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  select * into c from public.till_collections where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  if c.status in ('successful', 'failed', 'error') then return jsonb_build_object('ok', true, 'already', true, 'status', c.status); end if;
  if p_state = 'pending' then return jsonb_build_object('ok', true, 'status', c.status); end if;
  if p_state = 'failed' then
    update public.till_collections set status = 'failed', reason = left(p_reason, 200), finished_at = now() where id = c.id;
    return jsonb_build_object('ok', true, 'status', 'failed');
  elsif p_state = 'successful' then
    if p_amount is distinct from c.amount then
      update public.till_collections set status = 'error', reason = 'amount_mismatch: asked ' || c.amount || ', provider says ' || coalesce(p_amount::text, '?'), finished_at = now() where id = c.id;
      return jsonb_build_object('ok', false, 'status', 'error', 'reason', 'amount_mismatch');
    end if;
    if p_provider_ref is null or exists (select 1 from public.till_collections where tenant_id = c.tenant_id and provider = c.provider and provider_reference = p_provider_ref and id <> c.id) then
      update public.till_collections set status = 'error', reason = 'provider_reference_missing_or_reused', finished_at = now() where id = c.id;
      return jsonb_build_object('ok', false, 'status', 'error', 'reason', 'provider_reference');
    end if;
    update public.till_collections set status = 'successful', provider_reference = p_provider_ref, finished_at = now() where id = c.id;
    return jsonb_build_object('ok', true, 'status', 'successful');
  end if;
  raise exception 'unknown state' using errcode = '22023';
end $$;

create or replace function public.till_collections_open(p_limit int) returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from public.till_collections where status in ('initiated', 'pending') and created_at > now() - interval '2 days'
   order by coalesce(last_checked_at, created_at) limit least(coalesce(p_limit, 20), 100)
$$;

-- ------------------------------------------------------------ a sale's payment claims a collection
alter table public.financial_transactions add column collection_id uuid references public.till_collections(id);
create unique index financial_transactions_collection on public.financial_transactions (collection_id) where collection_id is not null;

create or replace function public.check_txn_collection() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if new.collection_id is null then return new; end if;     -- no claim: stays as the device said (the table's own check refuses a "verified" without a reference)
  select * into c from public.till_collections where id = new.collection_id for update;
  if not found or c.tenant_id <> new.tenant_id or c.shop_id is distinct from new.shop_id or c.status <> 'successful' or c.sale_id is not null
     or new.txn_type <> 'sale_collection' or new.sale_id is null or c.amount <> new.amount or c.provider <> new.method::text then
    raise exception 'that mobile-money payment cannot be used for this sale' using errcode = '23514';
  end if;
  new.verification := 'provider_verified';
  new.provider_reference := c.provider_reference;
  update public.till_collections set sale_id = new.sale_id where id = c.id;
  return new;
end $$;
create trigger financial_transactions_collection before insert on public.financial_transactions for each row execute function public.check_txn_collection();

-- the upload carries the claim (and only the claim)
do $$
declare def text;
begin
  def := pg_get_functiondef('public.sync_push(uuid, jsonb)'::regprocedure);
  if position('collection_id' in def) = 0 then
    def := replace(def,
      E'staff_id, device_id, customer_id, sale_id, return_id, description, occurred_at)\n      select id, tenant_id, shop_id, reference, txn_type, amount, method, verification,\n             auth.uid(), p_device, customer_id, sale_id, return_id, description, occurred_at\n        from jsonb_populate_record(null::public.financial_transactions, pl);',
      E'staff_id, device_id, customer_id, sale_id, return_id, description, occurred_at, collection_id)\n      select id, tenant_id, shop_id, reference, txn_type, amount, method, verification,\n             auth.uid(), p_device, customer_id, sale_id, return_id, description, occurred_at, collection_id\n        from jsonb_populate_record(null::public.financial_transactions, pl);');
    if position('collection_id' in def) = 0 then raise exception 'could not extend sync_push'; end if;
    execute def;
  end if;
end $$;

revoke all on function public.set_tenant_provider(uuid, text, jsonb), public.tenant_providers(uuid), public.begin_till_collection(uuid, text, text, bigint),
  public.till_collection_get(uuid), public.till_collection_sent(uuid, text, text), public.till_collection_error(uuid, text), public.till_collection_touch(uuid),
  public.settle_till_collection(uuid, text, bigint, text, text), public.till_collections_open(int), public.check_txn_collection() from public, anon, authenticated;
grant execute on function public.set_tenant_provider(uuid, text, jsonb), public.tenant_providers(uuid), public.begin_till_collection(uuid, text, text, bigint) to authenticated;
grant execute on function public.till_collection_get(uuid), public.till_collection_sent(uuid, text, text), public.till_collection_error(uuid, text), public.till_collection_touch(uuid),
  public.settle_till_collection(uuid, text, bigint, text, text), public.till_collections_open(int) to service_role;
revoke all on function public.sync_push(uuid, jsonb) from public, anon;
grant execute on function public.sync_push(uuid, jsonb) to authenticated;
