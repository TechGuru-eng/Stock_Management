-- StockCM 0019: stock counts (stock-takes).
--   stock_counts          a count of one shop (name, blind or not, who started it)
--   stock_count_lines     what was counted for a product, with what the system EXPECTED and the average cost at that moment.
--                         Recounting adds a newer line; the newest wins. Append-only.
--   stock_count_decisions one approval or rejection per count (a manager or the owner)
-- Approving posts count_adjustment stock movements for the DIFFERENCES only, in the same upload; the database checks at commit
-- that they match the count exactly. count_adjustment can no longer be posted any other way, and needs the right to approve.

create table public.stock_counts (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  shop_id uuid not null references public.shops(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 80),
  blind boolean not null default true,
  started_by uuid references auth.users(id),
  started_at timestamptz not null
);

create table public.stock_count_lines (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  count_id uuid not null references public.stock_counts(id),
  product_id uuid not null references public.products(id),
  counted bigint not null check (counted >= 0),
  expected bigint not null,
  unit_cost bigint not null check (unit_cost >= 0),
  counted_by uuid references auth.users(id),
  counted_at timestamptz not null
);
create index on public.stock_count_lines (count_id, product_id, counted_at desc);

create table public.stock_count_decisions (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  count_id uuid not null unique references public.stock_counts(id),   -- one decision per count
  decision text not null check (decision in ('approved','rejected')),
  note text,
  decided_by uuid references auth.users(id),
  decided_at timestamptz not null,
  check (decision = 'approved' or length(trim(coalesce(note,''))) > 0)
);

do $$
declare t text;
begin
  foreach t in array array['stock_counts','stock_count_lines','stock_count_decisions']
  loop
    execute format('alter table public.%I add column if not exists changed_at timestamptz not null default clock_timestamp()', t);
    execute format('create index on public.%I (tenant_id, changed_at)', t);
    execute format('create trigger stamp_changed_at before insert or update on public.%I
                    for each row execute function public.stamp_changed_at()', t);
    execute format('create trigger %I before update or delete on public.%I
                    for each row execute function public.prevent_mutation()', t || '_immutable', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy tenant_isolation_select on public.%I for select using (tenant_id in (select public.my_tenants()))', t);
  end loop;
end $$;

create policy stock_counts_insert on public.stock_counts for insert with check (public.has_permission(tenant_id, 'stock.count'));
create policy stock_count_lines_insert on public.stock_count_lines for insert with check (public.has_permission(tenant_id, 'stock.count'));
create policy stock_count_decisions_insert on public.stock_count_decisions for insert with check (public.has_permission(tenant_id, 'stock.adjust_approve'));

-- count_adjustment now needs the right to approve (before: any counter), and must belong to an approved count (checked below)
drop policy stock_movements_insert on public.stock_movements;
create policy stock_movements_insert on public.stock_movements for insert
  with check (
    tenant_id in (select public.my_tenants())
    and case movement_type
      when 'sale'             then public.has_permission(tenant_id, 'sales.create')
      when 'return_in'        then public.has_permission(tenant_id, 'sales.create')
      when 'purchase_receipt' then public.has_permission(tenant_id, 'stock.receive')
      when 'opening'          then public.has_permission(tenant_id, 'stock.receive')
      when 'count_adjustment' then public.has_permission(tenant_id, 'stock.adjust_approve')
      else public.has_permission(tenant_id, 'stock.adjust_approve')
    end);

-- no lines after a decision, and only for a product of the same business
create or replace function public.check_count_line() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.stock_count_decisions where count_id = new.count_id) then
    raise exception 'this count has already been decided' using errcode = '23514';
  end if;
  if not exists (select 1 from public.stock_counts c where c.id = new.count_id and c.tenant_id = new.tenant_id)
     or not exists (select 1 from public.products p where p.id = new.product_id and p.tenant_id = new.tenant_id) then
    raise exception 'count line does not belong to this business' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger count_line_guard before insert on public.stock_count_lines for each row execute function public.check_count_line();

-- At commit: an approved count has exactly the adjustments its newest lines call for (the difference, per product, nothing else);
-- a rejected count has none.
create or replace function public.check_count_decision() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record; bad record;
begin
  select * into c from public.stock_counts where id = new.count_id;
  if new.decision = 'rejected' then
    if exists (select 1 from public.stock_movements where reference_id = new.count_id and movement_type = 'count_adjustment') then
      raise exception 'a rejected count cannot adjust stock' using errcode = '23514';
    end if;
    return null;
  end if;
  for bad in
    with latest as (
      select distinct on (product_id) product_id, counted - expected as diff
        from public.stock_count_lines where count_id = new.count_id order by product_id, counted_at desc, id desc
    ), moved as (
      select product_id, sum(quantity) q, count(*) n, bool_and(shop_id = c.shop_id) same_shop
        from public.stock_movements where reference_id = new.count_id and movement_type = 'count_adjustment' group by product_id
    )
    select coalesce(l.product_id, m.product_id) product_id, l.diff, m.q, m.n, m.same_shop
      from latest l full join moved m on m.product_id = l.product_id
     where (coalesce(l.diff, 0) <> 0 and (m.q is distinct from l.diff or m.n <> 1))
        or (coalesce(l.diff, 0) = 0 and m.q is not null)
        or (m.q is not null and not m.same_shop)
  loop
    raise exception 'count %: adjustment for product % does not match the count (difference %, posted %)', new.count_id, bad.product_id, bad.diff, bad.q using errcode = '23514';
  end loop;
  return null;
end $$;
create constraint trigger count_decision_consistency after insert on public.stock_count_decisions
  deferrable initially deferred for each row execute function public.check_count_decision();

-- every count_adjustment must belong to an approved count of the same shop (so it cannot be posted on its own)
create or replace function public.check_count_adjustment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.stock_counts c join public.stock_count_decisions d on d.count_id = c.id and d.decision = 'approved'
     where c.id = new.reference_id and c.shop_id = new.shop_id and c.tenant_id = new.tenant_id
  ) then
    raise exception 'a stock adjustment must come from an approved count' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger count_adjustment_consistency after insert on public.stock_movements
  deferrable initially deferred for each row when (new.movement_type = 'count_adjustment') execute function public.check_count_adjustment();

-- extend the upload and download functions with the three new tables (patching the current definitions)
do $$
declare def text;
begin
  def := pg_get_functiondef('public.sync_push(uuid, jsonb)'::regprocedure);
  if position('stock_count_decisions' in def) = 0 then
    def := replace(def, E'    else\n      raise exception ''unknown table %'', t using errcode = ''22023'';',
$p$    elsif t = 'stock_counts' then
      insert into public.stock_counts (id, tenant_id, shop_id, name, blind, started_by, started_at)
      select id, tenant_id, shop_id, name, blind, auth.uid(), started_at from jsonb_populate_record(null::public.stock_counts, pl);
    elsif t = 'stock_count_lines' then
      insert into public.stock_count_lines (id, tenant_id, count_id, product_id, counted, expected, unit_cost, counted_by, counted_at)
      select id, tenant_id, count_id, product_id, counted, expected, unit_cost, auth.uid(), counted_at from jsonb_populate_record(null::public.stock_count_lines, pl);
    elsif t = 'stock_count_decisions' then
      insert into public.stock_count_decisions (id, tenant_id, count_id, decision, note, decided_by, decided_at)
      select id, tenant_id, count_id, decision, note, auth.uid(), decided_at from jsonb_populate_record(null::public.stock_count_decisions, pl);
    else
      raise exception 'unknown table %', t using errcode = '22023';$p$);
    if position('stock_count_decisions' in def) = 0 then raise exception 'could not extend sync_push'; end if;
    execute def;
  end if;

  def := pg_get_functiondef('public.sync_pull(timestamp with time zone, integer)'::regprocedure);
  if position('stock_count_decisions' in def) = 0 then
    def := replace(def, '''approval_requests'',''approval_decisions'']', '''approval_requests'',''approval_decisions'',''stock_counts'',''stock_count_lines'',''stock_count_decisions'']');
    if position('stock_count_decisions' in def) = 0 then raise exception 'could not extend sync_pull'; end if;
    execute def;
  end if;
end $$;

revoke all on function public.check_count_line(), public.check_count_decision(), public.check_count_adjustment() from public, anon;
revoke all on function public.sync_push(uuid, jsonb) from public, anon;
grant execute on function public.sync_push(uuid, jsonb) to authenticated;
revoke all on function public.sync_pull(timestamptz, int) from public, anon;
grant execute on function public.sync_pull(timestamptz, int) to authenticated;
