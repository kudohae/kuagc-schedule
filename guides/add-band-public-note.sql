-- Allow anyone to edit only the public note of a song in the active band round.

create or replace function public.set_band_song_note(p_song_id bigint, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.band_songs s
  set note = coalesce(p_note, '')
  where s.id = p_song_id
    and exists (
      select 1
      from public.band_rounds r
      where r.id = s.round_id
        and r.is_active
    );

  if not found then
    raise exception 'Active band song not found';
  end if;
end;
$$;

revoke all on function public.set_band_song_note(bigint, text) from public;
grant execute on function public.set_band_song_note(bigint, text) to anon, authenticated;
