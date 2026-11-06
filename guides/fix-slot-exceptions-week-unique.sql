-- slot_exceptions 주차 중복 판정 수정
--
-- 문제: week_offset은 "생성 시점(created_at) 기준 상대 주차"로 저장된다.
--   지난주에 week_offset=0으로 만든 미사용 기록과 이번 주에 week_offset=0으로
--   만드는 기록은 서로 다른 주인데도 (day, hour, week_offset)가 같아서
--   기존 유니크 제약에 걸려 "이미 동일한 데이터가 존재합니다" 오류가 났다.
--
-- 수정: PK를 제외한 기존 유니크 제약/인덱스를 모두 제거하고,
--   실제 대상 주(created_at이 속한 주의 월요일 + week_offset주, KST 기준)로
--   중복을 판정하는 유니크 인덱스를 새로 만든다.
--   (주차별 예외 테이블에서 실제 대상 주를 포함하지 않는 유니크 키는
--    모두 같은 문제를 일으키므로 컬럼 구성과 관계없이 교체한다)
--
-- Supabase Dashboard > SQL Editor 에서 전체 실행. 여러 번 실행해도 안전하다.

begin;

-- 1. 기존 유니크 제약 제거 (PK 제외)
do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.slot_exceptions'::regclass
      and contype = 'u'
  loop
    execute format('alter table public.slot_exceptions drop constraint %I', r.conname);
  end loop;
end $$;

-- 2. 제약 없이 만들어진 유니크 인덱스도 제거 (PK, 아래에서 만드는 인덱스 제외)
do $$
declare
  r record;
begin
  for r in
    select i.indexrelid::regclass as idxname
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'public.slot_exceptions'::regclass
      and i.indisunique
      and not i.indisprimary
      and c.relname <> 'slot_exceptions_day_hour_target_week_uidx'
  loop
    execute format('drop index %s', r.idxname);
  end loop;
end $$;

-- 3. 같은 대상 주·같은 칸에 중복된 행이 있으면 가장 먼저 만든 것만 남김
--    (시간표는 칸당 예외 하나만 표시하므로 나머지는 화면에 영향이 없다)
delete from public.slot_exceptions a
using public.slot_exceptions b
where a.day = b.day
  and a.hour = b.hour
  and a.id > b.id
  and (date_trunc('week', a.created_at at time zone 'Asia/Seoul'))::date + a.week_offset * 7
    = (date_trunc('week', b.created_at at time zone 'Asia/Seoul'))::date + b.week_offset * 7;

-- 4. 실제 대상 주 기준 유니크 인덱스
create unique index if not exists slot_exceptions_day_hour_target_week_uidx
  on public.slot_exceptions (
    day,
    hour,
    ((date_trunc('week', created_at at time zone 'Asia/Seoul'))::date + week_offset * 7)
  );

commit;
