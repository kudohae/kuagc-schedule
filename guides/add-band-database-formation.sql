-- Move one-time automatic band formation from browser memory into PostgreSQL.
-- Safe to run repeatedly. Existing formed songs are preserved as manual decisions;
-- existing unformed songs remain eligible for automatic formation.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

alter table public.band_songs
  add column if not exists auto_formed_at timestamptz,
  add column if not exists formation_override text not null default 'auto';

update public.band_songs
set formation_override = case when is_formed then 'formed' else 'auto' end
where formation_override not in ('auto', 'formed', 'unformed')
   or (formation_override = 'auto' and is_formed and auto_formed_at is null);

alter table public.band_songs
  drop constraint if exists band_songs_formation_override_check;
alter table public.band_songs
  add constraint band_songs_formation_override_check
  check (formation_override in ('auto', 'formed', 'unformed'));

alter table public.band_songs
  drop constraint if exists band_songs_formation_state_check;
alter table public.band_songs
  add constraint band_songs_formation_state_check
  check (
    formation_override = 'auto'
    or (formation_override = 'formed' and is_formed)
    or (formation_override = 'unformed' and not is_formed)
  );

create or replace function private.decode_uri_component(p_value text)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  result bytea := ''::bytea;
  position integer := 1;
  current_char text;
  hex_pair text;
begin
  while position <= length(p_value) loop
    current_char := substr(p_value, position, 1);
    hex_pair := substr(p_value, position + 1, 2);
    if current_char = '%' and length(hex_pair) = 2 and hex_pair ~ '^[0-9A-Fa-f]{2}$' then
      result := result || decode(hex_pair, 'hex');
      position := position + 3;
    else
      result := result || convert_to(current_char, 'UTF8');
      position := position + 1;
    end if;
  end loop;
  return convert_from(result, 'UTF8');
end;
$$;

create or replace function private.band_member_role_directive(p_note text, p_role text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  encoded text;
  directives jsonb;
  state text;
begin
  encoded := substring(coalesce(p_note, '') from '__BAND_ALLOCATION__:([^[:space:]]+)[[:space:]]*$');
  if encoded is null then return ''; end if;
  directives := private.decode_uri_component(encoded)::jsonb;
  state := directives ->> p_role;
  if state in ('force_on', 'force_off', 'extra_on') then return state; end if;
  return '';
exception when others then
  return '';
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
  applicant as (
    select public.normalize_band_role((regexp_match(btrim(raw_role), '^_+BAND_APPLICANT_ROLE_+:(.+)$', 'i'))[1]) as role
    from selected_song s
    cross join lateral unnest(s.wanted_roles) raw_role
    where btrim(raw_role) ~* '^_+BAND_APPLICANT_ROLE_+:'
    limit 1
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
      case when a.role = r.role then 1 else 0 end as applicant_count,
      count(m.id) filter (where m.directive = 'force_on')::integer as forced_count,
      count(m.id) filter (where m.directive = 'extra_on')::integer as extra_count,
      count(m.id) filter (
        where m.directive not in ('force_on', 'force_off', 'extra_on')
          and m.is_included is not false
      )::integer as automatic_count
    from requirements r
    left join applicant a on true
    left join member_roles m on m.role = r.role
    group by r.role, r.capacity, a.role
  )
  select exists (select 1 from requirements)
    and not exists (
      select 1
      from role_counts c
      where c.applicant_count
        + c.forced_count
        + c.extra_count
        + least(c.automatic_count, greatest(c.capacity - c.applicant_count - c.forced_count, 0))
        < c.capacity
    );
$$;

create or replace function private.recompute_band_song_formation(p_song_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.band_songs s
  set is_formed = true,
      auto_formed_at = coalesce(s.auto_formed_at, now())
  where s.id = p_song_id
    and not s.is_formed
    and s.formation_override = 'auto'
    and not exists (
      select 1 from unnest(s.wanted_roles) raw_role
      where btrim(raw_role) ~* '^_+BAND_FIXED_+$'
    )
    and private.band_song_is_complete(s.id);
end;
$$;

create or replace function private.recompute_band_song_from_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'DELETE' then
    perform private.recompute_band_song_formation(new.song_id);
    return new;
  end if;
  return old;
end;
$$;

create or replace function private.recompute_band_song_from_song()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.recompute_band_song_formation(new.id);
  return new;
end;
$$;

revoke all on function private.decode_uri_component(text) from public, anon, authenticated;
revoke all on function private.band_member_role_directive(text, text) from public, anon, authenticated;
revoke all on function private.band_song_is_complete(bigint) from public, anon, authenticated;
revoke all on function private.recompute_band_song_formation(bigint) from public, anon, authenticated;
revoke all on function private.recompute_band_song_from_member() from public, anon, authenticated;
revoke all on function private.recompute_band_song_from_song() from public, anon, authenticated;

drop trigger if exists band_members_recompute_formation on public.band_members;
create trigger band_members_recompute_formation
after insert or update of song_id, roles, note, is_included or delete
on public.band_members
for each row execute function private.recompute_band_song_from_member();

drop trigger if exists band_songs_recompute_formation_insert on public.band_songs;
create trigger band_songs_recompute_formation_insert
after insert on public.band_songs
for each row execute function private.recompute_band_song_from_song();

drop trigger if exists band_songs_recompute_formation_roles on public.band_songs;
create trigger band_songs_recompute_formation_roles
after update of wanted_roles, formation_override on public.band_songs
for each row execute function private.recompute_band_song_from_song();

-- Backfill only songs that are still in automatic mode. Manual decisions remain untouched.
select private.recompute_band_song_formation(id)
from public.band_songs
where formation_override = 'auto' and not is_formed;

notify pgrst, 'reload schema';
