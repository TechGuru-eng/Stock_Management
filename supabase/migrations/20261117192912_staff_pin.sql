-- StockCM 0010: staff PIN login, registered devices, lockout, revocation.
--
-- Design
--   * Owners sign in with a phone number (SMS code). Staff sign in with a PIN, on a REGISTERED device only.
--   * The PIN is checked HERE, on the server, with a lockout (5 wrong PINs -> locked 5 min, doubling to 1 h).
--   * A device is registered with a one-time enrollment code created by the owner (valid 15 minutes).
--     The device gets a random secret; only its hash is stored. Revoking the device kills that secret.
--   * After a correct PIN the Edge Function mints a normal Supabase session for that staff member, so
--     every rule already built (roles, row-level security, audit trail) applies to them unchanged.
--   * PINs are stored only as bcrypt hashes. None of these tables is readable by any client:
--     RLS is on with no policy, and the functions are callable only by the roles listed below.

-- ------------------------------------------------------------ tables
create table public.staff_credentials (
  membership_id uuid primary key references public.memberships(id) on delete cascade,
  pin_hash text not null,
  pin_set_at timestamptz not null default now(),
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_failed_at timestamptz,
  last_login_at timestamptz
);

create table public.device_credentials (
  device_id uuid primary key references public.devices(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  secret_hash text not null,
  enrolled_at timestamptz not null default now()
);

create table public.device_enrollment_codes (
  code_hash text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_by uuid references auth.users(id),
  device_name text,
  expires_at timestamptz not null,
  used_at timestamptz
);

alter table public.staff_credentials enable row level security;
alter table public.device_credentials enable row level security;
alter table public.device_enrollment_codes enable row level security;

-- ------------------------------------------------------------ rules (mirrors src/domain/staffPin.ts)
create or replace function public.pin_is_acceptable(p text) returns boolean
language plpgsql immutable set search_path = public as $$
declare i int; step int; seq boolean := true;
begin
  if p is null or p !~ '^[0-9]{4,6}$' then return false; end if;
  if p ~ '^(\d)\1+$' then return false; end if;
  step := substr(p, 2, 1)::int - substr(p, 1, 1)::int;
  if step in (1, -1) then
    for i in 2 .. length(p) - 1 loop
      if substr(p, i + 1, 1)::int - substr(p, i, 1)::int <> step then seq := false; end if;
    end loop;
    if seq then return false; end if;
  end if;
  if p = any (array['1212','2580','0852','2000','1004','1122','6969','1313','4200','1010',
                    '123123','121212','112233','696969','159753','789456','123321','654321','111222','102030']) then
    return false;
  end if;
  return true;
end $$;

create or replace function public.staff_lock_seconds(failed int) returns int
language sql immutable as $$
  select case when failed < 5 then 0 else least(300 * (power(2, least(failed - 5, 10)))::int, 3600) end
$$;

-- ------------------------------------------------------------ owner actions (signed-in owner)
create or replace function public.set_staff_pin(p_membership uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare m record;
begin
  select * into m from public.memberships where id = p_membership;
  if m.id is null then raise exception 'staff member not found' using errcode = 'P0002'; end if;
  if not public.has_permission(m.tenant_id, 'staff.manage') then
    raise exception 'only the owner can manage staff' using errcode = '42501';
  end if;
  if m.role = 'owner' then
    raise exception 'the owner signs in with a phone number, not a PIN' using errcode = '22023';
  end if;
  if not public.pin_is_acceptable(p_pin) then
    raise exception 'that PIN is too easy to guess' using errcode = '22023';
  end if;
  insert into public.staff_credentials (membership_id, pin_hash)
  values (p_membership, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)))
  on conflict (membership_id) do update
    set pin_hash = excluded.pin_hash, pin_set_at = now(), failed_attempts = 0, locked_until = null;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id)
  values (m.tenant_id, auth.uid(), 'staff.pin_set', 'membership', p_membership);
end $$;

create or replace function public.set_staff_active(p_membership uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  select * into m from public.memberships where id = p_membership;
  if m.id is null then raise exception 'staff member not found' using errcode = 'P0002'; end if;
  if not public.has_permission(m.tenant_id, 'staff.manage') then
    raise exception 'only the owner can manage staff' using errcode = '42501';
  end if;
  if m.role = 'owner' then raise exception 'the owner cannot be deactivated here' using errcode = '22023'; end if;
  update public.memberships set active = p_active where id = p_membership;
  if not p_active then
    -- cut every session this person has, everywhere, right now
    delete from auth.sessions where user_id = m.user_id;
  end if;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id)
  values (m.tenant_id, auth.uid(), case when p_active then 'staff.reactivated' else 'staff.deactivated' end, 'membership', p_membership);
end $$;

create or replace function public.unlock_staff(p_membership uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  select * into m from public.memberships where id = p_membership;
  if m.id is null or not public.has_permission(m.tenant_id, 'staff.manage') then
    raise exception 'only the owner can manage staff' using errcode = '42501';
  end if;
  update public.staff_credentials set failed_attempts = 0, locked_until = null where membership_id = p_membership;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id)
  values (m.tenant_id, auth.uid(), 'staff.unlocked', 'membership', p_membership);
end $$;

create or replace function public.staff_lock_status(p_tenant uuid)
returns table (membership_id uuid, failed_attempts int, locked_until timestamptz, has_pin boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_permission(p_tenant, 'staff.manage') then
    raise exception 'only the owner can manage staff' using errcode = '42501';
  end if;
  return query
    select m.id, coalesce(c.failed_attempts, 0), c.locked_until, c.membership_id is not null
      from public.memberships m left join public.staff_credentials c on c.membership_id = m.id
     where m.tenant_id = p_tenant and m.role <> 'owner';
end $$;

-- A one-time code (valid 15 minutes) that lets ONE new device register itself.
create or replace function public.create_enrollment_code(p_tenant uuid, p_device_name text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- no 0/O/1/I: easy to read aloud
  bytes bytea := extensions.gen_random_bytes(10); code text := ''; i int; expires timestamptz := now() + interval '15 minutes';
begin
  if not public.has_permission(p_tenant, 'staff.manage') then
    raise exception 'only the owner can register devices' using errcode = '42501';
  end if;
  for i in 0 .. 9 loop
    code := code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  insert into public.device_enrollment_codes (code_hash, tenant_id, created_by, device_name, expires_at)
  values (encode(extensions.digest(code, 'sha256'), 'hex'), p_tenant, auth.uid(), p_device_name, expires);
  insert into public.audit_logs (tenant_id, actor_id, action, entity)
  values (p_tenant, auth.uid(), 'device.enrollment_code_created', 'device');
  return jsonb_build_object('code', substr(code, 1, 4) || '-' || substr(code, 5, 4) || '-' || substr(code, 9, 2), 'expires_at', expires);
end $$;

create or replace function public.revoke_device(p_device uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  select * into d from public.devices where id = p_device;
  if d.id is null or not public.has_permission(d.tenant_id, 'staff.manage') then
    raise exception 'only the owner can revoke devices' using errcode = '42501';
  end if;
  update public.devices set revoked_at = now() where id = p_device;
  delete from public.device_credentials where device_id = p_device;   -- its secret stops working at once
  insert into public.audit_logs (tenant_id, actor_id, device_id, action, entity, entity_id)
  values (d.tenant_id, auth.uid(), p_device, 'device.revoked', 'device', p_device);
end $$;

-- ------------------------------------------------------------ service-only (Edge Functions)
create or replace function public.device_tenant(p_device uuid, p_secret text) returns uuid
language sql stable security definer set search_path = public, extensions as $$
  select c.tenant_id
    from public.device_credentials c join public.devices d on d.id = c.device_id
   where c.device_id = p_device and d.revoked_at is null
     and c.secret_hash = encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')
$$;

create or replace function public.redeem_enrollment_code(p_code text, p_device uuid, p_device_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c record; secret text := encode(extensions.gen_random_bytes(24), 'hex'); t record;
begin
  select * into c from public.device_enrollment_codes
   where code_hash = encode(extensions.digest(upper(regexp_replace(coalesce(p_code,''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex')
     and used_at is null and expires_at > now()
   for update;
  if c.code_hash is null then
    raise exception 'that code is not valid or has expired' using errcode = '28000';
  end if;
  insert into public.devices (id, tenant_id, name, last_sync_at)
  values (p_device, c.tenant_id, coalesce(nullif(p_device_name,''), c.device_name, 'device'), null)
  on conflict (id) do nothing;
  if not exists (select 1 from public.devices where id = p_device and tenant_id = c.tenant_id and revoked_at is null) then
    raise exception 'this device cannot be registered here' using errcode = '42501';
  end if;
  insert into public.device_credentials (device_id, tenant_id, secret_hash)
  values (p_device, c.tenant_id, encode(extensions.digest(secret, 'sha256'), 'hex'))
  on conflict (device_id) do update set secret_hash = excluded.secret_hash, enrolled_at = now();
  update public.device_enrollment_codes set used_at = now() where code_hash = c.code_hash;
  insert into public.audit_logs (tenant_id, device_id, action, entity, entity_id)
  values (c.tenant_id, p_device, 'device.enrolled', 'device', p_device);
  select id, name into t from public.tenants where id = c.tenant_id;
  return jsonb_build_object('device_id', p_device, 'secret', secret, 'tenant_id', t.id, 'tenant_name', t.name);
end $$;

create or replace function public.list_staff_for_device(p_device uuid, p_secret text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tn uuid := public.device_tenant(p_device, p_secret);
begin
  if tn is null then raise exception 'this device is not registered' using errcode = '28000'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'full_name', m.full_name, 'role', m.role) order by m.full_name)
      from public.memberships m
     where m.tenant_id = tn and m.active and m.role <> 'owner'
       and exists (select 1 from public.staff_credentials c where c.membership_id = m.id)
  ), '[]'::jsonb);
end $$;

-- Returns {ok:false, reason, ...} for every refusal, so a caller learns nothing it should not.
create or replace function public.verify_staff_pin(p_device uuid, p_secret text, p_membership uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  tn uuid := public.device_tenant(p_device, p_secret);
  m record; c record; failed int; wait int; recent int;
begin
  if tn is null then return jsonb_build_object('ok', false, 'reason', 'device_not_registered'); end if;

  -- slow down guessing across many staff accounts from one device
  select count(*) into recent from public.audit_logs
   where device_id = p_device and action = 'staff.pin_failed' and created_at > now() - interval '10 minutes';
  if recent >= 20 then return jsonb_build_object('ok', false, 'reason', 'device_throttled', 'retry_after', 600); end if;

  select * into m from public.memberships where id = p_membership and tenant_id = tn and active and role <> 'owner';
  if m.id is null then return jsonb_build_object('ok', false, 'reason', 'wrong_pin'); end if;   -- same answer as a wrong PIN
  select * into c from public.staff_credentials where membership_id = m.id for update;
  if c.membership_id is null then return jsonb_build_object('ok', false, 'reason', 'wrong_pin'); end if;

  if c.locked_until is not null and c.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked',
                              'retry_after', ceil(extract(epoch from (c.locked_until - now())))::int);
  end if;

  if c.pin_hash = extensions.crypt(coalesce(p_pin, ''), c.pin_hash) then
    update public.staff_credentials set failed_attempts = 0, locked_until = null, last_login_at = now() where membership_id = m.id;
    insert into public.audit_logs (tenant_id, actor_id, device_id, action, entity, entity_id)
    values (tn, m.user_id, p_device, 'staff.login', 'membership', m.id);
    return jsonb_build_object('ok', true, 'user_id', m.user_id, 'membership_id', m.id, 'role', m.role,
                              'full_name', m.full_name, 'tenant_id', tn);
  end if;

  failed := c.failed_attempts + 1;
  wait := public.staff_lock_seconds(failed);
  update public.staff_credentials
     set failed_attempts = failed, last_failed_at = now(),
         locked_until = case when wait > 0 then now() + make_interval(secs => wait) else null end
   where membership_id = m.id;
  insert into public.audit_logs (tenant_id, actor_id, device_id, action, entity, entity_id, after_state)
  values (tn, m.user_id, p_device, 'staff.pin_failed', 'membership', m.id, jsonb_build_object('failed_attempts', failed));
  if wait > 0 then
    insert into public.audit_logs (tenant_id, actor_id, device_id, action, entity, entity_id, after_state)
    values (tn, m.user_id, p_device, 'staff.locked', 'membership', m.id, jsonb_build_object('seconds', wait));
  end if;
  return jsonb_build_object('ok', false, 'reason', case when wait > 0 then 'locked' else 'wrong_pin' end,
                            'attempts_left', greatest(5 - failed, 0), 'retry_after', wait);
end $$;

-- ------------------------------------------------------------ who may call what
revoke all on function public.pin_is_acceptable(text) from public, anon;
revoke all on function public.staff_lock_seconds(int) from public, anon;
grant execute on function public.pin_is_acceptable(text), public.staff_lock_seconds(int) to authenticated, service_role;

revoke all on function public.set_staff_pin(uuid, text), public.set_staff_active(uuid, boolean),
  public.unlock_staff(uuid), public.staff_lock_status(uuid), public.create_enrollment_code(uuid, text),
  public.revoke_device(uuid) from public, anon;
grant execute on function public.set_staff_pin(uuid, text), public.set_staff_active(uuid, boolean),
  public.unlock_staff(uuid), public.staff_lock_status(uuid), public.create_enrollment_code(uuid, text),
  public.revoke_device(uuid) to authenticated;

revoke all on function public.device_tenant(uuid, text), public.redeem_enrollment_code(text, uuid, text),
  public.list_staff_for_device(uuid, text), public.verify_staff_pin(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.device_tenant(uuid, text), public.redeem_enrollment_code(text, uuid, text),
  public.list_staff_for_device(uuid, text), public.verify_staff_pin(uuid, text, uuid, text) to service_role;
