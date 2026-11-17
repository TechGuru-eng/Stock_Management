-- StockCM 0003: business profile + atomic onboarding.
-- A new owner has no tenant yet, so tenant creation cannot go through RLS
-- inserts. It happens in ONE security-definer function that:
--   * only works for an authenticated user,
--   * refuses if the user already owns a business (no duplicate trials),
--   * creates tenant, first shop, owner membership, trial subscription and an audit row
--     in a single transaction (all or nothing).

create table public.business_profiles (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  town text,
  address text,
  owner_name text,
  owner_phone text,
  logo_path text,
  employee_count integer not null default 0 check (employee_count between 0 and 500),
  updated_at timestamptz not null default now()
);
alter table public.business_profiles enable row level security;
create policy business_profiles_select on public.business_profiles for select
  using (tenant_id in (select public.my_tenants()));
create policy business_profiles_update on public.business_profiles for update
  using (public.has_permission(tenant_id, 'settings.write'))
  with check (public.has_permission(tenant_id, 'settings.write'));

create or replace function public.onboard_business(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_tenant uuid;
  v_shop uuid;
  v_trial_days integer;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if exists (select 1 from public.memberships where user_id = v_user and role = 'owner') then
    raise exception 'this account already owns a business' using errcode = '23505';
  end if;
  if length(trim(coalesce(p->>'business_name',''))) < 2 then
    raise exception 'business name is required' using errcode = '22023';
  end if;

  select coalesce((value #>> '{}')::integer, 30) into v_trial_days
    from public.platform_settings where key = 'trial_days';

  insert into public.tenants (name, category, language, tax_id, oversell_policy)
  values (
    trim(p->>'business_name'),
    coalesce(p->>'category','general_store')::public.business_category,
    coalesce(p->>'language','fr'),
    nullif(trim(p->>'tax_id'), ''),
    coalesce(p->>'oversell_policy','allow_and_flag'))
  returning id into v_tenant;

  insert into public.shops (tenant_id, name, town)
  values (v_tenant, trim(p->>'business_name'), p->>'town')
  returning id into v_shop;

  insert into public.memberships (tenant_id, user_id, role, full_name, phone)
  values (v_tenant, v_user, 'owner', p->>'owner_name', p->>'owner_phone');

  insert into public.membership_shops (membership_id, shop_id, tenant_id)
  select id, v_shop, v_tenant from public.memberships
   where tenant_id = v_tenant and user_id = v_user;

  insert into public.business_profiles
    (tenant_id, town, address, owner_name, owner_phone, employee_count)
  values (v_tenant, p->>'town', nullif(trim(p->>'address'), ''), p->>'owner_name',
          p->>'owner_phone', coalesce((p->>'employee_count')::integer, 0));

  insert into public.subscriptions (tenant_id, plan_code, status, period_end)
  values (v_tenant, 'business', 'trial', now() + make_interval(days => v_trial_days));

  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after_state)
  values (v_tenant, v_user, 'business.onboarded', 'tenant', v_tenant, p);

  return v_tenant;
end $$;

revoke all on function public.onboard_business(jsonb) from public, anon;
grant execute on function public.onboard_business(jsonb) to authenticated;
