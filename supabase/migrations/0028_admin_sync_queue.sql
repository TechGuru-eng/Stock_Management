-- Admin sync-issue triage queue: until now, `sync_issues` could only be viewed one tenant at a time (inside a
-- support session) and only the business's own devices could resolve one (migration 0014). This adds a
-- cross-tenant queue for 'support'/'super' admins, so a recurring problem is spotted without opening each
-- business individually, and a stuck issue can be cleared from the dashboard with a note in the audit log.

create or replace function public.admin_list_sync_issues(p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_check('sync');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', i.id, 'tenant_id', i.tenant_id, 'business', t.name, 'kind', i.kind, 'error', i.error,
      'device', d.name, 'group_id', i.group_id, 'first_seen', i.first_seen, 'last_seen', i.last_seen
    ) order by i.last_seen desc)
    from (select * from public.sync_issues where resolved_at is null order by last_seen desc limit least(greatest(p_limit, 1), 500)) i
    join public.tenants t on t.id = i.tenant_id
    left join public.devices d on d.id = i.device_id
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_resolve_sync_issue(p_tenant uuid, p_group uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_check('sync');
  if length(trim(coalesce(p_note, ''))) < 5 then raise exception 'give a note' using errcode = '22023'; end if;
  update public.sync_issues set resolved_at = now() where tenant_id = p_tenant and group_id = p_group and resolved_at is null;
  if not found then raise exception 'issue not found or already resolved' using errcode = 'P0002'; end if;
  perform public.admin_log('sync_issue.resolved', p_tenant, jsonb_build_object('group', p_group, 'note', p_note));
end $$;

revoke all on function public.admin_list_sync_issues(int), public.admin_resolve_sync_issue(uuid, uuid, text) from public, anon;
grant execute on function public.admin_list_sync_issues(int), public.admin_resolve_sync_issue(uuid, uuid, text) to authenticated;
