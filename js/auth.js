// js/auth.js
// ── 레거시 관리자 인증 (현재 미사용) ─────────────────────────────────
// admin.html은 Supabase Auth(이메일 로그인)로 전환됐으므로 이 파일은
// 더 이상 임포트되지 않습니다. 삭제 전 참조용으로 보존합니다.

import { supabase } from './supabase.js';

const SESSION_KEY = 'band_admin';

export function isAdmin() {
  return sessionStorage.getItem(SESSION_KEY) === 'true';
}

export async function loginAdmin(password) {
  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'admin_password')
    .single();

  if (error || !data) throw new Error('설정을 불러올 수 없습니다');
  if (data.value !== password) throw new Error('비밀번호가 틀렸습니다');

  sessionStorage.setItem(SESSION_KEY, 'true');
}

export function logoutAdmin() {
  sessionStorage.removeItem(SESSION_KEY);
}
