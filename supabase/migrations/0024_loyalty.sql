-- StockCM 0024: customer loyalty points.
--   loyalty_rules   : the business's program rules; append-only versions (the newest wins), changed only by someone with settings rights.
--   loyalty_entries : the points ledger. Append-only. earn (+), redeem (-), reversal (taking back / giving back for returns and cancellations),
--                     adjust (a manager's manual correction).
-- The balance is the sum of a customer's entries. It is deliberately NOT forced to stay above zero by the database: two devices working offline may
-- both spend the same points, and rejecting the second SALE would lose a real sale. An overdrawn balance is simply visible to the owner.

create table public.loyalty_rules (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  enabled boolean not null,
  earn_per bigint not null check (earn_per between 1 and 1000000),
  point_value bigint not null check (point_value between 1 and 100000),
  min_redeem bigint not null check (min_redeem between 1 and 1000000),
  max_share_bp int not null check (max_share_bp between 100 and 10000),
  set_by uuid references auth.users(id),
  set_at timestamptz not null
);

create table public.loyalty_entries (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  customer_id uuid not null references public.customers(id),
  points bigint not null check (points <> 0),
  kind text not null check (kind in ('earn', 'redeem', 'reversal', 'adjust')),
  sale_id uuid references public.sales(id),
  return_id uuid references public.sale_returns(id),
  note text,
  created_by uuid references auth.users(id),
  occurred_at timestamptz not null,
  check ((kind = 'earn' and points > 0) or (kind = 'redeem' and points < 0) or kind in ('reversal', 'adjust')),
  check (kind <> 'adjust' or length(trim(coalesce(note, ''))) > 0)
);
create index on public.loyalty_entries (customer_id, occurred_at);

do $$
declare t text;
begin
  foreach t in array array['loyalty_rules', 'loyalty_entries']
  loop
    execute format('alter table public.%I add column if not exists changed_at timestamptz not null default clock_timestamp()', t);
    execute format('create index on public.%I (tenant_id, changed_at)', t);
    execute format('create trigger stamp_changed_at before insert or update on public.%I for each row execute function public.stamp_changed_at()', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.prevent_mutation()', t || '_immutable', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy tenant_isolation_select on public.%I for select using (tenant_id in (select public.my_tenants()))', t);
  end loop;
end $$;

create policy loyalty_rules_insert on public.loyalty_rules for insert with check (public.has_permission(tenant_id, 'settings.write'));
create policy loyalty_entries_insert on public.loyalty_entries for insert with check (
  case kind
    when 'adjust' then public.has_permission(tenant_id, 'sales.refund_approve')
    else public.has_permission(tenant_id, 'sales.create')
  end);

create or replace function public.check_loyalty_entry() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.customers where id = new.customer_id and tenant_id = new.tenant_id)
     or (new.sale_id is not null and not exists (select 1 from public.sales where id = new.sale_id and tenant_id = new.tenant_id)) then
    raise exception 'loyalty entry does not belong to this business' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger loyalty_entry_guard before insert on public.loyalty_entries for each row execute function public.check_loyalty_entry();

do $$
declare def text;
begin
  def := pg_get_functiondef('public.sync_push(uuid, jsonb)'::regprocedure);
  if position('loyalty_entries' in def) = 0 then
    def := replace(def, E'    else\n      raise exception ''unknown table %'', t using errcode = ''22023'';',
$p$    elsif t = 'loyalty_rules' then
      insert into public.loyalty_rules (id, tenant_id, enabled, earn_per, point_value, min_redeem, max_share_bp, set_by, set_at)
      select id, tenant_id, enabled, earn_per, point_value, min_redeem, max_share_bp, auth.uid(), set_at from jsonb_populate_record(null::public.loyalty_rules, pl);
    elsif t = 'loyalty_entries' then
      insert into public.loyalty_entries (id, tenant_id, customer_id, points, kind, sale_id, return_id, note, created_by, occurred_at)
      select id, tenant_id, customer_id, points, kind, sale_id, return_id, note, auth.uid(), occurred_at from jsonb_populate_record(null::public.loyalty_entries, pl);
    else
      raise exception 'unknown table %', t using errcode = '22023';$p$);
    if position('loyalty_entries' in def) = 0 then raise exception 'could not extend sync_push'; end if;
    execute def;
  end if;
  def := pg_get_functiondef('public.sync_pull(timestamp with time zone, integer)'::regprocedure);
  if position('loyalty_entries' in def) = 0 then
    def := replace(def, '''stock_batches'']', '''stock_batches'',''loyalty_rules'',''loyalty_entries'']');
    if position('loyalty_entries' in def) = 0 then raise exception 'could not extend sync_pull'; end if;
    execute def;
  end if;
end $$;

revoke all on function public.check_loyalty_entry() from public, anon;
revoke all on function public.sync_push(uuid, jsonb) from public, anon;
grant execute on function public.sync_push(uuid, jsonb) to authenticated;
revoke all on function public.sync_pull(timestamptz, int) from public, anon;
grant execute on function public.sync_pull(timestamptz, int) to authenticated;
