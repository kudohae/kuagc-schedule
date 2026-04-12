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
export function subscribeChanges(onBase, onException, onRequest) {
  const c1 = supabase.channel('base-ch').on('postgres_changes', { event: '*', schema: 'public', table: 'base_slots' }, onBase).subscribe();
  const c2 = supabase.channel('ex-ch').on('postgres_changes', { event: '*', schema: 'public', table: 'slot_exceptions' }, onException).subscribe();
  const c3 = supabase.channel('req-ch').on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, onRequest).subscribe();
  return () => { supabase.removeChannel(c1); supabase.removeChannel(c2); supabase.removeChannel(c3); };
}
