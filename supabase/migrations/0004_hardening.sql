-- StockCM 0004: security advisor fixes.
-- * Fix the search_path of the trigger helper functions.
-- * Anonymous visitors must not be able to call internal SECURITY DEFINER helpers.
--   RLS policies still need my_tenants() and has_permission() for signed-in users.
-- * The stock projection trigger function is never called directly by clients.
-- platform_settings intentionally has RLS enabled with no policy: only the
-- service role (Edge Functions, admin dashboard) can read or write it.

alter function public.prevent_mutation() set search_path = public;
alter function public.touch_updated_at() set search_path = public;

revoke all on function public.my_tenants() from public, anon;
revoke all on function public.has_permission(uuid, text) from public, anon;
grant execute on function public.my_tenants() to authenticated;
grant execute on function public.has_permission(uuid, text) to authenticated;

revoke all on function public.apply_stock_movement() from public, anon, authenticated;
