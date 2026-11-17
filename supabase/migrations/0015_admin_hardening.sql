-- StockCM 0015: pin the search_path of two helper functions flagged by the security advisor.
alter function public.admin_perm_ok(text, text) set search_path = public;
alter function public.staff_lock_seconds(int) set search_path = public;
