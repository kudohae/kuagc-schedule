// js/schedule.js
// ── 시간표 데이터 레이어 (Supabase CRUD) ─────────────────────────────

import { supabase } from './supabase.js';

// ─── TEAMS ───────────────────────────────────────────────────────────

export async function fetchTeams() {
  const { data, error } = await supabase
    .from('teams')
    .select('*')
    .order('id');
  if (error) throw error;
  return data;
}

export async function createTeam({ name, type, color }) {
  const { data, error } = await supabase
    .from('teams')
    .insert({ name, type, color })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateTeam(id, fields) {
  const { data, error } = await supabase
    .from('teams')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteTeam(id) {
  const { error } = await supabase.from('teams').delete().eq('id', id);
  if (error) throw error;
}

// ─── SLOTS ───────────────────────────────────────────────────────────

export async function fetchSlots(weekOffset = 0) {
  const { data, error } = await supabase
    .from('slots')
    .select('*, teams(*)')
    .eq('week_offset', weekOffset)
    .order('day')
    .order('hour');
  if (error) throw error;
  return data;
}

export async function createSlot({ team_id, day, hour, slot_type = 'regular', week_offset = 0 }) {
  const { data, error } = await supabase
    .from('slots')
    .insert({ team_id, day, hour, slot_type, week_offset, status: 'normal' })
    .select('*, teams(*)')
    .single();
  if (error) throw error;
  return data;
}

export async function updateSlot(id, fields) {
  const { data, error } = await supabase
    .from('slots')
    .update(fields)
    .eq('id', id)
    .select('*, teams(*)')
    .single();
  if (error) throw error;
  return data;
}

export async function deleteSlot(id) {
  const { error } = await supabase.from('slots').delete().eq('id', id);
  if (error) throw error;
}

// ─── REQUESTS ────────────────────────────────────────────────────────

export async function fetchRequests(weekOffset = 0) {
  const { data, error } = await supabase
    .from('requests')
    .select('*, teams(*)')
    .eq('week_offset', weekOffset)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function createRequest({ type, team_id, slot_id = null, day, hour, week_offset = 0, reason, requester_name }) {
  const { data, error } = await supabase
    .from('requests')
    .insert({ type, team_id, slot_id, day, hour, week_offset, reason, requester_name, status: 'pending' })
    .select('*, teams(*)')
    .single();
  if (error) throw error;
  return data;
}

export async function approveRequest(request) {
  // 1. 신청 상태 → approved
  const { error: reqErr } = await supabase
    .from('requests')
    .update({ status: 'approved', reviewed_at: new Date().toISOString() })
    .eq('id', request.id);
  if (reqErr) throw reqErr;

  // 2. 슬롯에 반영
  if (request.type === 'absent' && request.slot_id) {
    const { error: slotErr } = await supabase
      .from('slots')
      .update({ status: 'absent' })
      .eq('id', request.slot_id);
    if (slotErr) throw slotErr;
  } else if (request.type === 'extra') {
    // 빈 시간이면 슬롯 생성
    const { data: existing } = await supabase
      .from('slots')
      .select('id')
      .eq('day', request.day)
      .eq('hour', request.hour)
      .eq('week_offset', request.week_offset)
      .maybeSingle();

    if (!existing) {
      await createSlot({
        team_id: request.team_id,
        day: request.day,
        hour: request.hour,
        slot_type: 'extra',
        week_offset: request.week_offset,
      });
    }
  }
}

export async function rejectRequest(id) {
  const { error } = await supabase
    .from('requests')
    .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// ─── REALTIME ────────────────────────────────────────────────────────
// 슬롯/신청 변경 시 콜백 호출 (실시간 반영)

export function subscribeChanges(onSlotChange, onRequestChange) {
  const slotChannel = supabase
    .channel('slots-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'slots' }, onSlotChange)
    .subscribe();

  const reqChannel = supabase
    .channel('requests-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, onRequestChange)
    .subscribe();

  // 구독 해제 함수 반환
  return () => {
    supabase.removeChannel(slotChannel);
    supabase.removeChannel(reqChannel);
  };
}
