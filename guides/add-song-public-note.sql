-- 합주 신청 현황 공개 메모
-- Supabase Dashboard > SQL Editor 에서 한 번 실행

alter table public.song_applications
  add column if not exists public_note text not null default '';

comment on column public.song_applications.public_note
  is '합주 신청 현황에 표시되는 누구나 수정 가능한 한 줄 메모';

grant select (public_note), update (public_note)
  on public.song_applications
  to anon, authenticated;
