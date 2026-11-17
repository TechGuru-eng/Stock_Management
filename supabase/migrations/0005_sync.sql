-- StockCM 0005: synchronisation.
--   * sync_push : applies ONE business event (e.g. a sale and all its records)
--                 atomically. Repeats are skipped. Totals are re-checked on the server.
--   * sync_pull : change feed so other devices (and replacement devices) can download.
--   * register_device : links a device to a business; revoked devices cannot sync.

-- quantities may be fractional (kg, litre, metre)
alter table public.sale_lines alter column quantity type numeric(18,3);
alter table public.stock_movements add column total_cost bigint;

-- A movement's sign must match its type. The server never trusts the client here.
alter table public.stock_movements add constraint stock_movement_sign check (
  (movement_type in ('sale','damaged','expired','missing','giveaway','personal_use','transfer_out') and quantity < 0)
  or (movement_type in ('opening','purchase_receipt','return_in','transfer_in') and quantity > 0)
  or movement_type in ('count_adjustment','reversal'));

-- ------------------------------------------------------------ change feed
create or replace function public.stamp_changed_at() returns trigger
language plpgsql set search_path = public as $$
begin new.changed_at := clock_timestamp(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['products','product_units','customers','stock_movements','sales',
      'sale_lines','financial_transactions','customer_account_entries']
  loop
    execute format('alter table public.%I add column changed_at timestamptz not null default clock_timestamp()', t);
    execute format('create index on public.%I (tenant_id, changed_at)', t);
    execute format('create trigger stamp_changed_at before insert or update on public.%I
                    for each row execute function public.stamp_changed_at()', t);
  end loop;
end $$;

-- ------------------------------------------------------------ server-side sale validation
-- Checked when the transaction COMMITS, after the sale and all its child rows exist.
create or replace function public.check_sale_consistency() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  lines_total bigint; lines_count int; collected_sum bigint; owed_sum bigint; stock_out bigint; stock_expected bigint;
begin
  select coalesce(sum(line_total),0), count(*) into lines_total, lines_count
    from public.sale_lines where sale_id = new.id;
  select coalesce(sum(amount),0) into collected_sum
    from public.financial_transactions where sale_id = new.id and txn_type = 'sale_collection';
  select coalesce(sum(amount),0) into owed_sum
    from public.customer_account_entries where sale_id = new.id and kind = 'sale_credit';
  select coalesce(-sum(quantity),0) into stock_out
    from public.stock_movements where reference_id = new.id and movement_type = 'sale';
  select coalesce(sum(l.base_quantity),0) into stock_expected
    from public.sale_lines l join public.products p on p.id = l.product_id
    where l.sale_id = new.id and not p.is_service;

  if lines_count = 0 then
    raise exception 'sale % has no lines', new.sale_number using errcode = '23514';
  end if;
  if lines_total <> new.total then
    raise exception 'sale %: lines add up to % but the total is %', new.sale_number, lines_total, new.total using errcode = '23514';
  end if;
  if collected_sum <> new.collected then
    raise exception 'sale %: recorded payments (%) do not match collected (%)', new.sale_number, collected_sum, new.collected using errcode = '23514';
  end if;
  if owed_sum <> new.outstanding then
    raise exception 'sale %: customer debt (%) does not match outstanding (%)', new.sale_number, owed_sum, new.outstanding using errcode = '23514';
  end if;
  if new.outstanding > 0 and new.customer_id is null then
    raise exception 'sale %: credit needs a customer', new.sale_number using errcode = '23514';
  end if;
  if stock_out <> stock_expected then
    raise exception 'sale %: stock movements (%) do not match sold quantities (%)', new.sale_number, stock_out, stock_expected using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger sales_consistency after insert on public.sales
  deferrable initially deferred for each row execute function public.check_sale_consistency();

-- ------------------------------------------------------------ devices
create policy sync_operations_insert on public.sync_operations for insert
  with check (tenant_id in (select public.my_tenants()));

create or replace function public.register_device(p_device uuid, p_tenant uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or p_tenant not in (select public.my_tenants()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.devices (id, tenant_id, user_id, name, last_sync_at)
  values (p_device, p_tenant, auth.uid(), coalesce(nullif(p_name,''),'device'), now())
  on conflict (id) do update set last_sync_at = now()
    where devices.tenant_id = p_tenant and devices.revoked_at is null;
  if exists (select 1 from public.devices where id = p_device and (tenant_id <> p_tenant or revoked_at is not null)) then
    raise exception 'this device is not allowed to sync' using errcode = '42501';
  end if;
end $$;
revoke all on function public.register_device(uuid, uuid, text) from public, anon;
grant execute on function public.register_device(uuid, uuid, text) to authenticated;

-- ------------------------------------------------------------ push
-- SECURITY INVOKER: every insert still passes row-level security and permission checks.
create or replace function public.sync_push(p_device uuid, p_ops jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  op jsonb; pl jsonb; t text; n int; applied int := 0; skipped int := 0;
  v_factor bigint; v_qty numeric;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if exists (select 1 from public.devices where id = p_device and revoked_at is not null) then
    raise exception 'this device has been revoked' using errcode = '42501';
  end if;

  for op in select * from jsonb_array_elements(p_ops) loop
    t := op->>'table';
    pl := op->'payload';

    -- Idempotency: the same operation id is never applied twice.
    insert into public.sync_operations (op_id, tenant_id, device_id, op_type, status)
    values ((op->>'op_id')::uuid, (pl->>'tenant_id')::uuid, p_device, t, 'applied')
    on conflict (op_id) do nothing;
    get diagnostics n = row_count;
    if n = 0 then skipped := skipped + 1; continue; end if;

    if t = 'products' then
      insert into public.products (id, tenant_id, name, barcode, sku, base_unit, min_stock, tax_rate_bp, is_service, active, created_at)
      select id, tenant_id, name, barcode, sku, base_unit, min_stock, tax_rate_bp, is_service, active, created_at
        from jsonb_populate_record(null::public.products, pl);
    elsif t = 'product_units' then
      insert into public.product_units (id, tenant_id, product_id, name, factor, sell_price, is_base)
      select id, tenant_id, product_id, name, factor, sell_price, is_base from jsonb_populate_record(null::public.product_units, pl);
    elsif t = 'customers' then
      insert into public.customers (id, tenant_id, name, phone, credit_limit, created_at)
      select id, tenant_id, name, phone, credit_limit, created_at from jsonb_populate_record(null::public.customers, pl);
    elsif t = 'stock_movements' then
      insert into public.stock_movements (id, tenant_id, shop_id, product_id, quantity, movement_type, reason, staff_id, device_id,
                                          reference_type, reference_id, unit_cost, total_cost, occurred_at)
      select id, tenant_id, shop_id, product_id, quantity, movement_type, reason, auth.uid(), p_device,
             reference_type, reference_id, unit_cost, total_cost, occurred_at
        from jsonb_populate_record(null::public.stock_movements, pl);
    elsif t = 'sales' then
      insert into public.sales (id, tenant_id, shop_id, sale_number, customer_id, cashier_id, device_id, subtotal, discount, tax,
                                total, collected, outstanding, status, occurred_at)
      select id, tenant_id, shop_id, sale_number, customer_id, auth.uid(), p_device, subtotal, discount, tax,
             total, collected, outstanding, status, occurred_at
        from jsonb_populate_record(null::public.sales, pl);
    elsif t = 'sale_lines' then
      select factor into v_factor from public.product_units
       where id = (pl->>'unit_id')::uuid and product_id = (pl->>'product_id')::uuid;
      if v_factor is null then
        raise exception 'unknown unit for product %', pl->>'product_id' using errcode = '23503';
      end if;
      v_qty := (pl->>'quantity')::numeric;
      if round(v_qty * v_factor) <> (pl->>'base_quantity')::bigint then
        raise exception 'unit conversion mismatch: % x % is not % base units', v_qty, v_factor, pl->>'base_quantity' using errcode = '23514';
      end if;
      insert into public.sale_lines (id, tenant_id, sale_id, product_id, unit_id, quantity, base_quantity, unit_price, line_discount, line_total, cost_of_goods)
      select id, tenant_id, sale_id, product_id, unit_id, quantity, base_quantity, unit_price, line_discount, line_total, cost_of_goods
        from jsonb_populate_record(null::public.sale_lines, pl);
    elsif t = 'financial_transactions' then
      insert into public.financial_transactions (id, tenant_id, shop_id, reference, txn_type, amount, method, verification,
                                                 staff_id, device_id, customer_id, sale_id, occurred_at)
      select id, tenant_id, shop_id, reference, txn_type, amount, method, verification,
             auth.uid(), p_device, customer_id, sale_id, occurred_at
        from jsonb_populate_record(null::public.financial_transactions, pl);
    elsif t = 'customer_account_entries' then
      insert into public.customer_account_entries (id, tenant_id, customer_id, amount, kind, sale_id, occurred_at)
      select id, tenant_id, customer_id, amount, kind, sale_id, occurred_at
        from jsonb_populate_record(null::public.customer_account_entries, pl);
    else
      raise exception 'unknown table %', t using errcode = '22023';
    end if;
    applied := applied + 1;
  end loop;

  update public.devices set last_sync_at = now() where id = p_device;
  return jsonb_build_object('applied', applied, 'skipped', skipped);
end $$;
revoke all on function public.sync_push(uuid, jsonb) from public, anon;
grant execute on function public.sync_push(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------ pull
create or replace function public.sync_pull(p_since timestamptz, p_limit int default 500) returns jsonb
language plpgsql set search_path = public as $$
declare
  t text; chunk jsonb; cnt int; mx timestamptz;
  res jsonb := '{}'::jsonb; overall timestamptz := p_since; truncated timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  foreach t in array array['products','product_units','customers','stock_movements','sales',
                           'sale_lines','financial_transactions','customer_account_entries']
  loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(x) order by x.changed_at), ''[]''::jsonb), count(*), max(x.changed_at)
         from (select * from public.%I where changed_at > $1 order by changed_at limit $2) x', t)
      into chunk, cnt, mx using p_since, p_limit;
    res := res || jsonb_build_object(t, chunk);
    if cnt > 0 then overall := greatest(overall, mx); end if;
    if cnt >= p_limit then truncated := least(coalesce(truncated, mx), mx); end if;
  end loop;
  return jsonb_build_object(
    'rows', res,
    'cursor', coalesce(truncated, overall),
    'has_more', truncated is not null,
    'server_time', clock_timestamp(),
    'subscription', (select to_jsonb(s) from public.subscriptions s limit 1));
end $$;
revoke all on function public.sync_pull(timestamptz, int) from public, anon;
grant execute on function public.sync_pull(timestamptz, int) to authenticated;
