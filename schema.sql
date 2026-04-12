-- ================================================================
-- 동아리방 시간표 — Supabase Schema
-- Supabase Dashboard > SQL Editor 에서 전체 실행
-- ================================================================

-- 팀 테이블
create table if not exists teams (
  id        serial primary key,
  name      text not null,
  type      text not null check (type in ('합주', '스쿨')),
  color     text not null default '#e8ff47',
  created_at timestamptz default now()
);

-- 슬롯 테이블 (정규 배정 시간)
-- day: 0=월 1=화 2=수 3=목 4=금 5=토 6=일
create table if not exists slots (
  id          serial primary key,
  team_id     int not null references teams(id) on delete cascade,
  day         int not null check (day between 0 and 6),
  hour        int not null check (hour between 0 and 23),
  slot_type   text not null default 'regular' check (slot_type in ('regular', 'extra')),
  status      text not null default 'normal' check (status in ('normal', 'absent')),
  week_offset int not null default 0,  -- 0 = 이번 주, 1 = 다음 주, ...
  created_at  timestamptz default now(),
  unique (day, hour, week_offset)       -- 같은 시간에 두 팀 배정 불가
);

-- 신청 테이블 (미사용 신고 / 추가 사용 신청)
create table if not exists requests (
  id          serial primary key,
  type        text not null check (type in ('absent', 'extra')),
  team_id     int not null references teams(id) on delete cascade,
  slot_id     int references slots(id) on delete set null,  -- absent의 경우
  day         int not null check (day between 0 and 6),
  hour        int not null check (hour between 0 and 23),
  week_offset int not null default 0,
  reason      text not null,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requester_name text,
  reviewed_at timestamptz,
  created_at  timestamptz default now()
);

-- 관리자 설정 테이블 (비밀번호 등 단순 설정)
create table if not exists app_config (
  key   text primary key,
  value text not null
);

-- ── Row Level Security ───────────────────────────────────────────
-- 이 앱은 별도 Auth 없이 anon key만 사용 (관리자 비밀번호는 클라이언트 단에서 처리)
-- 모든 테이블을 anon에게 읽기/쓰기 허용 (Supabase RLS 비활성화 또는 아래 정책 적용)

alter table teams      enable row level security;
alter table slots      enable row level security;
alter table requests   enable row level security;
alter table app_config enable row level security;

-- 전체 읽기 허용 (anon)
create policy "public read teams"      on teams      for select using (true);
create policy "public read slots"      on slots      for select using (true);
create policy "public read requests"   on requests   for select using (true);
create policy "public read config"     on app_config for select using (true);

-- 쓰기: anon도 허용 (관리자 검증은 앱 레이어에서)
create policy "public write slots"     on slots      for all using (true) with check (true);
create policy "public write requests"  on requests   for all using (true) with check (true);
create policy "public write teams"     on teams      for all using (true) with check (true);
create policy "public write config"    on app_config for all using (true) with check (true);

-- ── 초기 데이터 ─────────────────────────────────────────────────

insert into app_config (key, value) values
  ('admin_password', 'band1234')   -- 반드시 변경!
on conflict (key) do nothing;

insert into teams (name, type, color) values
  ('블루문',       '합주', '#e8ff47'),
  ('소닉붐',       '합주', '#47c5ff'),
  ('레드스타',     '합주', '#ff6b6b'),
  ('더웨이브',     '합주', '#6bffb8'),
  ('에코',         '스쿨', '#ffaa47'),
  ('그루브팩토리', '합주', '#c47fff'),
  ('노이즈',       '합주', '#ff47a0'),
  ('선셋',         '스쿨', '#47ffea')
on conflict do nothing;

-- 이번 주(week_offset=0) 샘플 슬롯 — team_id는 insert 순서 기준 1~8
insert into slots (team_id, day, hour, slot_type, week_offset) values
  (1, 0, 14, 'regular', 0),
  (2, 0, 15, 'regular', 0),
  (3, 1, 13, 'regular', 0),
  (4, 1, 16, 'regular', 0),
  (5, 2, 11, 'regular', 0),
  (6, 2, 14, 'regular', 0),
  (7, 3, 10, 'regular', 0),
  (8, 3, 15, 'regular', 0),
  (1, 4, 16, 'regular', 0),
  (3, 4, 18, 'regular', 0),
  (2, 5, 12, 'regular', 0),
  (5, 6, 14, 'regular', 0),
  (4, 2, 19, 'regular', 0),
  (6, 5, 17, 'regular', 0)
on conflict do nothing;
