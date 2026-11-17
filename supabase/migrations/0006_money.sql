-- StockCM 0006: debt repayments, expenses and cash sessions in the sync path.
--   * cash_session_closures: an immutable record of each closing count (the difference is permanent).
--   * check_payment_consistency: a repayment's allocations, money entry and customer entry must agree.
--   * sync_push / sync_pull extended to the new tables.
-- Policy: a repayment is NEVER refused because it exceeds what the customer owes. The money was
-- really received (two phones may both take the same repayment offline), so it is recorded and the
-- customer's balance goes negative = credit in the customer's favour.

create table public.cash_session_closures (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  session_id uuid not null unique references public.cash_sessions(id),   -- one closing per session
  closed_by uuid references auth.users(id),
  expected_closing bigint not null,
  counted_closing bigint not null check (counted_closing >= 0),
  difference bigint not null,
  closed_at timestamptz not null,
  check (difference = counted_closing - expected_closing)
);

do $$
declare t text;
begin
  foreach t in array array['payments','payment_allocations','expenses','cash_sessions','cash_session_closures']
  loop
    execute format('alter table public.%I add column if not exists changed_at timestamptz not null default clock_timestamp()', t);
    execute format('create index on public.%I (tenant_id, changed_at)', t);
    execute format('create trigger stamp_changed_at before insert or update on public.%I
                    for each row execute function public.stamp_changed_at()', t);
    -- money records are never edited or deleted; corrections are new, linked records
    execute format('create trigger %I before update or delete on public.%I
                    for each row execute function public.prevent_mutation()', t || '_immutable', t);
  end loop;
end $$;

alter table public.cash_session_closures enable row level security;
create policy tenant_isolation_select on public.cash_session_closures for select
  using (tenant_id in (select public.my_tenants()));

create policy payments_insert on public.payments for insert
  with check (public.has_permission(tenant_id, 'payments.receive'));
create policy payment_allocations_insert on public.payment_allocations for insert
  with check (public.has_permission(tenant_id, 'payments.receive'));
create policy cash_sessions_insert on public.cash_sessions for insert
  with check (public.has_permission(tenant_id, 'sales.create'));
create policy cash_session_closures_insert on public.cash_session_closures for insert
  with check (public.has_permission(tenant_id, 'sales.create'));

-- ------------------------------------------------------------ repayment consistency
create or replace function public.check_payment_consistency() returns trigger
language plpgsql security definer set search_path = public as $$
declare alloc_sum bigint; txn record; entry_sum bigint;
begin
  select coalesce(sum(amount),0) into alloc_sum from public.payment_allocations where payment_id = new.id;
  if alloc_sum <> new.amount then
    raise exception 'payment %: allocations (%) do not add up to the amount (%)', new.id, alloc_sum, new.amount using errcode = '23514';
  end if;
  select * into txn from public.financial_transactions where id = new.transaction_id;
  if txn.id is null or txn.amount <> new.amount or txn.txn_type <> 'debt_repayment' then
    raise exception 'payment %: the money entry does not match the payment', new.id using errcode = '23514';
  end if;
  select coalesce(sum(amount),0) into entry_sum
    from public.customer_account_entries where transaction_id = new.transaction_id and kind = 'repayment';
  if entry_sum <> -new.amount then
    raise exception 'payment %: the customer balance entry (%) does not match', new.id, entry_sum using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger payments_consistency after insert on public.payments
  deferrable initially deferred for each row execute function public.check_payment_consistency();

-- ------------------------------------------------------------ push (extended)
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
                                                 staff_id, device_id, customer_id, sale_id, description, occurred_at)
      select id, tenant_id, shop_id, reference, txn_type, amount, method, verification,
             auth.uid(), p_device, customer_id, sale_id, description, occurred_at
        from jsonb_populate_record(null::public.financial_transactions, pl);
    elsif t = 'customer_account_entries' then
      insert into public.customer_account_entries (id, tenant_id, customer_id, amount, kind, sale_id, transaction_id, occurred_at)
      select id, tenant_id, customer_id, amount, kind, sale_id, transaction_id, occurred_at
        from jsonb_populate_record(null::public.customer_account_entries, pl);
    elsif t = 'payments' then
      insert into public.payments (id, tenant_id, customer_id, transaction_id, method, amount, created_at)
      select id, tenant_id, customer_id, transaction_id, method, amount, coalesce(created_at, now())
        from jsonb_populate_record(null::public.payments, pl);
    elsif t = 'payment_allocations' then
      insert into public.payment_allocations (id, tenant_id, payment_id, sale_id, amount)
      select id, tenant_id, payment_id, sale_id, amount from jsonb_populate_record(null::public.payment_allocations, pl);
    elsif t = 'expenses' then
      insert into public.expenses (id, tenant_id, shop_id, category, amount, method, description, staff_id, occurred_at)
      select id, tenant_id, shop_id, category, amount, method, description, auth.uid(), occurred_at
        from jsonb_populate_record(null::public.expenses, pl);
    elsif t = 'cash_sessions' then
      insert into public.cash_sessions (id, tenant_id, shop_id, opened_by, opening_cash, opened_at)
      select id, tenant_id, shop_id, auth.uid(), opening_cash, opened_at from jsonb_populate_record(null::public.cash_sessions, pl);
    elsif t = 'cash_session_closures' then
      insert into public.cash_session_closures (id, tenant_id, session_id, closed_by, expected_closing, counted_closing, difference, closed_at)
      select id, tenant_id, session_id, auth.uid(), expected_closing, counted_closing, difference, closed_at
        from jsonb_populate_record(null::public.cash_session_closures, pl);
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

-- ------------------------------------------------------------ pull (extended)
create or replace function public.sync_pull(p_since timestamptz, p_limit int default 500) returns jsonb
language plpgsql set search_path = public as $$
declare
  t text; chunk jsonb; cnt int; mx timestamptz;
  res jsonb := '{}'::jsonb; overall timestamptz := p_since; truncated timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  foreach t in array array['products','product_units','customers','stock_movements','sales','sale_lines',
                           'financial_transactions','customer_account_entries','payments','payment_allocations',
                           'expenses','cash_sessions','cash_session_closures']
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
