-- StockCM 0023: expiry tracking (best-before dates).
--   stock_batches : goods that came in with a date (how many units, expiring when). Append-only. Remaining quantity per batch is
--                   DERIVED from stock movements (oldest goes first), so there is nothing to keep in step.
--   products.track_batches (already there) can now be switched with a product_edit operation.

create table public.stock_batches (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  shop_id uuid not null references public.shops(id) on delete restrict,
  product_id uuid not null references public.products(id),
  expiry date not null,
  quantity bigint not null check (quantity > 0),
  received_at timestamptz not null,
  recorded_by uuid references auth.users(id)
);
create index on public.stock_batches (shop_id, product_id, expiry);

do $$
begin
  execute 'alter table public.stock_batches add column if not exists changed_at timestamptz not null default clock_timestamp()';
  execute 'create index on public.stock_batches (tenant_id, changed_at)';
  execute 'create trigger stamp_changed_at before insert or update on public.stock_batches for each row execute function public.stamp_changed_at()';
  execute 'create trigger stock_batches_immutable before update or delete on public.stock_batches for each row execute function public.prevent_mutation()';
  execute 'alter table public.stock_batches enable row level security';
  execute 'create policy tenant_isolation_select on public.stock_batches for select using (tenant_id in (select public.my_tenants()))';
  execute 'create policy stock_batches_insert on public.stock_batches for insert with check (public.has_permission(tenant_id, ''stock.receive''))';
end $$;

-- shop and product belong to this business, and the product really tracks dates; the date is sensible
create or replace function public.check_stock_batch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.shops where id = new.shop_id and tenant_id = new.tenant_id)
     or not exists (select 1 from public.products where id = new.product_id and tenant_id = new.tenant_id and track_batches) then
    raise exception 'batch does not belong to this business, or the product does not track expiry dates' using errcode = '23514';
  end if;
  if new.expiry < current_date - 366 or new.expiry > current_date + 3650 then
    raise exception 'expiry date out of range' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger stock_batch_guard before insert on public.stock_batches for each row execute function public.check_stock_batch();

do $$
declare def text;
begin
  def := pg_get_functiondef('public.sync_push(uuid, jsonb)'::regprocedure);
  if position('stock_batches' in def) = 0 then
    def := replace(def, E'    else\n      raise exception ''unknown table %'', t using errcode = ''22023'';',
$p$    elsif t = 'stock_batches' then
      insert into public.stock_batches (id, tenant_id, shop_id, product_id, expiry, quantity, received_at, recorded_by)
      select id, tenant_id, shop_id, product_id, expiry, quantity, received_at, auth.uid() from jsonb_populate_record(null::public.stock_batches, pl);
    else
      raise exception 'unknown table %', t using errcode = '22023';$p$);
    if position('stock_batches' in def) = 0 then raise exception 'could not extend sync_push'; end if;
    -- a product edit may switch date tracking on or off
    def := replace(def, E'        active = case when pl ? ''active'' then (pl->>''active'')::boolean else active end\n       where id = v_prod.id;',
                        E'        active = case when pl ? ''active'' then (pl->>''active'')::boolean else active end,\n        track_batches = case when pl ? ''track_batches'' then (pl->>''track_batches'')::boolean else track_batches end\n       where id = v_prod.id;');
    if position('track_batches = case' in def) = 0 then raise exception 'could not extend product_edit'; end if;
    execute def;
  end if;
  def := pg_get_functiondef('public.sync_pull(timestamp with time zone, integer)'::regprocedure);
  if position('stock_batches' in def) = 0 then
    def := replace(def, '''supplier_prices'']', '''supplier_prices'',''stock_batches'']');
    if position('stock_batches' in def) = 0 then raise exception 'could not extend sync_pull'; end if;
    execute def;
  end if;
end $$;

revoke all on function public.check_stock_batch() from public, anon;
revoke all on function public.sync_push(uuid, jsonb) from public, anon;
grant execute on function public.sync_push(uuid, jsonb) to authenticated;
revoke all on function public.sync_pull(timestamptz, int) from public, anon;
grant execute on function public.sync_pull(timestamptz, int) to authenticated;
