-- StockCM 0016: several shops per business.
--   * create_shop / update_shop (owner only; plan limit enforced by the existing trigger and re-checked on reactivation)
--   * set_member_shops: which shops each staff member may work in (least privilege: new shops start owner-only)
--   * stock transfers between shops: a transfer_out and a transfer_in that must match exactly, checked on the server

alter table public.shops add constraint shops_name_len check (length(trim(name)) between 2 and 60);

create or replace function public.is_owner(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships where tenant_id = p_tenant and user_id = auth.uid() and role = 'owner' and active)
$$;

create or replace function public.create_shop(p_tenant uuid, p_name text, p_town text) returns uuid
language plpgsql security definer set search_path = public as $$
declare sid uuid; mid uuid;
begin
  if not public.is_owner(p_tenant) then raise exception 'only the owner can add a shop' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 or length(trim(p_name)) > 60 then raise exception 'shop name: 2 to 60 characters' using errcode = '22023'; end if;
  insert into public.shops (tenant_id, name, town) values (p_tenant, trim(p_name), nullif(trim(coalesce(p_town, '')), '')) returning id into sid; -- plan limit: SB403
  insert into public.membership_shops (membership_id, shop_id, tenant_id)
  select id, sid, p_tenant from public.memberships where tenant_id = p_tenant and user_id = auth.uid() and role = 'owner';
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after_state)
  values (p_tenant, auth.uid(), 'shop.created', 'shop', sid, jsonb_build_object('name', trim(p_name)));
  return sid;
end $$;

create or replace function public.update_shop(p_shop uuid, p_name text, p_town text, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare s record; lim int; used int;
begin
  select * into s from public.shops where id = p_shop for update;
  if not found then raise exception 'shop not found' using errcode = 'P0002'; end if;
  if not public.is_owner(s.tenant_id) then raise exception 'only the owner can change a shop' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 or length(trim(p_name)) > 60 then raise exception 'shop name: 2 to 60 characters' using errcode = '22023'; end if;
  if s.active and not p_active then
    if (select count(*) from public.shops where tenant_id = s.tenant_id and active) <= 1 then
      raise exception 'a business needs at least one active shop' using errcode = '22023';
    end if;
  elsif not s.active and p_active then
    select p.max_shops into lim from public.subscriptions x join public.plans p on p.code = x.plan_code where x.tenant_id = s.tenant_id;
    select count(*) into used from public.shops where tenant_id = s.tenant_id and active;
    if lim is not null and used >= lim then
      raise exception 'plan_limit_shops' using errcode = 'SB403', hint = 'This plan allows ' || lim || ' shops. Upgrade the plan to add more.';
    end if;
  end if;
  update public.shops set name = trim(p_name), town = nullif(trim(coalesce(p_town, '')), ''), active = p_active, updated_at = now() where id = p_shop;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after_state)
  values (s.tenant_id, auth.uid(), 'shop.updated', 'shop', p_shop, jsonb_build_object('name', trim(p_name), 'active', p_active));
end $$;

create or replace function public.set_member_shops(p_membership uuid, p_shops uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  select * into m from public.memberships where id = p_membership;
  if not found then raise exception 'member not found' using errcode = 'P0002'; end if;
  if not public.is_owner(m.tenant_id) then raise exception 'only the owner can do this' using errcode = '42501'; end if;
  if m.role = 'owner' then raise exception 'the owner always has every shop' using errcode = '22023'; end if;
  if coalesce(array_length(p_shops, 1), 0) = 0 then raise exception 'choose at least one shop' using errcode = '22023'; end if;
  if exists (select 1 from unnest(p_shops) s where not exists (select 1 from public.shops where id = s and tenant_id = m.tenant_id and active)) then
    raise exception 'unknown shop' using errcode = '22023';
  end if;
  delete from public.membership_shops where membership_id = p_membership and not (shop_id = any (p_shops));
  insert into public.membership_shops (membership_id, shop_id, tenant_id)
  select p_membership, s, m.tenant_id from unnest(p_shops) s on conflict do nothing;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after_state)
  values (m.tenant_id, auth.uid(), 'staff.shops_changed', 'membership', p_membership, jsonb_build_object('shops', p_shops));
end $$;

-- A transfer is two ledger rows that share a reference (the transfer id): out of one shop, into another, same product,
-- same quantity, same value. Checked at commit so both rows may arrive in one upload.
create or replace function public.check_transfer_consistency() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int; q numeric; v numeric; shops_n int; ins int; outs int;
begin
  if new.reference_id is null then
    raise exception 'a transfer needs a reference shared by both sides' using errcode = '23514';
  end if;
  select count(*), coalesce(sum(quantity), 0), coalesce(sum(case when quantity > 0 then total_cost else -total_cost end), 0),
         count(distinct shop_id), count(*) filter (where movement_type = 'transfer_in'), count(*) filter (where movement_type = 'transfer_out')
    into n, q, v, shops_n, ins, outs
    from public.stock_movements
   where reference_id = new.reference_id and product_id = new.product_id and movement_type in ('transfer_in', 'transfer_out');
  if n <> 2 or ins <> 1 or outs <> 1 or q <> 0 or v <> 0 or shops_n <> 2 then
    raise exception 'transfer does not balance: one out and one in, same product, quantity and value, two different shops' using errcode = '23514';
  end if;
  if (select count(distinct tenant_id) from public.stock_movements where reference_id = new.reference_id) <> 1 then
    raise exception 'transfer crosses businesses' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger transfer_consistency after insert on public.stock_movements
  deferrable initially deferred for each row when (new.movement_type in ('transfer_in', 'transfer_out'))
  execute function public.check_transfer_consistency();

revoke all on function public.is_owner(uuid), public.create_shop(uuid, text, text), public.update_shop(uuid, text, text, boolean),
  public.set_member_shops(uuid, uuid[]), public.check_transfer_consistency() from public, anon;
grant execute on function public.is_owner(uuid), public.create_shop(uuid, text, text), public.update_shop(uuid, text, text, boolean),
  public.set_member_shops(uuid, uuid[]) to authenticated;
