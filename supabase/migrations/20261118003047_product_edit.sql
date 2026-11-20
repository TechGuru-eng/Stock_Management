-- StockCM 0021: editing products and unit prices.
-- Products were insert-only. Two new upload operations change them, each recorded in an append-only change log:
--   product_edit : name, barcode (set, change or clear), sku, minimum stock, tax rate, active (hide / show)
--   unit_edit    : a unit's selling price and name
-- NOT editable (they would corrupt stock and history): the base unit, a unit's factor, whether it is a service.
-- Past sales keep the price they were sold at (every sale line stores its own price), so a price change only affects new sales.
-- Both run under the caller's row-level security (right to edit products); a barcode or sku clash is refused by the unique indexes.

create table public.product_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  product_id uuid not null references public.products(id),
  unit_id uuid references public.product_units(id),
  changed_by uuid references auth.users(id),
  changes jsonb not null,
  before jsonb,
  at timestamptz not null default now()
);
create index on public.product_changes (tenant_id, product_id, at desc);
alter table public.product_changes enable row level security;
create policy tenant_isolation_select on public.product_changes for select using (tenant_id in (select public.my_tenants()));
create policy product_changes_insert on public.product_changes for insert
  with check (public.has_permission(tenant_id, 'products.write') and changed_by = auth.uid());
create trigger product_changes_immutable before update or delete on public.product_changes for each row execute function public.prevent_mutation();

do $$
declare def text;
begin
  def := pg_get_functiondef('public.sync_push(uuid, jsonb)'::regprocedure);
  if position('product_edit' in def) = 0 then
    def := replace(def, E'    else\n      raise exception ''unknown table %'', t using errcode = ''22023'';',
$p$    elsif t = 'product_edit' then
      select * into v_prod from public.products where id = (pl->>'id')::uuid and tenant_id = (pl->>'tenant_id')::uuid;
      if not found then raise exception 'product not found' using errcode = '23514'; end if;
      if pl ? 'name' and (length(trim(pl->>'name')) not between 1 and 120) then raise exception 'name: 1 to 120 characters' using errcode = '23514'; end if;
      if pl ? 'min_stock' and (pl->>'min_stock')::bigint < 0 then raise exception 'minimum stock cannot be negative' using errcode = '23514'; end if;
      if pl ? 'tax_rate_bp' and (pl->>'tax_rate_bp')::int not between 0 and 10000 then raise exception 'tax rate out of range' using errcode = '23514'; end if;
      if pl ? 'active' and (pl->>'active')::boolean and not v_prod.active then
        select pp.max_products into v_limit from public.subscriptions ss join public.plans pp on pp.code = ss.plan_code where ss.tenant_id = v_prod.tenant_id;
        select count(*) into n from public.products where tenant_id = v_prod.tenant_id and active;
        if v_limit is not null and n >= v_limit then raise exception 'plan_limit_products' using errcode = 'SB403'; end if;
      end if;
      update public.products set
        name = case when pl ? 'name' then trim(pl->>'name') else name end,
        barcode = case when pl ? 'barcode' then nullif(trim(coalesce(pl->>'barcode', '')), '') else barcode end,
        sku = case when pl ? 'sku' then nullif(trim(coalesce(pl->>'sku', '')), '') else sku end,
        min_stock = case when pl ? 'min_stock' then (pl->>'min_stock')::bigint else min_stock end,
        tax_rate_bp = case when pl ? 'tax_rate_bp' then (pl->>'tax_rate_bp')::int else tax_rate_bp end,
        active = case when pl ? 'active' then (pl->>'active')::boolean else active end
       where id = v_prod.id;
      insert into public.product_changes (tenant_id, product_id, changed_by, changes, before)
      values (v_prod.tenant_id, v_prod.id, auth.uid(), pl - 'id' - 'tenant_id' - 'before', pl->'before');
    elsif t = 'unit_edit' then
      select * into v_unit from public.product_units where id = (pl->>'id')::uuid and tenant_id = (pl->>'tenant_id')::uuid;
      if not found then raise exception 'unit not found' using errcode = '23514'; end if;
      if pl ? 'sell_price' and (pl->>'sell_price')::bigint < 0 then raise exception 'price cannot be negative' using errcode = '23514'; end if;
      if pl ? 'name' and length(trim(pl->>'name')) not between 1 and 40 then raise exception 'unit name: 1 to 40 characters' using errcode = '23514'; end if;
      if pl ? 'name' and exists (select 1 from public.product_units u where u.product_id = v_unit.product_id and u.id <> v_unit.id and lower(u.name) = lower(trim(pl->>'name'))) then
        raise exception 'this product already has a unit with that name' using errcode = '23505';
      end if;
      update public.product_units set
        name = case when pl ? 'name' then trim(pl->>'name') else name end,
        sell_price = case when pl ? 'sell_price' then (pl->>'sell_price')::bigint else sell_price end
       where id = v_unit.id;
      insert into public.product_changes (tenant_id, product_id, unit_id, changed_by, changes, before)
      values (v_unit.tenant_id, v_unit.product_id, v_unit.id, auth.uid(), pl - 'id' - 'tenant_id' - 'before', pl->'before');
    else
      raise exception 'unknown table %', t using errcode = '22023';$p$);
    -- the new branches need their own variables
    def := replace(def, E'  v_factor bigint; v_qty numeric;', E'  v_factor bigint; v_qty numeric; v_prod public.products; v_unit public.product_units; v_limit int;');
    if position('v_prod public.products' in def) = 0 or position('product_edit' in def) = 0 then raise exception 'could not extend sync_push'; end if;
    execute def;
  end if;
end $$;
revoke all on function public.sync_push(uuid, jsonb) from public, anon;
grant execute on function public.sync_push(uuid, jsonb) to authenticated;
