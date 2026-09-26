// js/supabase.js
// ── Supabase 클라이언트 초기화 ──────────────────────────────────────
// .env 대신 config.js를 gitignore에 추가하거나, GitHub Pages 환경변수 없으므로
// 아래 두 값을 직접 입력하거나 config.js 파일로 분리합니다.
//
// Supabase Dashboard > Project Settings > API 에서 확인:
//   Project URL  → SUPABASE_URL
//   anon public  → SUPABASE_ANON_KEY

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ⚠️ 아래 두 값을 실제 값으로 교체하세요
const SUPABASE_URL      = 'https://pykefpswgcrledboybca.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5a2VmcHN3Z2NybGVkYm95YmNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5NzMxMzksImV4cCI6MjA5MTU0OTEzOX0.J1baEnHuYceleExIftNNDHk0xuEfQD0KlwvRKSHKSFg';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
