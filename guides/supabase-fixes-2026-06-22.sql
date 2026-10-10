-- Fixes applied on 2026-06-22.
-- 1. Keep discarded time-assignment rounds visible to the app as "no active round".
-- 2. Move school application replacement and capacity assignment into one DB transaction.

alter table public.application_rounds drop constraint if exists application_rounds_status_check;

alter table public.application_rounds
  add constraint application_rounds_status_check
  check (status = any (array[
    'closed'::text,
    'open'::text,
    'finished'::text,
    'discarded'::text
  ]));

create unique index if not exists school_applications_round_student_uidx
  on public.school_applications(round_id, student_id)
  where round_id is not null;

create or replace function public.submit_school_application(
  p_round_id bigint,
  p_applicant_name text,
  p_student_id text,
  p_pref1_school_id bigint,
  p_pref2_school_id bigint default null
)
returns public.school_applications
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_round public.school_rounds%rowtype;
  v_pref1 public.schools%rowtype;
  v_pref2 public.schools%rowtype;
  v_prev_round_id public.school_rounds.id%type;
  v_is_returning boolean := false;
  v_assigned_school_id bigint := null;
  v_status text := 'unassigned';
  v_count integer := 0;
  v_app public.school_applications%rowtype;
begin
  if nullif(trim(p_applicant_name), '') is null then
    raise exception '성명을 입력해주세요';
  end if;

  if nullif(trim(p_student_id), '') is null or char_length(trim(p_student_id)) < 4 then
    raise exception '학번을 올바르게 입력해주세요';
  end if;

  if p_pref1_school_id is null then
    raise exception '1지망을 선택해주세요';
  end if;

  if p_pref2_school_id is not null and p_pref2_school_id = p_pref1_school_id then
    raise exception '1지망과 2지망이 같습니다';
  end if;

  select * into v_round
  from public.school_rounds
  where id = p_round_id
  for update;

  if not found then
    raise exception '스쿨 신청 회차를 찾을 수 없습니다';
  end if;

  if v_round.status <> 'open' then
    raise exception '신청 기간이 아닙니다';
  end if;

  if v_round.close_at is not null and v_round.close_at <= now() then
    raise exception '신청 기간이 마감됐습니다';
  end if;

  select * into v_pref1
  from public.schools
  where id = p_pref1_school_id and round_id = p_round_id;

  if not found then
    raise exception '1지망 반을 찾을 수 없습니다';
  end if;

  if p_pref2_school_id is not null then
    select * into v_pref2
    from public.schools
    where id = p_pref2_school_id and round_id = p_round_id;

    if not found then
      raise exception '2지망 반을 찾을 수 없습니다';
    end if;
  end if;

  delete from public.school_applications
  where round_id = p_round_id and student_id = trim(p_student_id);

  if v_round.prioritize_returning then
    select id into v_prev_round_id
    from public.school_rounds
    where status = 'closed' and id <> p_round_id
    order by created_at desc
    limit 1;

    if v_prev_round_id is not null then
      select exists(
        select 1
        from public.school_applications
        where round_id = v_prev_round_id
          and student_id = trim(p_student_id)
          and status = 'assigned'
      ) into v_is_returning;
    end if;
  end if;

  if v_is_returning then
    v_status := 'pending';
  else
    select count(*) into v_count
    from public.school_applications
    where assigned_school_id = p_pref1_school_id
      and status = 'assigned';

    if v_count < coalesce(v_pref1.capacity, 0) then
      v_assigned_school_id := p_pref1_school_id;
    elsif p_pref2_school_id is not null then
      select count(*) into v_count
      from public.school_applications
      where assigned_school_id = p_pref2_school_id
        and status = 'assigned';

      if v_count < coalesce(v_pref2.capacity, 0) then
        v_assigned_school_id := p_pref2_school_id;
      end if;
    end if;

    v_status := case
      when v_assigned_school_id is null then 'unassigned'
      else 'assigned'
    end;
  end if;

  insert into public.school_applications(
    round_id,
    applicant_name,
    student_id,
    pref1_school_id,
    pref2_school_id,
    assigned_school_id,
    is_returning,
    status
  ) values (
    p_round_id,
    trim(p_applicant_name),
    trim(p_student_id),
    p_pref1_school_id,
    p_pref2_school_id,
    v_assigned_school_id,
    v_is_returning,
    v_status
  ) returning * into v_app;

  return v_app;
end;
$$;

revoke all on function public.submit_school_application(bigint,text,text,bigint,bigint) from public;
grant execute on function public.submit_school_application(bigint,text,text,bigint,bigint) to anon, authenticated;

-- Public application guards. These run below the frontend so stale tabs,
-- double-clicks, concurrent requests, and direct REST inserts follow the same
-- final rules.

create or replace function public.guard_time_application_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_round public.application_rounds%rowtype;
begin
  select * into v_round
  from public.application_rounds
  where id = new.round_id
  for update;

  if not found then
    raise exception '시간 신청 회차를 찾을 수 없습니다';
  end if;
  if v_round.status <> 'open' then
    raise exception '현재 신청 기간이 아닙니다';
  end if;
  if v_round.open_at is not null and v_round.open_at > now() then
    raise exception '현재 신청 기간이 아닙니다';
  end if;
  if v_round.close_at is not null and v_round.close_at <= now() then
    raise exception '신청 기간이 마감됐습니다';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_time_application_insert on public.time_applications;
create trigger trg_guard_time_application_insert
before insert on public.time_applications
for each row execute function public.guard_time_application_insert();

create or replace function public.guard_song_application_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_round public.ensemble_rounds%rowtype;
  v_active_count integer;
  v_person_count integer;
begin
  if coalesce(new.is_fixed, false) and current_user <> 'authenticated' then
    raise exception '완성 팀 추가 권한이 없습니다';
  end if;

  if coalesce(new.status, '') = 'rejected' or coalesce(new.is_fixed, false) then
    return new;
  end if;

  select * into v_round
  from public.ensemble_rounds
  where id = new.round_id
  for update;

  if not found then
    raise exception '합주 신청 회차를 찾을 수 없습니다';
  end if;
  if v_round.phase <> 'song' then
    raise exception '현재 곡 신청 기간이 아닙니다';
  end if;
  if v_round.song_scheduled_at is not null and v_round.song_scheduled_at > now() then
    raise exception '현재 곡 신청 기간이 아닙니다';
  end if;
  if v_round.song_close_at is not null and v_round.song_close_at <= now() then
    raise exception '곡 신청이 마감됐습니다';
  end if;

  select count(*) into v_active_count
  from public.song_applications
  where round_id = new.round_id
    and coalesce(status, '') <> 'rejected'
    and coalesce(is_fixed, false) = false;

  if v_active_count >= coalesce(v_round.max_songs, 0) then
    raise exception '신청 가능한 곡 수가 초과됐습니다';
  end if;

  select count(*) into v_person_count
  from public.song_applications
  where round_id = new.round_id
    and student_id = new.student_id
    and coalesce(status, '') <> 'rejected'
    and coalesce(is_fixed, false) = false;

  if v_person_count >= coalesce(v_round.max_songs_per_person, 0) then
    raise exception '인당 신청 가능한 곡 수가 초과됐습니다';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_song_application_insert on public.song_applications;
create trigger trg_guard_song_application_insert
before insert on public.song_applications
for each row execute function public.guard_song_application_insert();

create or replace function public.guard_session_application_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_round public.ensemble_rounds%rowtype;
  v_song public.song_applications%rowtype;
  v_existing_count integer;
  v_person_song_count integer;
  v_applicant_sessions text[] := '{}';
  v_conflict_count integer;
begin
  if (coalesce(new.is_manual, false) or coalesce(new.status, '') = 'confirmed') and current_user <> 'authenticated' then
    raise exception '관리자 신청 추가 권한이 없습니다';
  end if;

  if coalesce(new.is_manual, false) or coalesce(new.status, '') = 'confirmed' then
    return new;
  end if;

  select * into v_round
  from public.ensemble_rounds
  where id = new.round_id
  for update;

  if not found then
    raise exception '합주 신청 회차를 찾을 수 없습니다';
  end if;

  select * into v_song
  from public.song_applications
  where id = new.song_id
    and round_id = new.round_id
    and coalesce(status, '') <> 'rejected';

  if not found then
    raise exception '신청할 곡을 찾을 수 없습니다';
  end if;

  select count(*) into v_existing_count
  from public.session_applications
  where round_id = new.round_id
    and song_id = new.song_id
    and student_id = new.student_id
    and coalesce(session_round, 1) = coalesce(new.session_round, 1)
    and coalesce(status, '') <> 'rejected'
    and coalesce(is_manual, false) = false;

  if v_existing_count > 0 then
    raise exception '이미 이 곡에 세션을 신청했습니다';
  end if;

  if v_round.phase = 'song' and coalesce(new.session_round, 1) = 1 and new.student_id = v_song.student_id then
    if v_round.song_scheduled_at is not null and v_round.song_scheduled_at > now() then
      raise exception '현재 곡 신청 기간이 아닙니다';
    end if;
    if v_round.song_close_at is not null and v_round.song_close_at <= now() then
      raise exception '곡 신청이 마감됐습니다';
    end if;
    return new;
  end if;

  if coalesce(new.session_round, 1) = 2 then
    if v_round.phase <> 'session2' then
      raise exception '현재 2차 세션 신청 기간이 아닙니다';
    end if;
    if v_round.session2_scheduled_at is not null and v_round.session2_scheduled_at > now() then
      raise exception '현재 2차 세션 신청 기간이 아닙니다';
    end if;
    if v_round.session2_close_at is not null and v_round.session2_close_at <= now() then
      raise exception '2차 세션 신청이 마감됐습니다';
    end if;
  else
    if v_round.phase <> 'session' then
      raise exception '현재 세션 신청 기간이 아닙니다';
    end if;
    if v_round.session_scheduled_at is not null and v_round.session_scheduled_at > now() then
      raise exception '현재 세션 신청 기간이 아닙니다';
    end if;
    if v_round.session_close_at is not null and v_round.session_close_at <= now() then
      raise exception '세션 신청이 마감됐습니다';
    end if;
  end if;

  select count(distinct song_id) into v_person_song_count
  from public.session_applications
  where round_id = new.round_id
    and student_id = new.student_id
    and coalesce(session_round, 1) = coalesce(new.session_round, 1)
    and coalesce(status, '') <> 'rejected'
    and coalesce(is_manual, false) = false;

  if v_person_song_count >= coalesce(v_round.max_sessions_per_person, 0) then
    raise exception '인당 참여 가능한 곡 수가 초과됐습니다';
  end if;

  if v_song.student_id <> new.student_id then
    select coalesce(array_agg(distinct sess), '{}') into v_applicant_sessions
    from public.session_applications a
    cross join unnest(a.sessions) as sess
    where a.round_id = new.round_id
      and a.song_id = new.song_id
      and a.student_id = v_song.student_id
      and coalesce(a.status, '') <> 'rejected'
      and coalesce(a.is_manual, false) = false;

    select count(*) into v_conflict_count
    from unnest(new.sessions) as s
    where s = any(v_applicant_sessions);

    if v_conflict_count > 0 then
      raise exception '신청자가 담당한 세션에는 신청할 수 없습니다';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_session_application_insert on public.session_applications;
create trigger trg_guard_session_application_insert
before insert on public.session_applications
for each row execute function public.guard_session_application_insert();
