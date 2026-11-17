-- StockCM 0014: platform administration (the operators' dashboard).
--
-- Principles
--   * Platform admins are NOT members of any business, so row-level security already hides every shop's sales,
--     customers and money from them. They get only the functions below, which expose operational metadata.
--   * Every admin function demands: signed in + listed in platform_admins + a TWO-STEP login (aal2) + the right role.
--   * Roles: super (everything), finance (payments, plans, revenue), support (businesses, support, sync, announcements).
--   * Seeing a business's support details needs a SUPPORT SESSION: a written reason, valid 1 hour, logged, and visible
--     to the business owner. Even then no sales, customers or financial records are exposed.
--   * Every admin action and every sensitive read is written to admin_audit_logs, which cannot be edited or deleted.

-- ------------------------------------------------------------ roles and tables
alter table public.platform_admins
  add column role text not null default 'super' check (role in ('super','finance','support')),
  add column note text;

alter table public.subscriptions add column status_before_suspension text;

create table public.admin_audit_logs (
  id bigint generated always as identity primary key,
  admin_id uuid not null,
  action text not null,
  tenant_id uuid,
  detail jsonb,
  at timestamptz not null default now()
);
create index on public.admin_audit_logs (at desc);
create index on public.admin_audit_logs (tenant_id, at desc);
create trigger admin_audit_immutable before update or delete on public.admin_audit_logs
  for each row execute function public.prevent_mutation();

create table public.support_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  admin_id uuid not null,
  reason text not null check (length(trim(reason)) >= 10),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);
create index on public.support_grants (tenant_id, created_at desc);

create table public.sync_issues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  group_id uuid not null,
  device_id uuid,
  kind text not null check (kind in ('rejected','conflict')),
  error text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  resolved_at timestamptz,
  unique (tenant_id, group_id)
);

alter table public.admin_audit_logs enable row level security;       -- no policy: only the functions below
alter table public.support_grants enable row level security;
alter table public.sync_issues enable row level security;
-- The business owner can see when and why StockCM support looked at their account.
create policy support_grants_select on public.support_grants for select using (tenant_id in (select public.my_tenants()));

-- ------------------------------------------------------------ the gate every admin function passes through
create or replace function public.admin_perm_ok(p_role text, p_perm text) returns boolean
language sql immutable as $$
  select case p_role
    when 'super' then true
    when 'finance' then p_perm in ('overview','billing','plans','revenue')
    when 'support' then p_perm in ('overview','businesses','support','sync','announcements')
    else false end
$$;

create or replace function public.admin_check(p_perm text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare r text;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select role into r from public.platform_admins where user_id = auth.uid();
  if r is null then raise exception 'platform admins only' using errcode = '42501'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'two-step verification required' using errcode = '42501', hint = 'mfa_required';
  end if;
  if not public.admin_perm_ok(r, p_perm) then
    raise exception 'your role is not allowed to do this' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

create or replace function public.admin_log(p_action text, p_tenant uuid, p_detail jsonb default null) returns void
language sql security definer set search_path = public as $$
  insert into public.admin_audit_logs (admin_id, action, tenant_id, detail) values (auth.uid(), p_action, p_tenant, p_detail)
$$;

-- who am I (works before the two-step step, so the login screen knows what to ask for)
create or replace function public.admin_whoami() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('role', a.role, 'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'))
    from public.platform_admins a where a.user_id = auth.uid()
$$;

-- the older helper now also demands the two-step login and the billing role
create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

-- ------------------------------------------------------------ derived subscription state (same rule as everywhere)
create or replace function public.sub_state(s public.subscriptions) returns text
language sql stable set search_path = public as $$
  select case
    when s.status = 'suspended' then 'suspended'
    when now() < s.period_end then case when s.status = 'trial' then 'trial' else 'active' end
    when now() < s.period_end + make_interval(days => public.setting_int('grace_days', 7)) then 'grace'
    else 'expired' end
$$;

-- ------------------------------------------------------------ overview
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  perform public.admin_check('overview');
  select jsonb_build_object(
    'businesses', count(*),
    'trial', count(*) filter (where public.sub_state(s) = 'trial'),
    'paying', count(*) filter (where public.sub_state(s) = 'active'),
    'grace', count(*) filter (where public.sub_state(s) = 'grace'),
    'expired', count(*) filter (where public.sub_state(s) = 'expired'),
    'suspended', count(*) filter (where public.sub_state(s) = 'suspended'),
    -- an ESTIMATE: monthly list price of every paying plan (free months and discounts are not netted out)
    'mrr_estimate', coalesce(sum(p.price_xaf) filter (where public.sub_state(s) = 'active'), 0)
  ) into r
  from public.subscriptions s join public.plans p on p.code = s.plan_code;

  return r || jsonb_build_object(
    'active_shops', (select count(*) from public.shops where active),
    'payments_pending', (select count(*) from public.billing_payments where status = 'pending'),
    'payment_failures_30d', (select count(*) from public.billing_payments where status = 'failed' and created_at > now() - interval '30 days'),
    'revenue_30d', coalesce((select sum(amount) from public.invoices where issued_at > now() - interval '30 days'), 0),
    'devices', jsonb_build_object(
      'total', (select count(*) from public.devices where revoked_at is null),
      'synced_24h', (select count(*) from public.devices where revoked_at is null and last_sync_at > now() - interval '24 hours'),
      'stale_over_48h', (select count(*) from public.devices where revoked_at is null and (last_sync_at is null or last_sync_at < now() - interval '48 hours')),
      'stale_over_30d', (select count(*) from public.devices where revoked_at is null and last_sync_at < now() - interval '30 days')),
    'open_sync_issues', (select count(*) from public.sync_issues where resolved_at is null));
end $$;

-- ------------------------------------------------------------ businesses (metadata only)
create or replace function public.admin_list_businesses(p_search text default null, p_state text default null, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_check('businesses');
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.created_at desc) from (
      select t.id, t.name, t.category, bp.town, t.created_at, s.plan_code, public.sub_state(s) as state, s.period_end,
             (select count(*) from public.shops sh where sh.tenant_id = t.id and sh.active) as shops,
             (select count(*) from public.memberships m where m.tenant_id = t.id and m.active and m.role <> 'owner') as staff,
             (select max(d.last_sync_at) from public.devices d where d.tenant_id = t.id) as last_sync,
             (select count(*) from public.sync_issues i where i.tenant_id = t.id and i.resolved_at is null) as open_issues,
             case when bp.owner_phone is null then null else left(bp.owner_phone, 5) || '••••' || right(bp.owner_phone, 3) end as owner_phone_masked
        from public.tenants t
        join public.subscriptions s on s.tenant_id = t.id
        left join public.business_profiles bp on bp.tenant_id = t.id
       where (p_search is null or t.name ilike '%' || p_search || '%')
         and (p_state is null or public.sub_state(s) = p_state)
       order by t.created_at desc
       limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)
    ) x), '[]'::jsonb);
end $$;

create or replace function public.admin_set_suspension(p_tenant uuid, p_suspended boolean, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  perform public.admin_check('businesses');
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'give a reason' using errcode = '22023'; end if;
  select * into s from public.subscriptions where tenant_id = p_tenant for update;
  if not found then raise exception 'business not found' using errcode = 'P0002'; end if;
  if p_suspended then
    if s.status = 'suspended' then return; end if;
    update public.subscriptions set status_before_suspension = s.status, status = 'suspended', updated_at = now() where tenant_id = p_tenant;
  else
    if s.status <> 'suspended' then return; end if;
    update public.subscriptions set status = coalesce(status_before_suspension, 'active'), status_before_suspension = null, updated_at = now() where tenant_id = p_tenant;
  end if;
  perform public.admin_log(case when p_suspended then 'business.suspended' else 'business.reactivated' end, p_tenant, jsonb_build_object('reason', p_reason));
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id)
  values (p_tenant, auth.uid(), case when p_suspended then 'platform.suspended' else 'platform.reactivated' end, 'tenant', p_tenant);
end $$;

create or replace function public.admin_extend_trial(p_tenant uuid, p_days int, p_reason text) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare s record; new_end timestamptz;
begin
  perform public.admin_check('billing');
  if p_days < 1 or p_days > 90 then raise exception 'between 1 and 90 days' using errcode = '22023'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'give a reason' using errcode = '22023'; end if;
  select * into s from public.subscriptions where tenant_id = p_tenant for update;
  if not found then raise exception 'business not found' using errcode = 'P0002'; end if;
  new_end := greatest(s.period_end, now()) + make_interval(days => p_days);
  update public.subscriptions set period_end = new_end, updated_at = now() where tenant_id = p_tenant;
  perform public.admin_log('subscription.extended', p_tenant, jsonb_build_object('days', p_days, 'reason', p_reason, 'new_end', new_end));
  return new_end;
end $$;

-- ------------------------------------------------------------ plans and settings
create or replace function public.admin_list_plans() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_check('plans');
  return coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object('subscribers', (select count(*) from public.subscriptions s where s.plan_code = p.code))
                                    order by p.price_xaf nulls last) from public.plans p), '[]'::jsonb);
end $$;

create or replace function public.admin_upsert_plan(p_code text, p_name text, p_price bigint, p_max_shops int, p_max_staff int, p_max_products int, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_check('plans');
  if p_code !~ '^[a-z][a-z_]{2,19}$' then raise exception 'plan code: 3-20 lowercase letters' using errcode = '22023'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'plan name is required' using errcode = '22023'; end if;
  if p_price is not null and (p_price < 0 or p_price > 10000000) then raise exception 'price out of range' using errcode = '22023'; end if;
  if (p_max_shops is not null and p_max_shops < 0) or (p_max_staff is not null and p_max_staff < 0) or (p_max_products is not null and p_max_products < 0) then
    raise exception 'limits cannot be negative' using errcode = '22023';
  end if;
  if not p_active and exists (select 1 from public.subscriptions where plan_code = p_code or next_plan_code = p_code) then
    raise exception 'businesses are still on this plan: move them first' using errcode = '22023';
  end if;
  insert into public.plans (code, name, price_xaf, max_shops, max_staff, max_products, active)
  values (p_code, trim(p_name), p_price, p_max_shops, p_max_staff, p_max_products, p_active)
  on conflict (code) do update set name = excluded.name, price_xaf = excluded.price_xaf, max_shops = excluded.max_shops,
    max_staff = excluded.max_staff, max_products = excluded.max_products, active = excluded.active;
  perform public.admin_log('plan.saved', null, jsonb_build_object('code', p_code, 'price', p_price, 'shops', p_max_shops, 'staff', p_max_staff, 'products', p_max_products, 'active', p_active));
end $$;

insert into public.platform_settings (key, value) values
  ('announcement', '{"active":false,"level":"info","fr":"","en":""}'),
  ('maintenance', '{"active":false,"fr":"","en":""}'),
  ('feature_flags', '{}'),
  ('notification_templates', '{}'),
  ('provider_config', '{"name":"","enabled":false}')
on conflict (key) do nothing;

create or replace function public.admin_list_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_check('settings');
  return coalesce((select jsonb_object_agg(key, value) from public.platform_settings), '{}'::jsonb);
end $$;

create or replace function public.admin_set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; e jsonb; n int;
begin
  perform public.admin_check('settings');
  if p_key in ('trial_days','grace_days','offline_limit_days') then
    if jsonb_typeof(p_value) <> 'number' then raise exception 'a number is required' using errcode = '22023'; end if;
    n := (p_value #>> '{}')::int;
    if (p_key = 'trial_days' and n not between 0 and 365) or (p_key = 'grace_days' and n not between 0 and 60) or (p_key = 'offline_limit_days' and n not between 1 and 90) then
      raise exception 'value out of range' using errcode = '22023';
    end if;
  elsif p_key = 'billing_terms' then
    if jsonb_typeof(p_value) <> 'array' or jsonb_array_length(p_value) = 0 then raise exception 'at least one term is required' using errcode = '22023'; end if;
    for e in select * from jsonb_array_elements(p_value) loop
      if (e->>'months') is null or (e->>'months')::int not between 1 and 24 or coalesce((e->>'bonus')::int, 0) not between 0 and 12 then
        raise exception 'term: months 1-24, bonus 0-12' using errcode = '22023';
      end if;
    end loop;
  elsif p_key = 'merchant_numbers' then
    if jsonb_typeof(p_value) <> 'object' then raise exception 'an object is required' using errcode = '22023'; end if;
    for k in select jsonb_object_keys(p_value) loop
      if k not in ('mtn_momo','orange_money') or (p_value->>k) !~ '^(6[0-9]{8})?$' then
        raise exception 'merchant numbers: mtn_momo and orange_money, 9 digits starting with 6' using errcode = '22023';
      end if;
    end loop;
  elsif p_key = 'payment_mode' then
    if p_value not in ('"manual"'::jsonb, '"aggregator"'::jsonb) then raise exception 'manual or aggregator' using errcode = '22023'; end if;
  elsif p_key in ('announcement','maintenance') then
    if jsonb_typeof(p_value) <> 'object' or jsonb_typeof(p_value->'active') <> 'boolean' then raise exception 'active (true/false) is required' using errcode = '22023'; end if;
    if length(coalesce(p_value->>'fr','')) > 300 or length(coalesce(p_value->>'en','')) > 300 then raise exception 'message too long (300 characters)' using errcode = '22023'; end if;
    if p_key = 'announcement' and coalesce(p_value->>'level','info') not in ('info','warn') then raise exception 'level: info or warn' using errcode = '22023'; end if;
  elsif p_key = 'feature_flags' then
    if jsonb_typeof(p_value) <> 'object' then raise exception 'an object is required' using errcode = '22023'; end if;
    for k in select jsonb_object_keys(p_value) loop
      if k !~ '^[a-z][a-z_]{1,29}$' or jsonb_typeof(p_value->k) <> 'boolean' then raise exception 'flags: lowercase names, true/false values' using errcode = '22023'; end if;
    end loop;
  elsif p_key = 'notification_templates' then
    if jsonb_typeof(p_value) <> 'object' then raise exception 'an object is required' using errcode = '22023'; end if;
    for k in select jsonb_object_keys(p_value) loop
      if k not in ('payment_receipt','renewal_5d','renewal_2d','grace_started','expired','debt_reminder')
         or length(coalesce(p_value->k->>'fr','')) > 600 or length(coalesce(p_value->k->>'en','')) > 600 then
        raise exception 'unknown template or too long (600 characters)' using errcode = '22023';
      end if;
    end loop;
  elsif p_key = 'provider_config' then
    if jsonb_typeof(p_value) <> 'object' or jsonb_typeof(p_value->'enabled') <> 'boolean' or length(coalesce(p_value->>'name','')) > 40 then
      raise exception 'provider: name (40 characters) and enabled' using errcode = '22023';
    end if;
  else
    raise exception 'unknown setting' using errcode = '22023';
  end if;
  insert into public.platform_settings (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value;
  perform public.admin_log('setting.changed', null, jsonb_build_object('key', p_key));
end $$;

-- ------------------------------------------------------------ payments and revenue
create or replace function public.admin_list_payments(p_status text default null, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_check('billing');
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.created_at desc) from (
      select p.id, p.reference, t.name as business, p.tenant_id, p.kind, p.plan_code, p.expected_amount as amount, p.method, p.phone,
             p.status, p.created_at, p.confirmed_at, p.confirmed_by, p.note
        from public.billing_payments p join public.tenants t on t.id = p.tenant_id
       where p_status is null or p.status::text = p_status
       order by (p.status = 'pending') desc, p.created_at desc
       limit least(greatest(p_limit, 1), 200)
    ) x), '[]'::jsonb);
end $$;

create or replace function public.admin_reject_payment(p_payment uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare pay record;
begin
  perform public.admin_check('billing');
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'give a reason' using errcode = '22023'; end if;
  select * into pay from public.billing_payments where id = p_payment for update;
  if not found or pay.status <> 'pending' then raise exception 'only a pending payment can be rejected' using errcode = '22023'; end if;
  update public.billing_payments set status = 'failed', note = trim(p_reason) where id = p_payment;
  insert into public.billing_events (tenant_id, payment_id, event, detail) values (pay.tenant_id, pay.id, 'rejected_by_admin', jsonb_build_object('reason', p_reason));
  perform public.admin_log('payment.rejected', pay.tenant_id, jsonb_build_object('payment', p_payment, 'reason', p_reason));
end $$;

-- replaces the version from 0011: now needs the two-step login and the billing role, and is logged
create or replace function public.admin_confirm_payment(p_payment uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay record; r jsonb;
begin
  perform public.admin_check('billing');
  if length(trim(coalesce(p_note, ''))) < 5 then raise exception 'write what proof you saw (reference, sender, time)' using errcode = '22023'; end if;
  select * into pay from public.billing_payments where id = p_payment;
  if not found then raise exception 'payment not found' using errcode = 'P0002'; end if;
  r := public.apply_confirmed_payment(p_payment, 'recorded', 'admin:' || auth.uid(), 'manual', 'manual:' || p_payment);
  update public.billing_payments set note = trim(p_note) where id = p_payment and note is null;
  perform public.admin_log('payment.confirmed_manually', pay.tenant_id, jsonb_build_object('payment', p_payment, 'amount', pay.expected_amount, 'note', p_note));
  return r;
end $$;

create or replace function public.admin_revenue(p_months int default 12) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_check('revenue');
  return jsonb_build_object(
    'by_month', coalesce((select jsonb_agg(row_to_json(m) order by m.month desc) from (
        select to_char(date_trunc('month', issued_at), 'YYYY-MM') as month, sum(amount)::bigint as amount, count(*) as invoices
          from public.invoices where issued_at > date_trunc('month', now()) - make_interval(months => least(greatest(p_months, 1), 36) - 1)
         group by 1) m), '[]'::jsonb),
    'by_plan', coalesce((select jsonb_agg(row_to_json(p)) from (
        select plan_code, sum(amount)::bigint as amount, count(*) as invoices from public.invoices
         where issued_at > now() - interval '12 months' group by plan_code order by 2 desc) p), '[]'::jsonb));
end $$;

-- ------------------------------------------------------------ support sessions
create or replace function public.admin_start_support(p_tenant uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare gid uuid;
begin
  perform public.admin_check('support');
  if length(trim(coalesce(p_reason, ''))) < 10 then raise exception 'write the reason for looking at this account (10+ characters)' using errcode = '22023'; end if;
  if not exists (select 1 from public.tenants where id = p_tenant) then raise exception 'business not found' using errcode = 'P0002'; end if;
  insert into public.support_grants (tenant_id, admin_id, reason, expires_at)
  values (p_tenant, auth.uid(), trim(p_reason), now() + interval '1 hour') returning id into gid;
  perform public.admin_log('support.started', p_tenant, jsonb_build_object('grant', gid, 'reason', p_reason));
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after_state)
  values (p_tenant, auth.uid(), 'platform.support_access_started', 'support_grant', gid, jsonb_build_object('reason', p_reason));
  return gid;
end $$;

create or replace function public.admin_end_support(p_grant uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_check('support');
  update public.support_grants set ended_at = now() where id = p_grant and admin_id = auth.uid() and ended_at is null;
  perform public.admin_log('support.ended', (select tenant_id from public.support_grants where id = p_grant), jsonb_build_object('grant', p_grant));
end $$;

-- Operational detail for ONE business, only inside an open support session. No sales, customers or money.
create or replace function public.admin_support_detail(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ok boolean; r jsonb;
begin
  perform public.admin_check('support');
  select exists (select 1 from public.support_grants g where g.tenant_id = p_tenant and g.admin_id = auth.uid()
                  and g.ended_at is null and g.expires_at > now()) into ok;
  if not ok then raise exception 'start a support session first' using errcode = '42501', hint = 'support_session_required'; end if;
  select jsonb_build_object(
    'business', (select jsonb_build_object('name', t.name, 'category', t.category, 'language', t.language, 'created_at', t.created_at) from public.tenants t where t.id = p_tenant),
    'owner', (select jsonb_build_object('name', bp.owner_name, 'phone', bp.owner_phone, 'town', bp.town) from public.business_profiles bp where bp.tenant_id = p_tenant),
    'subscription', (select jsonb_build_object('plan', s.plan_code, 'state', public.sub_state(s), 'period_end', s.period_end, 'next_plan', s.next_plan_code) from public.subscriptions s where s.tenant_id = p_tenant),
    'usage', jsonb_build_object(
      'shops', (select count(*) from public.shops where tenant_id = p_tenant and active),
      'staff', (select count(*) from public.memberships where tenant_id = p_tenant and active and role <> 'owner'),
      'products', (select count(*) from public.products where tenant_id = p_tenant and active)),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'last_sync_at', d.last_sync_at, 'revoked', d.revoked_at is not null)) from public.devices d where d.tenant_id = p_tenant), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('name', m.full_name, 'role', m.role, 'active', m.active)) from public.memberships m where m.tenant_id = p_tenant and m.role <> 'owner'), '[]'::jsonb),
    'recent_actions', coalesce((select jsonb_agg(jsonb_build_object('action', a.action, 'at', a.created_at) order by a.created_at desc)
                                  from (select action, created_at from public.audit_logs where tenant_id = p_tenant order by created_at desc limit 30) a), '[]'::jsonb),
    'sync_issues', coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'error', i.error, 'last_seen', i.last_seen, 'resolved', i.resolved_at is not null) order by i.last_seen desc)
                               from (select * from public.sync_issues where tenant_id = p_tenant order by last_seen desc limit 30) i), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('reference', b.reference, 'status', b.status, 'amount', b.expected_amount, 'at', b.created_at) order by b.created_at desc)
                            from (select * from public.billing_payments where tenant_id = p_tenant order by created_at desc limit 10) b), '[]'::jsonb)
  ) into r;
  perform public.admin_log('support.viewed_detail', p_tenant, jsonb_build_object('fields', 'operational metadata only'));
  return r;
end $$;

create or replace function public.admin_audit(p_limit int default 100, p_tenant uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_check('support');
  return coalesce((select jsonb_agg(row_to_json(x) order by x.at desc) from (
    select l.id, l.admin_id, l.action, l.tenant_id, (select name from public.tenants t where t.id = l.tenant_id) as business, l.detail, l.at
      from public.admin_audit_logs l where p_tenant is null or l.tenant_id = p_tenant
     order by l.at desc limit least(greatest(p_limit, 1), 500)) x), '[]'::jsonb);
end $$;

-- reading the webhook secret is a sensitive read: super only, and logged
create or replace function public.admin_webhook_secret() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v text;
begin
  perform public.admin_check('settings');
  select value into v from public.platform_secrets where key = 'billing_webhook_secret';
  if v is null then
    v := encode(extensions.gen_random_bytes(32), 'hex');
    insert into public.platform_secrets (key, value) values ('billing_webhook_secret', v);
  end if;
  perform public.admin_log('secret.revealed', null, jsonb_build_object('secret', 'billing_webhook_secret'));
  return v;
end $$;

-- ------------------------------------------------------------ sync issues reported by devices (no business data)
create or replace function public.report_sync_issue(p_tenant uuid, p_device uuid, p_group uuid, p_kind text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant not in (select public.my_tenants()) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_kind not in ('rejected','conflict') then raise exception 'bad kind' using errcode = '22023'; end if;
  insert into public.sync_issues (tenant_id, group_id, device_id, kind, error)
  values (p_tenant, p_group, p_device, p_kind, left(p_error, 300))
  on conflict (tenant_id, group_id) do update set last_seen = now(), kind = excluded.kind, error = excluded.error, resolved_at = null;
end $$;

create or replace function public.resolve_sync_issue(p_tenant uuid, p_group uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant not in (select public.my_tenants()) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.sync_issues set resolved_at = now() where tenant_id = p_tenant and group_id = p_group and resolved_at is null;
end $$;

-- ------------------------------------------------------------ what the apps may know (public by design)
create or replace function public.public_notices() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'announcement', (select value from public.platform_settings where key = 'announcement'),
    'maintenance', (select value from public.platform_settings where key = 'maintenance'),
    'flags', coalesce((select value from public.platform_settings where key = 'feature_flags'), '{}'::jsonb))
$$;

-- ------------------------------------------------------------ who may call what
revoke all on function public.admin_perm_ok(text, text), public.admin_check(text), public.admin_log(text, uuid, jsonb),
  public.sub_state(public.subscriptions) from public, anon, authenticated;
grant execute on function public.admin_perm_ok(text, text), public.sub_state(public.subscriptions) to authenticated, service_role;

revoke all on function public.admin_whoami(), public.admin_overview(), public.admin_list_businesses(text, text, int, int),
  public.admin_set_suspension(uuid, boolean, text), public.admin_extend_trial(uuid, int, text), public.admin_list_plans(),
  public.admin_upsert_plan(text, text, bigint, int, int, int, boolean), public.admin_list_settings(), public.admin_set_setting(text, jsonb),
  public.admin_list_payments(text, int), public.admin_reject_payment(uuid, text), public.admin_confirm_payment(uuid, text),
  public.admin_revenue(int), public.admin_start_support(uuid, text), public.admin_end_support(uuid), public.admin_support_detail(uuid),
  public.admin_audit(int, uuid), public.admin_webhook_secret(), public.report_sync_issue(uuid, uuid, uuid, text, text),
  public.resolve_sync_issue(uuid, uuid), public.public_notices() from public, anon;
grant execute on function public.admin_whoami(), public.admin_overview(), public.admin_list_businesses(text, text, int, int),
  public.admin_set_suspension(uuid, boolean, text), public.admin_extend_trial(uuid, int, text), public.admin_list_plans(),
  public.admin_upsert_plan(text, text, bigint, int, int, int, boolean), public.admin_list_settings(), public.admin_set_setting(text, jsonb),
  public.admin_list_payments(text, int), public.admin_reject_payment(uuid, text), public.admin_confirm_payment(uuid, text),
  public.admin_revenue(int), public.admin_start_support(uuid, text), public.admin_end_support(uuid), public.admin_support_detail(uuid),
  public.admin_audit(int, uuid), public.admin_webhook_secret(), public.report_sync_issue(uuid, uuid, uuid, text, text),
  public.resolve_sync_issue(uuid, uuid) to authenticated;
grant execute on function public.public_notices() to anon, authenticated;
