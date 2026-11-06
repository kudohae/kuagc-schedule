-- Store each song applicant as a real band_members row.
-- The applicant role marker remains in band_songs.wanted_roles so old clients keep working.

alter table public.band_members
  add column if not exists is_song_applicant boolean not null default false;

create unique index if not exists band_members_one_song_applicant_idx
  on public.band_members (song_id)
  where is_song_applicant;

grant select (is_song_applicant) on public.band_members to anon, authenticated;

create or replace function private.band_song_applicant_role(p_song_id bigint)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select public.normalize_band_role(
    (regexp_match(btrim(raw_role), '^_+BAND_APPLICANT_ROLE_+:(.+)$', 'i'))[1]
  )
  from public.band_songs s
  cross join lateral unnest(s.wanted_roles) raw_role
  where s.id = p_song_id
    and btrim(raw_role) ~* '^_+BAND_APPLICANT_ROLE_+:'
  limit 1;
$$;

create or replace function private.sync_band_song_applicant_member(p_song_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  song_row public.band_songs%rowtype;
  applicant_role text;
begin
  select * into song_row
  from public.band_songs
  where id = p_song_id;

  if not found then return; end if;

  applicant_role := private.band_song_applicant_role(p_song_id);
  if coalesce(applicant_role, '') = '' then
    delete from public.band_members
    where song_id = p_song_id and is_song_applicant;
    return;
  end if;

  insert into public.band_members (
    song_id,
    applicant_name,
    student_id,
    roles,
    note,
    created_at,
    updated_at,
    is_included,
    is_song_applicant
  ) values (
    song_row.id,
    song_row.applicant_name,
    song_row.student_id,
    array[applicant_role],
    '',
    song_row.created_at,
    now(),
    true,
    true
  )
  on conflict (song_id) where is_song_applicant
  do update set
    applicant_name = excluded.applicant_name,
    student_id = excluded.student_id,
    roles = excluded.roles,
    note = '',
    created_at = excluded.created_at,
    updated_at = now(),
    is_included = true;
end;
$$;

create or replace function private.band_song_is_complete(p_song_id bigint)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  with selected_song as (
    select id, wanted_roles
    from public.band_songs
    where id = p_song_id
  ),
  requirements as (
    select public.normalize_band_role(raw_role) as role, count(*)::integer as capacity
    from selected_song s
    cross join lateral unnest(s.wanted_roles) raw_role
    where btrim(raw_role) !~* '^_+BAND_FIXED_+$'
      and btrim(raw_role) !~* '^_+BAND_APPLICANT_ROLE_+:'
      and public.normalize_band_role(raw_role) <> ''
    group by public.normalize_band_role(raw_role)
  ),
  member_roles as (
    select distinct
      m.id,
      public.normalize_band_role(raw_role) as role,
      m.is_included,
      private.band_member_role_directive(m.note, public.normalize_band_role(raw_role)) as directive
    from public.band_members m
    cross join lateral unnest(m.roles) raw_role
    where m.song_id = p_song_id
      and public.normalize_band_role(raw_role) <> ''
  ),
  role_counts as (
    select
      r.role,
      r.capacity,
      count(m.id) filter (where m.directive = 'force_on')::integer as forced_count,
      count(m.id) filter (where m.directive = 'extra_on')::integer as extra_count,
      count(m.id) filter (
        where m.directive not in ('force_on', 'force_off', 'extra_on')
          and m.is_included is not false
      )::integer as automatic_count
    from requirements r
    left join member_roles m on m.role = r.role
    group by r.role, r.capacity
  )
  select exists (select 1 from requirements)
    and not exists (
      select 1
      from role_counts c
      where c.forced_count
        + c.extra_count
        + least(c.automatic_count, greatest(c.capacity - c.forced_count, 0))
        < c.capacity
    );
$$;

create or replace function private.recompute_band_song_from_song()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.sync_band_song_applicant_member(new.id);
  perform private.recompute_band_song_formation(new.id);
  return new;
end;
$$;

revoke all on function private.band_song_applicant_role(bigint) from public, anon, authenticated;
revoke all on function private.sync_band_song_applicant_member(bigint) from public, anon, authenticated;
revoke all on function private.band_song_is_complete(bigint) from public, anon, authenticated;
revoke all on function private.recompute_band_song_from_song() from public, anon, authenticated;

drop trigger if exists band_songs_recompute_formation_roles on public.band_songs;
create trigger band_songs_recompute_formation_roles
after update of wanted_roles, applicant_name, student_id, formation_override
on public.band_songs
for each row execute function private.recompute_band_song_from_song();

-- Only songs with an explicit applicant-role marker can be migrated safely.
select private.sync_band_song_applicant_member(s.id)
from public.band_songs s
where exists (
  select 1
  from unnest(s.wanted_roles) raw_role
  where btrim(raw_role) ~* '^_+BAND_APPLICANT_ROLE_+:'
);

-- The new member rows may complete an automatic song.
select private.recompute_band_song_formation(id)
from public.band_songs
where formation_override = 'auto' and not is_formed;
