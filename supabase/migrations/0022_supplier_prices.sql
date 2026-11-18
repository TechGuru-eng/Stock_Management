-- StockCM 0022: supplier price lists.
-- What each supplier quotes for a product (per unit: bottle, carton...). Append-only history: a new quote is a new row, the newest wins,
-- nothing is edited or deleted, so price changes can be seen over time. Needs the right to manage purchases.

create table public.supplier_prices (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id),
  product_id uuid not null references public.products(id),
  unit_id uuid not null references public.product_units(id),
  price bigint not null check (price >= 0),
  source text not null check (source in ('manual', 'import')),
  recorded_by uuid references auth.users(id),
  recorded_at timestamptz not null
);
create index on public.supplier_prices (supplier_id, product_id, unit_id, recorded_at desc);
create index on public.supplier_prices (product_id);

do $$
begin
  execute 'alter table public.supplier_prices add column if not exists changed_at timestamptz not null default clock_timestamp()';
  execute 'create index on public.supplier_prices (tenant_id, changed_at)';
  execute 'create trigger stamp_changed_at before insert or update on public.supplier_prices for each row execute function public.stamp_changed_at()';
  execute 'create trigger supplier_prices_immutable before update or delete on public.supplier_prices for each row execute function public.prevent_mutation()';
  execute 'alter table public.supplier_prices enable row level security';
  execute 'create policy tenant_isolation_select on public.supplier_prices for select using (tenant_id in (select public.my_tenants()))';
  execute 'create policy supplier_prices_insert on public.supplier_prices for insert with check (public.has_permission(tenant_id, ''purchases.manage''))';
end $$;

-- the supplier, product and unit must all belong to this business, and the unit to this product
create or replace function public.check_supplier_price() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.suppliers where id = new.supplier_id and tenant_id = new.tenant_id)
     or not exists (select 1 from public.product_units u join public.products p on p.id = u.product_id
                     where u.id = new.unit_id and u.product_id = new.product_id and u.tenant_id = new.tenant_id and p.tenant_id = new.tenant_id) then
    raise exception 'supplier price does not belong to this business' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger supplier_price_guard before insert on public.supplier_prices for each row execute function public.check_supplier_price();

do $$
declare def text;
begin
  def := pg_get_functiondef('public.sync_push(uuid, jsonb)'::regprocedure);
  if position('supplier_prices' in def) = 0 then
    def := replace(def, E'    else\n      raise exception ''unknown table %'', t using errcode = ''22023'';',
$p$    elsif t = 'supplier_prices' then
      insert into public.supplier_prices (id, tenant_id, supplier_id, product_id, unit_id, price, source, recorded_by, recorded_at)
      select id, tenant_id, supplier_id, product_id, unit_id, price, source, auth.uid(), recorded_at from jsonb_populate_record(null::public.supplier_prices, pl);
    else
      raise exception 'unknown table %', t using errcode = '22023';$p$);
    if position('supplier_prices' in def) = 0 then raise exception 'could not extend sync_push'; end if;
    execute def;
  end if;
  def := pg_get_functiondef('public.sync_pull(timestamp with time zone, integer)'::regprocedure);
  if position('supplier_prices' in def) = 0 then
    def := replace(def, '''stock_count_decisions'']', '''stock_count_decisions'',''supplier_prices'']');
    if position('supplier_prices' in def) = 0 then raise exception 'could not extend sync_pull'; end if;
    execute def;
  end if;
end $$;

revoke all on function public.check_supplier_price() from public, anon;
revoke all on function public.sync_push(uuid, jsonb) from public, anon;
grant execute on function public.sync_push(uuid, jsonb) to authenticated;
revoke all on function public.sync_pull(timestamptz, int) from public, anon;
grant execute on function public.sync_pull(timestamptz, int) to authenticated;
