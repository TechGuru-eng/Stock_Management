-- StockCM 0008: purchases, goods receipts, supplier accounts in the sync path.
--   ORDER   (purchases, purchase_lines)  : changes nothing
--   RECEIPT (goods_receipts + lines)     : the ONLY thing that raises stock and creates supplier debt
--   PAYMENT (financial_transactions + supplier_account_entries kind 'payment') : lowers the debt

-- The app already treats managers as able to receive stock and take repayments; make the database agree.
insert into public.role_permissions (tenant_id, role, permission) values
  (null,'manager','stock.receive'), (null,'manager','stock.count'),
  (null,'manager','payments.receive'), (null,'manager','products.read')
on conflict (role, permission) where tenant_id is null do nothing;

alter table public.stock_movements drop constraint stock_movement_sign;
alter table public.stock_movements add constraint stock_movement_sign check (
  (movement_type in ('sale','damaged','expired','missing','giveaway','personal_use','transfer_out','supplier_return') and quantity < 0)
  or (movement_type in ('opening','purchase_receipt','return_in','transfer_in') and quantity > 0)
  or movement_type in ('count_adjustment','reversal'));

create table public.goods_receipt_lines (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  receipt_id uuid not null references public.goods_receipts(id),
  purchase_line_id uuid not null references public.purchase_lines(id),
  product_id uuid not null references public.products(id),
  base_quantity bigint not null check (base_quantity > 0),
  total_cost bigint not null check (total_cost >= 0)
);
create index on public.goods_receipt_lines (receipt_id);
alter table public.goods_receipt_lines enable row level security;
create policy tenant_isolation_select on public.goods_receipt_lines for select
  using (tenant_id in (select public.my_tenants()));

alter table public.supplier_account_entries add column receipt_id uuid references public.goods_receipts(id);

do $$
declare t text;
begin
  foreach t in array array['suppliers','purchases','purchase_lines','goods_receipts','goods_receipt_lines','supplier_account_entries']
  loop
    execute format('alter table public.%I add column if not exists changed_at timestamptz not null default clock_timestamp()', t);
    execute format('create index on public.%I (tenant_id, changed_at)', t);
    execute format('create trigger stamp_changed_at before insert or update on public.%I
                    for each row execute function public.stamp_changed_at()', t);
    if t <> 'suppliers' then
      execute format('create trigger %I before update or delete on public.%I
                      for each row execute function public.prevent_mutation()', t || '_immutable', t);
    end if;
  end loop;
end $$;

create policy purchases_insert on public.purchases for insert
  with check (public.has_permission(tenant_id, 'purchases.manage'));
create policy purchase_lines_insert on public.purchase_lines for insert
  with check (public.has_permission(tenant_id, 'purchases.manage'));
create policy goods_receipts_insert on public.goods_receipts for insert
  with check (public.has_permission(tenant_id, 'stock.receive'));
create policy goods_receipt_lines_insert on public.goods_receipt_lines for insert
  with check (public.has_permission(tenant_id, 'stock.receive'));
create policy supplier_entries_insert on public.supplier_account_entries for insert
  with check (public.has_permission(tenant_id, 'purchases.manage')
              or (kind = 'purchase_credit' and public.has_permission(tenant_id, 'stock.receive')));

-- paying a supplier is a purchases.manage action (it was owner-only before)
drop policy fin_txn_insert on public.financial_transactions;
create policy fin_txn_insert on public.financial_transactions for insert
  with check (
    verification in ('recorded','pending')
    and provider_reference is null
    and case txn_type
      when 'sale_collection' then public.has_permission(tenant_id, 'sales.create')
      when 'debt_repayment'  then public.has_permission(tenant_id, 'payments.receive')
      when 'expense'         then public.has_permission(tenant_id, 'expenses.write')
      when 'supplier_payment' then public.has_permission(tenant_id, 'purchases.manage')
      else public.has_permission(tenant_id, 'finance.write')
    end);

-- ------------------------------------------------------------ receipt consistency
create or replace function public.check_receipt_consistency() returns trigger
language plpgsql security definer set search_path = public as $$
declare lines_qty bigint; lines_cost bigint; lines_count int; debt bigint; moved_qty bigint; moved_cost bigint; over record;
begin
  select coalesce(sum(base_quantity),0), coalesce(sum(total_cost),0), count(*) into lines_qty, lines_cost, lines_count
    from public.goods_receipt_lines where receipt_id = new.id;
  if lines_count = 0 then
    raise exception 'receipt % has no lines', new.id using errcode = '23514';
  end if;
  select coalesce(sum(amount),0) into debt from public.supplier_account_entries
    where receipt_id = new.id and kind = 'purchase_credit';
  if debt <> lines_cost then
    raise exception 'receipt %: supplier debt (%) does not match the value received (%)', new.id, debt, lines_cost using errcode = '23514';
  end if;
  select coalesce(sum(quantity),0), coalesce(sum(total_cost),0) into moved_qty, moved_cost from public.stock_movements
    where reference_id = new.id and movement_type = 'purchase_receipt';
  if moved_qty <> lines_qty or moved_cost <> lines_cost then
    raise exception 'receipt %: stock movements (% units, % XAF) do not match the goods received (% units, % XAF)',
      new.id, moved_qty, moved_cost, lines_qty, lines_cost using errcode = '23514';
  end if;
  -- never more received than was ordered, across all deliveries
  for over in
    select pl.id, pl.base_quantity ordered, sum(rl.base_quantity) got
      from public.goods_receipt_lines rl join public.purchase_lines pl on pl.id = rl.purchase_line_id
     where rl.purchase_line_id in (select purchase_line_id from public.goods_receipt_lines where receipt_id = new.id)
     group by pl.id, pl.base_quantity having sum(rl.base_quantity) > pl.base_quantity
  loop
    raise exception 'receipt %: more received than ordered (% of %)', new.id, over.got, over.ordered using errcode = '23514';
  end loop;
  return null;
end $$;

create constraint trigger receipts_consistency after insert on public.goods_receipts
  deferrable initially deferred for each row execute function public.check_receipt_consistency();

-- a supplier payment must match its money entry
create or replace function public.check_supplier_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare txn record;
begin
  if new.kind = 'payment' then
    select * into txn from public.financial_transactions where id = new.transaction_id;
    if txn.id is null or txn.txn_type <> 'supplier_payment' or txn.amount <> new.amount then
      raise exception 'supplier payment entry does not match its money entry' using errcode = '23514';
    end if;
  end if;
  return null;
end $$;
create constraint trigger supplier_payment_consistency after insert on public.supplier_account_entries
  deferrable initially deferred for each row execute function public.check_supplier_payment();

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
    elsif t = 'suppliers' then
      insert into public.suppliers (id, tenant_id, name, phone, notes, created_at)
      select id, tenant_id, name, phone, notes, created_at from jsonb_populate_record(null::public.suppliers, pl);
    elsif t = 'purchases' then
      insert into public.purchases (id, tenant_id, shop_id, supplier_id, invoice_number, ordered_at)
      select id, tenant_id, shop_id, supplier_id, invoice_number, ordered_at from jsonb_populate_record(null::public.purchases, pl);
    elsif t = 'purchase_lines' then
      insert into public.purchase_lines (id, tenant_id, purchase_id, product_id, base_quantity, total_cost)
      select id, tenant_id, purchase_id, product_id, base_quantity, total_cost from jsonb_populate_record(null::public.purchase_lines, pl);
    elsif t = 'goods_receipts' then
      insert into public.goods_receipts (id, tenant_id, purchase_id, received_by, received_at)
      select id, tenant_id, purchase_id, auth.uid(), coalesce(received_at, now()) from jsonb_populate_record(null::public.goods_receipts, pl);
    elsif t = 'goods_receipt_lines' then
      insert into public.goods_receipt_lines (id, tenant_id, receipt_id, purchase_line_id, product_id, base_quantity, total_cost)
      select id, tenant_id, receipt_id, purchase_line_id, product_id, base_quantity, total_cost from jsonb_populate_record(null::public.goods_receipt_lines, pl);
    elsif t = 'supplier_account_entries' then
      insert into public.supplier_account_entries (id, tenant_id, supplier_id, amount, kind, purchase_id, receipt_id, transaction_id, occurred_at)
      select id, tenant_id, supplier_id, amount, kind, purchase_id, receipt_id, transaction_id, occurred_at
        from jsonb_populate_record(null::public.supplier_account_entries, pl);
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
                           'expenses','cash_sessions','cash_session_closures','suppliers','purchases','purchase_lines',
                           'goods_receipts','goods_receipt_lines','supplier_account_entries']
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
