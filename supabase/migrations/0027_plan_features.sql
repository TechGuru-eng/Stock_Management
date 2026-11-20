-- Updated plan pricing, limits and the first plan-gated features (decided 20 Nov 2026, see docs/ARCHITECTURE.md).
-- `plans.features` already existed (jsonb, default '{}') but was never populated or read; this is its first use.
-- Business and up: verified mobile money at the till, and customer loyalty points.

update public.plans set price_xaf = 5000, max_shops = 1, max_staff = 3, max_products = 1000, features = '[]'::jsonb
  where code = 'starter';
update public.plans set price_xaf = 15000, max_shops = 3, max_staff = 10, max_products = 5000, features = '["verified_momo","loyalty"]'::jsonb
  where code = 'business';
update public.plans set price_xaf = 25000, max_shops = 10, max_staff = null, max_products = null, features = '["verified_momo","loyalty"]'::jsonb
  where code = 'pro';
update public.plans set features = '["verified_momo","loyalty"]'::jsonb
  where code = 'enterprise';

-- Setting up a till provider's account credentials (MTN MoMo / Orange Money) now requires the verified_momo
-- feature. Removing a provider is always allowed, even on a plan that no longer includes it.
create or replace function public.set_tenant_provider(p_tenant uuid, p_provider text, p_config jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  has_feature boolean;
begin
  if not public.has_permission(p_tenant, 'settings.write') then raise exception 'only the owner can do this' using errcode = '42501'; end if;
  if p_provider not in ('mtn_momo', 'orange_money') then raise exception 'unknown provider' using errcode = '22023'; end if;
  if p_config is not null and p_config <> 'null'::jsonb then
    select coalesce(p.features, '[]'::jsonb) ? 'verified_momo' into has_feature
      from public.subscriptions s join public.plans p on p.code = s.plan_code where s.tenant_id = p_tenant;
    if not coalesce(has_feature, false) then
      raise exception 'Your plan does not include verified mobile money. Upgrade to Business or higher.' using errcode = '42501';
    end if;
  end if;
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

-- Let the admin dashboard manage features alongside the other plan fields. Dropped and recreated (not
-- `create or replace`) because the parameter list grew: a same-arity replace would leave the old 7-argument
-- version callable as a separate overload instead of being replaced.
drop function if exists public.admin_upsert_plan(text, text, bigint, int, int, int, boolean);

create function public.admin_upsert_plan(p_code text, p_name text, p_price bigint, p_max_shops int, p_max_staff int, p_max_products int, p_active boolean, p_features jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_check('plans');
  if p_code !~ '^[a-z][a-z_]{2,19}$' then raise exception 'plan code: 3-20 lowercase letters' using errcode = '22023'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'plan name is required' using errcode = '22023'; end if;
  if p_price is not null and (p_price < 0 or p_price > 10000000) then raise exception 'price out of range' using errcode = '22023'; end if;
  if (p_max_shops is not null and p_max_shops < 0) or (p_max_staff is not null and p_max_staff < 0) or (p_max_products is not null and p_max_products < 0) then
    raise exception 'limits cannot be negative' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_features, '[]'::jsonb)) <> 'array' then raise exception 'features must be a list' using errcode = '22023'; end if;
  if not p_active and exists (select 1 from public.subscriptions where plan_code = p_code or next_plan_code = p_code) then
    raise exception 'businesses are still on this plan: move them first' using errcode = '22023';
  end if;
  insert into public.plans (code, name, price_xaf, max_shops, max_staff, max_products, active, features)
  values (p_code, trim(p_name), p_price, p_max_shops, p_max_staff, p_max_products, p_active, coalesce(p_features, '[]'::jsonb))
  on conflict (code) do update set name = excluded.name, price_xaf = excluded.price_xaf, max_shops = excluded.max_shops,
    max_staff = excluded.max_staff, max_products = excluded.max_products, active = excluded.active, features = excluded.features;
  perform public.admin_log('plan.saved', null, jsonb_build_object('code', p_code, 'price', p_price, 'shops', p_max_shops, 'staff', p_max_staff, 'products', p_max_products, 'active', p_active, 'features', p_features));
end $$;

revoke all on function public.admin_upsert_plan(text, text, bigint, int, int, int, boolean, jsonb) from public, anon;
grant execute on function public.admin_upsert_plan(text, text, bigint, int, int, int, boolean, jsonb) to authenticated;
