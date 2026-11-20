-- Backfilled from the live database: this one-line fix was applied directly to the remote project on
-- 2026-11-17 and was never saved as a migration file. Recorded here so local history matches reality.
alter function public.device_roster(uuid) volatile;
