-- StockCM 0012: change_plan built its "limits broken" list with `broken || 'staff'`, which Postgres tried to read as an
-- array literal. The downgrade was still refused, but with a confusing error. Use array_append with explicit text.
create or replace function public.change_plan(p_tenant uuid, p_plan text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s record; cur record; target record; used jsonb; broken text[] := '{}'::text[];
begin
  if not public.has_permission(p_tenant, 'billing.manage') then
    raise exception 'only the owner can manage billing' using errcode = '42501';
  end if;
  select * into s from public.subscriptions where tenant_id = p_tenant for update;
  select * into cur from public.plans where code = s.plan_code;
  select * into target from public.plans where code = p_plan and active;
  if target.code is null then raise exception 'unknown plan' using errcode = '22023'; end if;
  if target.price_xaf is null then raise exception 'this plan has custom pricing: contact us' using errcode = '22023'; end if;

  if p_plan = s.plan_code then
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

  used := public.tenant_usage(p_tenant);
  if target.max_shops is not null and (used->>'shops')::int > target.max_shops then broken := array_append(broken, 'shops'::text); end if;
  if target.max_staff is not null and (used->>'staff')::int > target.max_staff then broken := array_append(broken, 'staff'::text); end if;
  if target.max_products is not null and (used->>'products')::int > target.max_products then broken := array_append(broken, 'products'::text); end if;
  if coalesce(array_length(broken, 1), 0) > 0 then
    raise exception 'downgrade_blocked: %', array_to_string(broken, ', ') using errcode = '22023';
  end if;
  update public.subscriptions set next_plan_code = p_plan, updated_at = now() where tenant_id = p_tenant;
  return jsonb_build_object('applied', 'at_renewal');
end $$;

revoke all on function public.change_plan(uuid, text) from public, anon;
grant execute on function public.change_plan(uuid, text) to authenticated;
