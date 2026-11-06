-- Public session applications may select only roles registered on the song.

create or replace function public.normalize_band_role(p_role text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when regexp_replace(lower(btrim(p_role)), '\s+', '', 'g') ~ '^(보컬|vocal)[0-9]*$' then '보컬'
    when regexp_replace(lower(btrim(p_role)), '\s+', '', 'g') ~ '^(기타|guitar)[0-9]*$' then '기타'
    when regexp_replace(lower(btrim(p_role)), '\s+', '', 'g') ~ '^(베이스|bass)[0-9]*$' then '베이스'
    when regexp_replace(lower(btrim(p_role)), '\s+', '', 'g') ~ '^(키보드|건반|keyboard|key)[0-9]*$' then '키보드'
    when regexp_replace(lower(btrim(p_role)), '\s+', '', 'g') ~ '^(드럼|drum|drums)[0-9]*$' then '드럼'
    else btrim(p_role)
  end
$$;

grant execute on function public.normalize_band_role(text) to anon, authenticated;

drop policy if exists "band members public apply" on public.band_members;
create policy "band members public apply"
on public.band_members for insert
to anon
with check (
  exists (
    select 1
    from public.band_songs s
    join public.band_rounds r on r.id = s.round_id
    where s.id = song_id
      and r.is_active
      and r.session_application_open
      and cardinality(band_members.roles) > 0
      and not exists (
        select 1
        from unnest(band_members.roles) requested(role)
        where not exists (
          select 1
          from unnest(s.wanted_roles) wanted(role)
          where public.normalize_band_role(wanted.role) = public.normalize_band_role(requested.role)
        )
      )
  )
);
