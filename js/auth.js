// js/auth.js
// ── 관리자 인증 ──────────────────────────────────────────────────────
// Supabase Auth를 쓰지 않고, app_config 테이블의 admin_password와 비교.
// 세션은 sessionStorage에 저장 (탭 닫으면 로그아웃).

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
