-- StockCM 0013: a platform admin can read (and create, if missing) the webhook secret that the payment provider
-- must sign messages with. Nobody else can read platform_secrets.
create or replace function public.admin_webhook_secret() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v text;
begin
  if not public.is_platform_admin() then raise exception 'platform admins only' using errcode = '42501'; end if;
  select value into v from public.platform_secrets where key = 'billing_webhook_secret';
  if v is null then
    v := encode(extensions.gen_random_bytes(32), 'hex');
    insert into public.platform_secrets (key, value) values ('billing_webhook_secret', v);
  end if;
  return v;
end $$;
revoke all on function public.admin_webhook_secret() from public, anon;
grant execute on function public.admin_webhook_secret() to authenticated;
