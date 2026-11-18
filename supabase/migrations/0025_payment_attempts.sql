-- StockCM 0025: collecting subscription payments through a mobile-money provider (MTN MoMo prompt, Orange Money page).
--
-- The existing flow (0011) stays: the owner creates a payment (pending, with a reference), and the server confirms it.
-- What is new is HOW it can be confirmed without a person: the server asks the provider to collect the money, and later
-- asks the provider what happened. A provider's callback is never believed; it only makes the server ask again.
--
--   payment_attempts : one try to collect one billing payment through one provider. A payment may have several tries
--                      (a wrong PIN, an expired prompt), but never two live at once, and never more than 5.
--   Provider credentials live in platform_secrets ('provider_mtn_momo', 'provider_orange_money'; JSON), readable by the
--   service role only. A platform admin (super) can set them through admin_set_provider and can never read them back.
--   A failed attempt does NOT fail the payment: the payment stays pending so the owner can try again.

create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),      -- also the reference MTN/Orange know the payment by
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  payment_id uuid not null references public.billing_payments(id),
  provider text not null check (provider in ('mtn_momo', 'orange_money')),
  phone text,
  amount bigint not null check (amount > 0),
  status text not null default 'initiated' check (status in ('initiated', 'pending', 'successful', 'failed', 'error')),
  pay_token text,                                      -- Orange's token for this payment (server use only)
  payment_url text,                                    -- where Orange wants the customer to pay
  reason text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  last_checked_at timestamptz,
  check_count int not null default 0,
  finished_at timestamptz
);
create index on public.payment_attempts (payment_id, created_at);
create index on public.payment_attempts (status) where status in ('initiated', 'pending');

alter table public.payment_attempts enable row level security;
create policy payment_attempts_select on public.payment_attempts for select using (public.has_permission(tenant_id, 'billing.manage'));
revoke all on public.payment_attempts from anon, authenticated;
grant select (id, tenant_id, payment_id, provider, phone, amount, status, payment_url, reason, created_at, last_checked_at, check_count, finished_at)
  on public.payment_attempts to authenticated;           -- never pay_token

-- ------------------------------------------------------------ which providers are switched on (booleans only)
create or replace function public.payment_methods_available() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'mtn_momo', exists (select 1 from public.platform_secrets where key = 'provider_mtn_momo'),
    'orange_money', exists (select 1 from public.platform_secrets where key = 'provider_orange_money'))
$$;

-- ------------------------------------------------------------ the owner starts an attempt (called as the owner)
create or replace function public.begin_payment_attempt(p_payment uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay record; n int; aid uuid;
begin
  select * into pay from public.billing_payments where id = p_payment for update;
  if not found or not public.has_permission(pay.tenant_id, 'billing.manage') then
    raise exception 'only the owner can manage billing' using errcode = '42501';
  end if;
  if pay.confirmed_at is not null or exists (select 1 from public.payment_attempts where payment_id = pay.id and status = 'successful') then
    return jsonb_build_object('ok', false, 'reason', 'already_paid');
  end if;
  if pay.status <> 'pending' or pay.method is null then return jsonb_build_object('ok', false, 'reason', 'not_payable'); end if;
  if not exists (select 1 from public.platform_secrets where key = 'provider_' || pay.method) then
    return jsonb_build_object('ok', false, 'reason', 'not_configured');
  end if;
  select count(*) into n from public.payment_attempts where payment_id = pay.id;
  if n >= 5 then return jsonb_build_object('ok', false, 'reason', 'too_many'); end if;
  if exists (select 1 from public.payment_attempts where payment_id = pay.id and status in ('initiated', 'pending') and created_at > now() - interval '3 minutes') then
    return jsonb_build_object('ok', false, 'reason', 'in_progress');
  end if;
  insert into public.payment_attempts (tenant_id, payment_id, provider, phone, amount, created_by)
  values (pay.tenant_id, pay.id, pay.method, pay.phone, pay.expected_amount, auth.uid()) returning id into aid;
  insert into public.billing_events (tenant_id, payment_id, event, detail)
  values (pay.tenant_id, pay.id, 'attempt_started', jsonb_build_object('attempt', aid, 'provider', pay.method, 'by', auth.uid()));
  return jsonb_build_object('ok', true, 'attempt', aid, 'provider', pay.method, 'amount', pay.expected_amount, 'phone', pay.phone, 'reference', pay.reference, 'plan', pay.plan_code);
end $$;

-- ------------------------------------------------------------ server-side steps (service role only)
create or replace function public.payment_attempt_get(p_attempt uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(a) || jsonb_build_object('reference', p.reference, 'tenant', p.tenant_id)
    from public.payment_attempts a join public.billing_payments p on p.id = a.payment_id where a.id = p_attempt
$$;

create or replace function public.payment_attempt_sent(p_attempt uuid, p_pay_token text, p_payment_url text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.payment_attempts set status = 'pending', pay_token = p_pay_token, payment_url = p_payment_url where id = p_attempt and status = 'initiated';
end $$;

-- The provider refused the request itself (bad credentials, outage): the attempt is over, the payment can be retried.
create or replace function public.payment_attempt_error(p_attempt uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  update public.payment_attempts set status = 'error', reason = left(p_reason, 200), finished_at = now()
   where id = p_attempt and status in ('initiated', 'pending') returning * into a;
  if found then
    insert into public.billing_events (tenant_id, payment_id, event, detail) values (a.tenant_id, a.payment_id, 'attempt_error', jsonb_build_object('attempt', a.id, 'reason', left(p_reason, 200)));
  end if;
end $$;

-- Asking the provider is rate-limited per attempt (callbacks are public, so anyone could otherwise make us ask forever).
create or replace function public.payment_attempt_touch(p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record;
begin
  select * into a from public.payment_attempts where id = p_attempt for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_attempt'); end if;
  if a.status not in ('initiated', 'pending') then return jsonb_build_object('ok', true, 'done', true, 'status', a.status); end if;
  if a.last_checked_at is not null and a.last_checked_at > now() - interval '3 seconds' then
    return jsonb_build_object('ok', true, 'throttled', true, 'status', a.status);
  end if;
  update public.payment_attempts set last_checked_at = now(), check_count = check_count + 1 where id = a.id;
  return jsonb_build_object('ok', true, 'status', a.status);
end $$;

-- What the provider said (never what a callback said). 'successful' confirms the payment through the existing, idempotent path.
create or replace function public.settle_payment_attempt(p_attempt uuid, p_state text, p_amount bigint, p_provider_ref text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; pay record; r jsonb;
begin
  select * into a from public.payment_attempts where id = p_attempt for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_attempt'); end if;
  if a.status in ('successful', 'failed', 'error') then return jsonb_build_object('ok', true, 'already', true, 'status', a.status); end if;
  if p_state = 'pending' then return jsonb_build_object('ok', true, 'status', a.status); end if;
  select * into pay from public.billing_payments where id = a.payment_id for update;

  if p_state = 'failed' then
    update public.payment_attempts set status = 'failed', reason = left(p_reason, 200), finished_at = now() where id = a.id;
    insert into public.billing_events (tenant_id, payment_id, event, detail) values (a.tenant_id, a.payment_id, 'attempt_failed', jsonb_build_object('attempt', a.id, 'reason', left(p_reason, 200)));
    return jsonb_build_object('ok', true, 'status', 'failed');
  elsif p_state = 'successful' then
    r := public.confirm_billing_payment(pay.reference, a.provider, p_provider_ref, p_amount, 'successful');
    if (r ->> 'ok')::boolean then
      update public.payment_attempts set status = 'successful', finished_at = now() where id = a.id;
      return jsonb_build_object('ok', true, 'status', 'successful', 'already', coalesce((r ->> 'already')::boolean, false));
    end if;
    -- Money moved but the payment could not be confirmed (amount differs, reference already used): a person must look. Never silent.
    update public.payment_attempts set status = 'error', reason = left(coalesce(r ->> 'reason', 'not_confirmed'), 200), finished_at = now() where id = a.id;
    insert into public.billing_events (tenant_id, payment_id, event, detail)
    values (a.tenant_id, a.payment_id, 'attempt_needs_review', jsonb_build_object('attempt', a.id, 'reason', r ->> 'reason', 'amount', p_amount));
    return jsonb_build_object('ok', false, 'status', 'error', 'reason', r ->> 'reason');
  end if;
  raise exception 'unknown state' using errcode = '22023';
end $$;

-- Open attempts, for a scheduled sweep that catches a callback that never arrived.
create or replace function public.payment_attempts_open(p_limit int) returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from public.payment_attempts where status in ('initiated', 'pending') and created_at > now() - interval '2 days'
   order by coalesce(last_checked_at, created_at) limit least(coalesce(p_limit, 20), 100)
$$;

-- ------------------------------------------------------------ platform admin (super only): set / inspect provider credentials
create or replace function public.admin_set_provider(p_provider text, p_config jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  uid := public.admin_check('providers');
  if p_provider not in ('mtn_momo', 'orange_money') then raise exception 'unknown provider' using errcode = '22023'; end if;
  if p_config is null or p_config = 'null'::jsonb then
    delete from public.platform_secrets where key = 'provider_' || p_provider;
  else
    if jsonb_typeof(p_config) <> 'object' then raise exception 'config must be an object' using errcode = '22023'; end if;
    insert into public.platform_secrets (key, value) values ('provider_' || p_provider, p_config::text)
      on conflict (key) do update set value = excluded.value;
  end if;
  perform public.admin_log('provider.set', null, jsonb_build_object('provider', p_provider, 'removed', p_config is null or p_config = 'null'::jsonb));
end $$;

create or replace function public.admin_provider_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_check('providers');
  return jsonb_build_object(
    'mtn_momo', (select jsonb_build_object('set', true, 'target', value::jsonb ->> 'targetEnvironment', 'currency', value::jsonb ->> 'currency') from public.platform_secrets where key = 'provider_mtn_momo'),
    'orange_money', (select jsonb_build_object('set', true, 'currency', value::jsonb ->> 'currency') from public.platform_secrets where key = 'provider_orange_money'));
end $$;

-- ------------------------------------------------------------ permissions
revoke all on function public.payment_methods_available(), public.begin_payment_attempt(uuid), public.payment_attempt_get(uuid),
  public.payment_attempt_sent(uuid, text, text), public.payment_attempt_error(uuid, text), public.payment_attempt_touch(uuid),
  public.settle_payment_attempt(uuid, text, bigint, text, text), public.payment_attempts_open(int),
  public.admin_set_provider(text, jsonb), public.admin_provider_status() from public, anon, authenticated;
grant execute on function public.payment_methods_available(), public.begin_payment_attempt(uuid), public.admin_set_provider(text, jsonb), public.admin_provider_status() to authenticated;
grant execute on function public.payment_attempt_get(uuid), public.payment_attempt_sent(uuid, text, text), public.payment_attempt_error(uuid, text),
  public.payment_attempt_touch(uuid), public.settle_payment_attempt(uuid, text, bigint, text, text), public.payment_attempts_open(int) to service_role;
