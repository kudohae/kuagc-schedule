-- Enable Postgres Changes for the standalone band pages.
-- Safe to run repeatedly: existing publication memberships are ignored.

do $$
begin
  alter publication supabase_realtime add table public.band_rounds;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.band_songs;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.band_members;
exception when duplicate_object then null;
end $$;
