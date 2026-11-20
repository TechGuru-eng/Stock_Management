-- StockCM 0009: customer returns, cancellations, refunds and approvals.
-- A return never edits the sale. It is a new record that points back at it, with its own stock
-- movements, money entry (refund) and customer-account entry (debt written off).
-- The server refuses anything that does not add up, or that would return or refund more than was
-- sold or paid (this is what stops two devices paying the same refund twice).

create table public.sale_returns (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  shop_id uuid not null references public.shops(id),
  sale_id uuid not null references public.sales(id),
  kind text not null check (kind in ('return','cancellation')),
  reason text not null check (length(trim(reason)) > 0),
  total_value bigint not null check (total_value > 0),
  net_value bigint not null check (net_value >= 0),
  refunded_amount bigint not null default 0 check (refunded_amount >= 0),
  debt_reduced bigint not null default 0 check (debt_reduced >= 0),
  refund_method public.payment_method check (refund_method is null or refund_method <> 'credit'),
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  occurred_at timestamptz not null,
  check (refunded_amount + debt_reduced = total_value),
  check (refunded_amount = 0 or refund_method is not null)
);
create index on public.sale_returns (sale_id);

create table public.sale_return_lines (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  return_id uuid not null references public.sale_returns(id),
  sale_line_id uuid not null references public.sale_lines(id),
  product_id uuid not null references public.products(id),
  quantity numeric(18,3) not null check (quantity > 0),
  base_quantity bigint not null check (base_quantity >= 0),
  value bigint not null check (value >= 0),
  net_value bigint not null check (net_value >= 0),
  restock boolean not null,
  cost_reversed bigint not null default 0 check (cost_reversed >= 0)
);
create index on public.sale_return_lines (return_id);
create index on public.sale_return_lines (sale_line_id);

alter table public.financial_transactions add column return_id uuid references public.sale_returns(id);
alter table public.customer_account_entries add column return_id uuid references public.sale_returns(id);

-- A request is filed by a cashier; a decision is a separate record (so nothing is ever updated).
create table public.approval_decisions (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  request_id uuid not null unique references public.approval_requests(id),   -- one decision per request
  decided_by uuid references auth.users(id),
  decision text not null check (decision in ('approved','rejected')),
  note text,
  return_id uuid references public.sale_returns(id),
  decided_at timestamptz not null,
  check (decision = 'approved' or length(trim(coalesce(note,''))) > 0)
);

do $$
declare t text;
begin
  foreach t in array array['sale_returns','sale_return_lines','approval_decisions','approval_requests']
  loop
    execute format('alter table public.%I add column if not exists changed_at timestamptz not null default clock_timestamp()', t);
    execute format('create index on public.%I (tenant_id, changed_at)', t);
    execute format('create trigger stamp_changed_at before insert or update on public.%I
                    for each row execute function public.stamp_changed_at()', t);
    execute format('create trigger %I before update or delete on public.%I
                    for each row execute function public.prevent_mutation()', t || '_immutable', t);
  end loop;
end $$;

alter table public.sale_returns enable row level security;
alter table public.sale_return_lines enable row level security;
alter table public.approval_decisions enable row level security;
create policy tenant_isolation_select on public.sale_returns for select using (tenant_id in (select public.my_tenants()));
create policy tenant_isolation_select on public.sale_return_lines for select using (tenant_id in (select public.my_tenants()));
create policy tenant_isolation_select on public.approval_decisions for select using (tenant_id in (select public.my_tenants()));

create policy sale_returns_insert on public.sale_returns for insert
  with check (public.has_permission(tenant_id, 'sales.refund_approve'));
create policy sale_return_lines_insert on public.sale_return_lines for insert
  with check (public.has_permission(tenant_id, 'sales.refund_approve'));
create policy approval_decisions_insert on public.approval_decisions for insert
  with check (public.has_permission(tenant_id, 'sales.refund_approve'));

-- requests are immutable now: a decision is its own record
drop policy approvals_decide on public.approval_requests;
drop policy approvals_insert on public.approval_requests;
create policy approvals_insert on public.approval_requests for insert
  with check (public.has_permission(tenant_id, 'sales.request_refund') or public.has_permission(tenant_id, 'sales.refund_approve'));

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
      when 'refund'          then public.has_permission(tenant_id, 'sales.refund_approve')
      else public.has_permission(tenant_id, 'finance.write')
    end);

-- ------------------------------------------------------------ return consistency
create or replace function public.check_return_consistency() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  lines_count int; lines_value bigint; money bigint; debt bigint; moved_qty bigint; moved_cost bigint;
  restock_qty bigint; restock_cost bigint; over record; paid bigint; refunded_all bigint; debt_all bigint; s_outstanding bigint;
begin
  select count(*), coalesce(sum(value),0), coalesce(sum(base_quantity) filter (where restock),0), coalesce(sum(cost_reversed) filter (where restock),0)
    into lines_count, lines_value, restock_qty, restock_cost from public.sale_return_lines where return_id = new.id;
  if lines_count = 0 then raise exception 'return % has no lines', new.id using errcode = '23514'; end if;
  if lines_value <> new.total_value then
    raise exception 'return %: lines add up to % but the total is %', new.id, lines_value, new.total_value using errcode = '23514';
  end if;
  select coalesce(-sum(amount),0) into money from public.financial_transactions where return_id = new.id;
  if money <> new.refunded_amount then
    raise exception 'return %: money paid back (%) does not match the refund (%)', new.id, money, new.refunded_amount using errcode = '23514';
  end if;
  select coalesce(-sum(amount),0) into debt from public.customer_account_entries where return_id = new.id;
  if debt <> new.debt_reduced then
    raise exception 'return %: customer balance entry (%) does not match the debt written off (%)', new.id, debt, new.debt_reduced using errcode = '23514';
  end if;
  select coalesce(sum(quantity),0), coalesce(sum(total_cost),0) into moved_qty, moved_cost
    from public.stock_movements where reference_id = new.id and movement_type = 'return_in';
  if moved_qty <> restock_qty or moved_cost <> restock_cost then
    raise exception 'return %: stock put back (% units) does not match the goods returned (% units)', new.id, moved_qty, restock_qty using errcode = '23514';
  end if;
  -- never return more than was sold, across all returns of the sale line
  for over in
    select sl.id, sl.quantity sold, sum(rl.quantity) back
      from public.sale_return_lines rl join public.sale_lines sl on sl.id = rl.sale_line_id
     where rl.sale_line_id in (select sale_line_id from public.sale_return_lines where return_id = new.id)
     group by sl.id, sl.quantity having sum(rl.quantity) > sl.quantity
  loop
    raise exception 'return %: more returned than was sold (% of %)', new.id, over.back, over.sold using errcode = '23514';
  end loop;
  -- never refund more than the customer paid, or write off more debt than was owed
  select coalesce(sum(amount),0) into paid from public.financial_transactions where sale_id = new.sale_id and txn_type = 'sale_collection';
  paid := paid + coalesce((select sum(amount) from public.payment_allocations where sale_id = new.sale_id), 0);
  select coalesce(sum(refunded_amount),0), coalesce(sum(debt_reduced),0) into refunded_all, debt_all
    from public.sale_returns where sale_id = new.sale_id;
  if refunded_all > paid then
    raise exception 'return %: refunds (%) exceed what the customer paid (%)', new.id, refunded_all, paid using errcode = '23514';
  end if;
  select outstanding into s_outstanding from public.sales where id = new.sale_id;
  if debt_all > s_outstanding then
    raise exception 'return %: debt written off (%) exceeds what was owed (%)', new.id, debt_all, s_outstanding using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger returns_consistency after insert on public.sale_returns
  deferrable initially deferred for each row execute function public.check_return_consistency();

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
                                                 staff_id, device_id, customer_id, sale_id, return_id, description, occurred_at)
      select id, tenant_id, shop_id, reference, txn_type, amount, method, verification,
             auth.uid(), p_device, customer_id, sale_id, return_id, description, occurred_at
        from jsonb_populate_record(null::public.financial_transactions, pl);
    elsif t = 'customer_account_entries' then
      insert into public.customer_account_entries (id, tenant_id, customer_id, amount, kind, sale_id, transaction_id, return_id, occurred_at)
      select id, tenant_id, customer_id, amount, kind, sale_id, transaction_id, return_id, occurred_at
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
    elsif t = 'sale_returns' then
      insert into public.sale_returns (id, tenant_id, shop_id, sale_id, kind, reason, total_value, net_value, refunded_amount,
                                       debt_reduced, refund_method, created_by, approved_by, occurred_at)
      select id, tenant_id, shop_id, sale_id, kind, reason, total_value, net_value, refunded_amount,
             debt_reduced, refund_method, auth.uid(), approved_by, occurred_at
        from jsonb_populate_record(null::public.sale_returns, pl);
    elsif t = 'sale_return_lines' then
      insert into public.sale_return_lines (id, tenant_id, return_id, sale_line_id, product_id, quantity, base_quantity, value, net_value, restock, cost_reversed)
      select id, tenant_id, return_id, sale_line_id, product_id, quantity, base_quantity, value, net_value, restock, cost_reversed
        from jsonb_populate_record(null::public.sale_return_lines, pl);
    elsif t = 'approval_requests' then
      insert into public.approval_requests (id, tenant_id, kind, payload, requested_by, requested_at)
      select id, tenant_id, kind, payload, auth.uid(), coalesce(requested_at, now()) from jsonb_populate_record(null::public.approval_requests, pl);
    elsif t = 'approval_decisions' then
      insert into public.approval_decisions (id, tenant_id, request_id, decided_by, decision, note, return_id, decided_at)
      select id, tenant_id, request_id, auth.uid(), decision, note, return_id, decided_at
        from jsonb_populate_record(null::public.approval_decisions, pl);
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
                           'goods_receipts','goods_receipt_lines','supplier_account_entries',
                           'sale_returns','sale_return_lines','approval_requests','approval_decisions']
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
