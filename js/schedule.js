// js/schedule.js
import { supabase } from './supabase.js';

// ─── CONFIG ──────────────────────────────────────────────────────────
export async function getConfig(key) {
  const { data, error } = await supabase.from('app_config').select('value').eq('key', key).single();
  if (error) throw error;
  return data.value;
}
export async function setConfig(key, value) {
  const { error } = await supabase.from('app_config').upsert({ key, value });
  if (error) throw error;
}

// ─── TEAMS ───────────────────────────────────────────────────────────
export async function fetchTeams() {
  const { data, error } = await supabase.from('teams').select('*').order('name');
  if (error) throw error;
  return data;
}
export async function createTeam({ name, type, color, info = '' }) {
  const { data, error } = await supabase.from('teams').insert({ name, type, color, info }).select().single();
  if (error) throw error;
  return data;
}
export async function updateTeam(id, fields) {
  const { data, error } = await supabase.from('teams').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
export async function deleteTeam(id) {
  const { error } = await supabase.from('teams').delete().eq('id', id);
  if (error) throw error;
}

// ─── BASE SLOTS ──────────────────────────────────────────────────────
export async function fetchBaseSlots(season) {
  const { data, error } = await supabase.from('base_slots').select('*, teams(*)').eq('season', season).order('day').order('hour');
  if (error) throw error;
  return data;
}
export async function createBaseSlot({ team_id, day, hour, season }) {
  const { data, error } = await supabase.from('base_slots').insert({ team_id, day, hour, season }).select('*, teams(*)').single();
  if (error) throw error;
  return data;
}
export async function updateBaseSlot(id, fields) {
  const { data, error } = await supabase.from('base_slots').update(fields).eq('id', id).select('*, teams(*)').single();
  if (error) throw error;
  return data;
}
export async function deleteBaseSlot(id) {
  const { error } = await supabase.from('base_slots').delete().eq('id', id);
  if (error) throw error;
}

// ─── EXCEPTIONS ──────────────────────────────────────────────────────
export async function fetchExceptions(weekOffset) {
  const { data, error } = await supabase.from('slot_exceptions').select('*, teams(*)').eq('week_offset', weekOffset).order('day').order('hour');
  if (error) throw error;
  return data;
}
export async function createException({ team_id, day, hour, week_offset, exception_type = 'absent' }) {
  const { data, error } = await supabase.from('slot_exceptions')
    .insert({ team_id, day, hour, week_offset, exception_type, slot_type: exception_type, status: exception_type === 'absent' ? 'absent' : 'normal' })
    .select('*, teams(*)').single();
  if (error) throw error;
  return data;
}
export async function deleteException(id) {
  const { error } = await supabase.from('slot_exceptions').delete().eq('id', id);
  if (error) throw error;
}

// ─── MERGE ───────────────────────────────────────────────────────────
// base_slots + exceptions 합산 → 최종 시간표
export function mergeSchedule(baseSlots, exceptions) {
  const result = [];
  const baseMap = new Map(baseSlots.map(b => [`${b.day}-${b.hour}`, b]));
  const exMap   = new Map(exceptions.map(e => [`${e.day}-${e.hour}`, e]));

  for (const [key, base] of baseMap) {
    const ex = exMap.get(key);
    if (!ex) {
      result.push({ ...base, status: 'normal', source: 'base', exceptionId: null });
    } else if (ex.exception_type === 'absent') {
      result.push({ ...base, status: 'absent', source: 'base', exceptionId: ex.id });
    } else if (ex.exception_type === 'override') {
      result.push({ ...ex, status: 'normal', source: 'override', exceptionId: ex.id });
    }
  }
  for (const [key, ex] of exMap) {
    if (!baseMap.has(key) && ex.exception_type === 'extra') {
      result.push({ ...ex, status: 'normal', source: 'extra', exceptionId: ex.id });
    }
  }
  return result;
}

// ─── REQUESTS ────────────────────────────────────────────────────────
export async function fetchRequests(weekOffset) {
  const { data, error } = await supabase.from('requests').select('*, teams(*)').eq('week_offset', weekOffset).order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}
export async function createRequest({ type, team_id, day, hour, week_offset, reason, requester_name }) {
  const { data, error } = await supabase.from('requests').insert({ type, team_id, day, hour, week_offset, reason, requester_name, status: 'pending' }).select('*, teams(*)').single();
  if (error) throw error;
  return data;
}
export async function approveRequest(request, weekOffset) {
  await supabase.from('requests').update({ status: 'approved', reviewed_at: new Date().toISOString() }).eq('id', request.id);
  const ex_type = request.type === 'absent' ? 'absent' : 'extra';
  const existing = await supabase.from('slot_exceptions').select('id').eq('day', request.day).eq('hour', request.hour).eq('week_offset', weekOffset).maybeSingle();
  if (!existing.data) {
    await createException({ team_id: request.team_id, day: request.day, hour: request.hour, week_offset: weekOffset, exception_type: ex_type });
  }
}
export async function rejectRequest(id) {
  const { error } = await supabase.from('requests').update({ status: 'rejected', reviewed_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// ─── REALTIME ────────────────────────────────────────────────────────
export function subscribeChanges(onBase, onException, onRequest, onRound, onApplication) {
  const c1 = supabase.channel('base-ch').on('postgres_changes', { event: '*', schema: 'public', table: 'base_slots' }, onBase).subscribe();
  const c2 = supabase.channel('ex-ch').on('postgres_changes', { event: '*', schema: 'public', table: 'slot_exceptions' }, onException).subscribe();
  const c3 = supabase.channel('req-ch').on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, onRequest).subscribe();
  const c4 = supabase.channel('round-ch').on('postgres_changes', { event: '*', schema: 'public', table: 'application_rounds' }, onRound).subscribe();
  const c5 = supabase.channel('app-ch').on('postgres_changes', { event: '*', schema: 'public', table: 'time_applications' }, onApplication).subscribe();
  return () => { supabase.removeChannel(c1); supabase.removeChannel(c2); supabase.removeChannel(c3); supabase.removeChannel(c4); supabase.removeChannel(c5); };
}

// ─── NOTICES ─────────────────────────────────────────────────────────
export async function fetchNotices() {
  const { data, error } = await supabase
    .from('notices').select('*').order('created_at', { ascending: false }).limit(5);
  if (error) throw error;
  return data;
}
export async function createNotice(content) {
  const { data, error } = await supabase
    .from('notices').insert({ content }).select().single();
  if (error) throw error;
  return data;
}
export async function deleteNotice(id) {
  const { error } = await supabase.from('notices').delete().eq('id', id);
  if (error) throw error;
}

// ─── APPLICATION ROUNDS ──────────────────────────────────────────────
export async function fetchActiveRound(season) {
  const { data } = await supabase
    .from('application_rounds')
    .select('*')
    .eq('season', season)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function fetchRound(id) {
  const { data, error } = await supabase
    .from('application_rounds').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function createRound({ season, open_at = null, close_at = null }) {
  const { data, error } = await supabase
    .from('application_rounds')
    .insert({ season, status: open_at ? 'closed' : 'open', open_at, close_at })
    .select().single();
  if (error) throw error;
  return data;
}

export async function updateRound(id, fields) {
  const { data, error } = await supabase
    .from('application_rounds').update(fields).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// ─── TIME APPLICATIONS ───────────────────────────────────────────────
export async function fetchApplications(roundId) {
  const { data, error } = await supabase
    .from('time_applications')
    .select('*, teams(*)')
    .eq('round_id', roundId)
    .order('submitted_at');
  if (error) throw error;
  return data;
}

export async function submitApplication({ round_id, team_id, pref1_day, pref1_hour, pref2_day = null, pref2_hour = null, pref3_day = null, pref3_hour = null }) {
  const { data, error } = await supabase
    .from('time_applications')
    .upsert({ round_id, team_id, pref1_day, pref1_hour, pref2_day, pref2_hour, pref3_day, pref3_hour, assigned_day: null, assigned_hour: null, assigned_pref: null, submitted_at: new Date().toISOString() },
      { onConflict: 'round_id,team_id' })
    .select('*, teams(*)').single();
  if (error) throw error;
  return data;
}

export async function deleteApplication(id) {
  const { error } = await supabase.from('time_applications').delete().eq('id', id);
  if (error) throw error;
}

// ─── ASSIGNMENT LOGIC ────────────────────────────────────────────────
// 신청 마감 후 관리자가 호출 — base_slots 초안 생성
export async function runAssignment(round, applications, season) {
  // 1. 배정 초기화
  const assigned = new Map(); // "day-hour" → team_id
  const results  = [];       // { id, assigned_day, assigned_hour, assigned_pref }

  // 신청 시각 순으로 정렬 (선착순)
  const sorted = [...applications].sort((a, b) =>
    new Date(a.submitted_at) - new Date(b.submitted_at)
  );

  // 2. 지망 순서대로 배정
  for (const pref of [1, 2, 3]) {
    for (const app of sorted) {
      if (results.find(r => r.id === app.id)) continue; // 이미 배정됨
      const day  = app[`pref${pref}_day`];
      const hour = app[`pref${pref}_hour`];
      if (day == null || hour == null) continue;
      const key = `${day}-${hour}`;
      if (!assigned.has(key)) {
        assigned.set(key, app.team_id);
        results.push({ id: app.id, assigned_day: day, assigned_hour: hour, assigned_pref: pref });
      }
    }
  }

  // 미배정 처리
  for (const app of sorted) {
    if (!results.find(r => r.id === app.id)) {
      results.push({ id: app.id, assigned_day: null, assigned_hour: null, assigned_pref: null });
    }
  }

  // 3. time_applications에 배정 결과 저장
  for (const r of results) {
    await supabase.from('time_applications').update({
      assigned_day: r.assigned_day,
      assigned_hour: r.assigned_hour,
      assigned_pref: r.assigned_pref,
    }).eq('id', r.id);
  }

  // 4. round status → finished
  await supabase.from('application_rounds')
    .update({ status: 'finished' }).eq('id', round.id);

  return results;
}

// 5. 관리자가 초안 확정 → base_slots에 반영
export async function approveDraft(round, applications, season) {
  // 기존 해당 시즌 base_slots 삭제 후 재생성
  await supabase.from('base_slots').delete().eq('season', season);

  const toInsert = applications
    .filter(a => a.assigned_day != null)
    .map(a => ({
      team_id: a.team_id,
      day: a.assigned_day,
      hour: a.assigned_hour,
      season,
    }));

  if (toInsert.length) {
    const { error } = await supabase.from('base_slots').insert(toInsert);
    if (error) throw error;
  }

  await supabase.from('application_rounds')
    .update({ draft_approved: true }).eq('id', round.id);
}
