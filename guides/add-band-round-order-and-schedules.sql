create extension if not exists pg_cron with schema pg_catalog;

alter table public.band_rounds
  add column if not exists sort_order integer,
  add column if not exists song_schedule_mode text not null default 'manual',
  add column if not exists song_open_at timestamptz,
  add column if not exists song_close_at timestamptz,
  add column if not exists session_schedule_mode text not null default 'manual',
  add column if not exists session_open_at timestamptz,
  add column if not exists session_close_at timestamptz;

with ranked as (
  select id, row_number() over (order by created_at desc, id desc) as position
  from public.band_rounds
)
update public.band_rounds as rounds
set sort_order = ranked.position
from ranked
where rounds.id = ranked.id and rounds.sort_order is null;

alter table public.band_rounds alter column sort_order set default 0;
alter table public.band_rounds alter column sort_order set not null;

alter table public.band_rounds drop constraint if exists band_rounds_song_schedule_mode_check;
alter table public.band_rounds add constraint band_rounds_song_schedule_mode_check check (song_schedule_mode in ('manual', 'auto'));
alter table public.band_rounds drop constraint if exists band_rounds_session_schedule_mode_check;
alter table public.band_rounds add constraint band_rounds_session_schedule_mode_check check (session_schedule_mode in ('manual', 'auto'));
alter table public.band_rounds drop constraint if exists band_rounds_song_schedule_range_check;
alter table public.band_rounds add constraint band_rounds_song_schedule_range_check check (song_schedule_mode = 'manual' or (song_open_at is not null and song_close_at is not null and song_open_at < song_close_at));
alter table public.band_rounds drop constraint if exists band_rounds_session_schedule_range_check;
alter table public.band_rounds add constraint band_rounds_session_schedule_range_check check (session_schedule_mode = 'manual' or (session_open_at is not null and session_close_at is not null and session_open_at < session_close_at));

create or replace function public.apply_band_round_schedules()
returns void language sql security invoker set search_path = '' as $$
  update public.band_rounds
  set song_application_open = current_timestamp >= song_open_at and current_timestamp < song_close_at
  where song_schedule_mode = 'auto'
    and song_application_open is distinct from (current_timestamp >= song_open_at and current_timestamp < song_close_at);
  update public.band_rounds
  set session_application_open = current_timestamp >= session_open_at and current_timestamp < session_close_at
  where session_schedule_mode = 'auto'
    and session_application_open is distinct from (current_timestamp >= session_open_at and current_timestamp < session_close_at);
$$;

revoke execute on function public.apply_band_round_schedules() from public, anon, authenticated;
grant execute on function public.apply_band_round_schedules() to postgres;
select cron.schedule('band-round-schedule-sync', '5 seconds', 'select public.apply_band_round_schedules()');
select public.apply_band_round_schedules();
