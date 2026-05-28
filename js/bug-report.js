import { supabase } from './supabase.js';

const BOT_GREETING = '이 웹사이트는 현재 개발 중으로, 아직 테스트 단계에 있어 버그가 발생할 수 있습니다. 버그를 발견하신다면 제게 신고해주세요. 신고 내용은 익명으로 전달됩니다.';
const BOT_THANKS   = '신고해주셔서 감사합니다. 빠른 시일 내에 확인하겠습니다.';
const BOT_ERR      = '전송에 실패했습니다. 잠시 후 다시 시도해주세요.';
const PAGE         = location.pathname.split('/').pop() || 'index.html';

// ── DOM 생성 ──────────────────────────────────────────────────────────
// Use existing fab if injected in HTML (admin.html), else create floating one
let fab = document.getElementById('br-fab');
if (!fab) {
  fab = document.createElement('button');
  fab.id = 'br-fab';
  fab.className = 'br-fab-float';
  fab.setAttribute('aria-label', '버그 신고');
  document.body.appendChild(fab);
}
fab.innerHTML = '🐛';

const win = document.createElement('div');
win.id = 'br-window';
win.style.display = 'none';
win.innerHTML = `
  <div id="br-hdr">
    <span>🐛 버그 신고</span>
    <button id="br-hdr-close" aria-label="닫기">×</button>
  </div>
  <div id="br-msgs"></div>
  <div id="br-foot">
    <textarea id="br-input" placeholder="버그 내용을 입력해주세요..." rows="1"></textarea>
    <button id="br-send">전송</button>
  </div>
`;

document.body.appendChild(fab);
document.body.appendChild(win);

const msgsEl = win.querySelector('#br-msgs');
const inputEl = win.querySelector('#br-input');
const sendBtn = win.querySelector('#br-send');

// ── 헬퍼 ─────────────────────────────────────────────────────────────
function addBubble(text, cls) {
  const b = document.createElement('div');
  b.className = cls;
  b.textContent = text;
  msgsEl.appendChild(b);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

// ── 토글 ─────────────────────────────────────────────────────────────
let opened = false;

fab.addEventListener('click', () => {
  const isOpen = win.style.display !== 'none';
  win.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) {
    if (!opened) {
      opened = true;
      addBubble(BOT_GREETING, 'br-bot');
    }
    setTimeout(() => inputEl.focus(), 50);
  }
});

win.querySelector('#br-hdr-close').addEventListener('click', () => {
  win.style.display = 'none';
});

// ── 전송 ─────────────────────────────────────────────────────────────
async function send() {
  const text = inputEl.value.trim();
  if (!text || sendBtn.disabled) return;
  inputEl.value = '';
  sendBtn.disabled = true;
  addBubble(text, 'br-user');

  const { error } = await supabase.from('bug_reports').insert({ message: text, page: PAGE });
  addBubble(error ? BOT_ERR : BOT_THANKS, 'br-bot');
  sendBtn.disabled = false;
  inputEl.focus();
}

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener('click', send);

// ── 모바일 키보드 대응 (iOS Safari: 키보드가 올라와도 뷰포트 높이 불변) ──
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (win.style.display === 'none') return;
    const kbH = Math.max(0, window.innerHeight - window.visualViewport.height);
    win.style.bottom = kbH > 50 ? (kbH + 8) + 'px' : '';
  });
}
