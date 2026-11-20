-- StockCM 0018: several staff on one device, including offline switching.
--
-- A shared till stays signed in under ONE session. When another person takes over with their PIN (checked on the device, no
-- internet), the records they make are uploaded "as" them. For that to be safe the server only accepts it when:
--   * the person has signed in on THIS device before while online (so they are in device_actors),
--   * they are an active, non-owner member of the same business,
--   * the session uploading is itself the owner or a person enrolled on the same device,
--   * the device has not been revoked.
-- The records then pass the same row-level security and permission checks as if that person had uploaded them, and each such
-- upload is written to the audit log with who vouched for it. Owners can never be acted for: they sign in online themselves.

create table public.device_actors (
  device_id uuid not null references public.devices(id) on delete cascade,
  user_id uuid not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (device_id, user_id)
);
alter table public.device_actors enable row level security;
create policy device_actors_select on public.device_actors for select using (tenant_id in (select public.my_tenants()));

-- every sync registers the signed-in person as someone who works on this device (owners are not recorded)
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
  insert into public.device_actors (device_id, user_id, tenant_id)
  select p_device, auth.uid(), p_tenant from public.memberships
   where tenant_id = p_tenant and user_id = auth.uid() and active and role <> 'owner'
  on conflict (device_id, user_id) do update set last_seen = now();
end $$;

-- who may be acted for on this device (the app prunes its offline list with this; deactivated people drop out)
create or replace function public.device_roster(p_device uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  select * into d from public.devices where id = p_device;
  if not found or d.revoked_at is not null or d.tenant_id not in (select public.my_tenants()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'name', m.full_name, 'role', m.role) order by m.full_name)
      from public.device_actors a
      join public.memberships m on m.user_id = a.user_id and m.tenant_id = a.tenant_id and m.active and m.role <> 'owner'
     where a.device_id = p_device), '[]'::jsonb);
end $$;

-- the checks (run as the real caller, before anything is switched), plus the audit trail
create or replace function public.attest_actor(p_device uuid, p_actor uuid, p_ops int) returns void
language plpgsql security definer set search_path = public as $$
declare d record; caller uuid := auth.uid();
begin
  if caller is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into d from public.devices where id = p_device;
  if not found or d.revoked_at is not null then raise exception 'this device is not allowed to sync' using errcode = '42501'; end if;
  if d.tenant_id not in (select public.my_tenants()) then raise exception 'not allowed' using errcode = '42501'; end if;
  -- the session vouching must be the owner or someone enrolled on this device
  if not (public.is_owner(d.tenant_id) or exists (select 1 from public.device_actors where device_id = p_device and user_id = caller)) then
    raise exception 'this session cannot act for others on this device' using errcode = '42501';
  end if;
  -- the person being acted for must be enrolled here and still active (never an owner)
  if not exists (
    select 1 from public.device_actors a join public.memberships m on m.user_id = a.user_id and m.tenant_id = a.tenant_id
     where a.device_id = p_device and a.user_id = p_actor and m.active and m.role <> 'owner'
  ) then
    raise exception 'unknown or inactive person for this device' using errcode = '42501';
  end if;
  insert into public.audit_logs (tenant_id, actor_id, device_id, action, entity, entity_id, after_state)
  values (d.tenant_id, p_actor, p_device, 'sync.uploaded_as', 'device', p_device, jsonb_build_object('vouched_by', caller, 'operations', p_ops));
end $$;

-- SECURITY INVOKER on purpose: after the checks the rest of the transaction sees the actor as the signed-in person, so
-- row-level security and role permissions apply to THEM, exactly as if they had uploaded.
create or replace function public.sync_push_as(p_device uuid, p_actor uuid, p_ops jsonb) returns jsonb
language plpgsql set search_path = public as $$
begin
  if p_actor = auth.uid() then
    return public.sync_push(p_device, p_ops);
  end if;
  perform public.attest_actor(p_device, p_actor, jsonb_array_length(p_ops));
  perform set_config('request.jwt.claims', json_build_object('sub', p_actor, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('request.jwt.claim.sub', p_actor::text, true);
  return public.sync_push(p_device, p_ops);
end $$;

revoke all on function public.device_roster(uuid), public.attest_actor(uuid, uuid, int), public.sync_push_as(uuid, uuid, jsonb) from public, anon;
grant execute on function public.device_roster(uuid), public.attest_actor(uuid, uuid, int), public.sync_push_as(uuid, uuid, jsonb) to authenticated;
