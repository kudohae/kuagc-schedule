alter table public.song_applications
  add column if not exists is_formed boolean;

comment on column public.song_applications.is_formed
  is 'Final ensemble formation flag. true = formed, false = unformed, null = not finalized yet.';
