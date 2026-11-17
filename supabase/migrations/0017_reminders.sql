-- StockCM 0017: renewal reminders for platform staff (WhatsApp click-to-chat, sent by a person).
-- Returns the businesses that need a nudge (ending within 5 days, or ended up to 30 days ago) WITH the owner's full phone
-- number, so it needs the billing role and a two-step login, and every use is written to the admin audit log.

create or replace function public.admin_renewal_reminders() returns jsonb
language plpgsql security definer set search_path = public as $$
declare rows jsonb;
begin
  perform public.admin_check('billing');
  select coalesce(jsonb_agg(row_to_json(x) order by x.period_end), '[]'::jsonb) into rows from (
    select t.id as tenant_id, t.name as business, t.language, bp.owner_name, bp.owner_phone, s.plan_code, p.price_xaf,
           s.period_end, public.sub_state(s) as state,
           (select max(a.at) from public.admin_audit_logs a where a.tenant_id = t.id and a.action = 'reminder.opened') as last_reminder
      from public.tenants t
      join public.subscriptions s on s.tenant_id = t.id
      join public.plans p on p.code = s.plan_code
      left join public.business_profiles bp on bp.tenant_id = t.id
     where s.status <> 'suspended'
       and s.period_end < now() + interval '5 days'
       and s.period_end > now() - interval '30 days'
  ) x;
  perform public.admin_log('reminders.viewed', null, jsonb_build_object('count', jsonb_array_length(rows)));
  return jsonb_build_object(
    'rows', rows,
    'grace_days', public.setting_int('grace_days', 7),
    'templates', coalesce((select value from public.platform_settings where key = 'notification_templates'), '{}'::jsonb));
end $$;

create or replace function public.admin_note_reminder(p_tenant uuid, p_kind text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_check('billing');
  if p_kind not in ('renewal_5d', 'renewal_2d', 'grace_started', 'expired') then raise exception 'unknown reminder' using errcode = '22023'; end if;
  if not exists (select 1 from public.tenants where id = p_tenant) then raise exception 'business not found' using errcode = 'P0002'; end if;
  perform public.admin_log('reminder.opened', p_tenant, jsonb_build_object('kind', p_kind, 'channel', 'whatsapp'));
end $$;

revoke all on function public.admin_renewal_reminders(), public.admin_note_reminder(uuid, text) from public, anon;
grant execute on function public.admin_renewal_reminders(), public.admin_note_reminder(uuid, text) to authenticated;
