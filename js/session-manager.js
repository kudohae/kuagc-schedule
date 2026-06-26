import { supabase } from '../supabase.js';
import { escapeHtml as esc } from '../utils/html.js';

const SESSION_PHASES = new Set(['session', 'session2']);
const CLOSE_FIELD_BY_PHASE = {
  session: 'session_close_at',
  session2: 'session2_close_at',
};

let rootEl = null;
let observer = null;
let modalState = null;
let buttonPatchQueued = false;

export function init(container) {
  rootEl = container;
  patchSessionFormButtons();

  observer = new MutationObserver(queueButtonPatch);
  observer.observe(container, { childList: true, subtree: true });

  window.openMySessionManager = openMySessionManager;
  window.onMySessionEditSongChange = onMySessionEditSongChange;
  window.saveMySessionApplication = saveMySessionApplication;
  window.deleteMySessionApplication = deleteMySessionApplication;

  return () => {
    observer?.disconnect();
    observer = null;
    rootEl = null;
    modalState = null;
    delete window.openMySessionManager;
    delete window.onMySessionEditSongChange;
    delete window.saveMySessionApplication;
    delete window.deleteMySessionApplication;
  };
}

function queueButtonPatch() {
  if (buttonPatchQueued) return;
  buttonPatchQueued = true;
  requestAnimationFrame(() => {
    buttonPatchQueued = false;
    patchSessionFormButtons();
  });
}

function patchSessionFormButtons() {
  if (!rootEl) return;
  rootEl.querySelectorAll('.form-card .form-footer').forEach(footer => {
    const submitBtn = [...footer.querySelectorAll('button')].find(btn => btn.textContent.trim() === '세션 신청');
    if (!submitBtn || footer.querySelector('[data-my-session-manager]')) return;

    footer.style.alignItems = 'center';
    footer.style.flexWrap = 'wrap';
    footer.style.gap = '6px';

    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'btn btn-s';
    manageBtn.dataset.mySessionManager = '1';
    manageBtn.textContent = '내 신청 확인 및 수정';
    manageBtn.addEventListener('click', openMySessionManager);
    footer.appendChild(manageBtn);
  });
}

async function openMySessionManager() {
  const studentId = (prompt('내 신청을 확인할 학번을 입력해주세요') || '').trim();
  if (!studentId) return;

  try {
    const ctx = await loadSessionContext();
    if (!ctx.round || !SESSION_PHASES.has(ctx.round.phase)) {
      window.toast?.('현재 세션 신청 기간이 아닙니다', 'err');
      return;
    }

    const closeAt = ctx.round[CLOSE_FIELD_BY_PHASE[ctx.round.phase]];
    if (closeAt && new Date(closeAt) <= new Date()) {
      window.toast?.('세션 신청이 마감됐습니다', 'err');
      return;
    }

    const items = ctx.apps
      .filter(app =>
        app.id != null &&
        app.student_id === studentId &&
        app.round_id === ctx.round.id &&
        app.status !== 'rejected' &&
        !app.is_manual &&
        (app.session_round || 1) === ctx.sessionRound
      )
      .map(app => ({ app, song: ctx.songs.find(song => song.id === app.song_id) }))
      .filter(item => item.song);

    if (!items.length) {
      window.toast?.('해당 학번으로 신청한 세션이 없습니다', 'err');
      return;
    }

    modalState = { studentId, ctx, items };
    showMySessionModal();
  } catch (error) {
    window.toast?.(errMsg(error), 'err');
  }
}

async function loadSessionContext() {
  const type = getActiveType();
  const { data: roundRows, error: roundError } = await supabase
    .from('ensemble_rounds')
    .select('*')
    .order('created_at', { ascending: false });
  if (roundError) throw roundError;

  const round = (roundRows || []).find(row => row.type === type) || null;
  const sessionRound = round?.phase === 'session2' ? 2 : 1;

  if (!round) {
    return { type, round: null, sessionRound, songs: [], apps: [], sessionMap: {} };
  }

  const { data: songRows, error: songError } = await supabase
    .from('song_applications')
    .select('*')
    .eq('round_id', round.id)
    .order('created_at');
  if (songError) throw songError;

  const { data: appRows, error: appError } = await supabase
    .from('session_applications')
    .select('*')
    .eq('round_id', round.id)
    .order('created_at');
  if (appError) throw appError;

  const songs = (songRows || []).filter(song => song.status !== 'rejected');
  const apps = appRows || [];
  const sessionMap = {};
  apps.forEach(app => {
    if (!sessionMap[app.song_id]) sessionMap[app.song_id] = [];
    sessionMap[app.song_id].push(app);
  });

  return { type, round, sessionRound, songs, apps, sessionMap };
}

function getActiveType() {
  return document.getElementById('tb-busking')?.classList.contains('active') ? 'busking' : 'regular';
}

function showMySessionModal() {
  const options = modalState.items.map((item, index) =>
    `<option value="${index}">${esc(item.song.title)} — ${esc(item.song.artist)}</option>`
  ).join('');

  showModal(
    '내 신청 확인 및 수정',
    `<div>
       <div class="fl">신청한 곡 *</div>
       <select class="fs" id="mySessionSong" onchange="onMySessionEditSongChange()">
         <option value="">— 곡 선택 —</option>
         ${options}
       </select>
     </div>
     <div id="mySessionEditArea" style="margin-top:10px">
       <div class="no-song-selected">곡을 먼저 선택하세요.</div>
     </div>`,
    `<button class="btn btn-d" id="mySessionDeleteBtn" onclick="deleteMySessionApplication()" disabled>삭제</button>
     <button class="btn btn-p" id="mySessionSaveBtn" onclick="saveMySessionApplication()" disabled>저장</button>`
  );
}

function onMySessionEditSongChange() {
  const item = getSelectedItem();
  const area = document.getElementById('mySessionEditArea');
  const saveBtn = document.getElementById('mySessionSaveBtn');
  const deleteBtn = document.getElementById('mySessionDeleteBtn');
  if (!area) return;

  if (!item) {
    area.innerHTML = '<div class="no-song-selected">곡을 먼저 선택하세요.</div>';
    if (saveBtn) saveBtn.disabled = true;
    if (deleteBtn) deleteBtn.disabled = true;
    return;
  }

  const options = getEditableSessionOptions(item);
  const selected = new Set(item.app.sessions || []);
  if (saveBtn) saveBtn.disabled = !options.length;
  if (deleteBtn) deleteBtn.disabled = false;

  area.innerHTML = `
    <div class="session-area">
      <div class="fl">참여할 세션 * (이 곡에 필요한 세션만 표시)</div>
      ${options.length ? `<div class="session-grid">
        ${options.map((session, index) => {
          const id = `my_session_${index}_${session.replace(/\s/g, '_')}`;
          return `<input type="checkbox" class="session-chk" name="mySessionEditSession" id="${id}" value="${esc(session)}" ${selected.has(session) ? 'checked' : ''}/>
            <label class="session-label" for="${id}">${esc(session)}</label>`;
        }).join('')}
      </div>` : '<div class="no-song-selected">수정 가능한 세션이 없습니다.</div>'}
    </div>`;
}

function getSelectedItem() {
  const select = document.getElementById('mySessionSong');
  if (!select || !modalState) return null;
  if (select.value === '') return null;
  const index = Number(select.value);
  return Number.isInteger(index) ? modalState.items[index] || null : null;
}

function getEditableSessionOptions(item) {
  const { ctx } = modalState;
  const needed = Array.isArray(item.song.sessions) ? item.song.sessions : [];
  const appsForSong = ctx.sessionMap[item.song.id] || [];
  let options = needed;

  if (ctx.round.phase === 'session2' && ctx.round.session2_mode === 'missing_only') {
    const filled = new Set(
      appsForSong
        .filter(app => app.status === 'confirmed')
        .flatMap(app => app.sessions || [])
    );
    options = options.filter(session => !filled.has(session));
  }

  if (item.app.student_id !== item.song.student_id) {
    const applicantApp = appsForSong.find(app =>
      app.student_id === item.song.student_id &&
      app.status !== 'rejected'
    );
    const applicantSessions = new Set(applicantApp?.sessions || []);
    options = options.filter(session => !applicantSessions.has(session));
  }

  return [...new Set(options)];
}

async function saveMySessionApplication() {
  const item = getSelectedItem();
  if (!item || !modalState) {
    window.toast?.('수정할 곡을 선택해주세요', 'err');
    return;
  }

  const sessions = [...document.querySelectorAll('input[name="mySessionEditSession"]:checked')]
    .map(input => input.value);
  if (!sessions.length) {
    window.toast?.('세션을 하나 이상 선택해주세요', 'err');
    return;
  }

  const allowed = new Set(getEditableSessionOptions(item));
  const invalid = sessions.filter(session => !allowed.has(session));
  if (invalid.length) {
    window.toast?.('선택할 수 없는 세션이 포함되어 있습니다', 'err');
    onMySessionEditSongChange();
    return;
  }

  const btn = document.getElementById('mySessionSaveBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '저장 중...';
  }

  try {
    const updateQuery = supabase.from('session_applications').update({ sessions });
    const { data, error } = await filterApplicationMutation(updateQuery, item)
      .select('song_id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('신청 정보를 찾지 못했습니다');

    item.app.sessions = sessions;
    window.closeModal?.();
    window.toast?.('신청 내용이 저장됐습니다', 'ok');
    await broadcastRefresh();
  } catch (error) {
    window.toast?.(errMsg(error), 'err');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '저장';
    }
  }
}

async function deleteMySessionApplication() {
  const item = getSelectedItem();
  if (!item || !modalState) {
    window.toast?.('삭제할 곡을 선택해주세요', 'err');
    return;
  }

  const confirmId = (prompt('삭제하려면 학번을 다시 입력해주세요') || '').trim();
  if (!confirmId) return;
  if (confirmId !== modalState.studentId) {
    window.toast?.('학번이 일치하지 않습니다', 'err');
    return;
  }

  const btn = document.getElementById('mySessionDeleteBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '삭제 중...';
  }

  try {
    const deleteQuery = supabase.from('session_applications').delete();
    const { data, error } = await filterApplicationMutation(deleteQuery, item)
      .select('song_id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('신청 정보를 찾지 못했습니다');

    modalState.items = modalState.items.filter(next => next.app.id !== item.app.id);
    window.closeModal?.();
    window.toast?.('신청이 삭제됐습니다', 'ok');
    await broadcastRefresh();
  } catch (error) {
    window.toast?.(errMsg(error), 'err');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '삭제';
    }
  }
}

function filterApplicationMutation(query, item) {
  query = query
    .eq('student_id', modalState.studentId)
    .eq('round_id', modalState.ctx.round.id);

  if (item.app.id != null) return query.eq('id', item.app.id);

  query = query
    .eq('song_id', item.song.id)
    .neq('status', 'rejected')
    .eq('is_manual', false);

  if (modalState.ctx.sessionRound === 2) query = query.eq('session_round', 2);
  return query;
}

function showModal(title, body, foot) {
  const titleEl = document.getElementById('modalTtl');
  const bodyEl = document.getElementById('modalBody');
  const footEl = document.getElementById('modalFoot');
  const modalBd = document.getElementById('modalBd');
  if (!titleEl || !bodyEl || !footEl || !modalBd) return;

  titleEl.textContent = title;
  bodyEl.innerHTML = body;
  footEl.innerHTML = foot;

  const modal = document.querySelector('#modalBd .modal');
  if (modal) {
    modal.style.transform = '';
    modal.style.transition = '';
  }
  modalBd.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

async function broadcastRefresh() {
  try {
    const channel = supabase.channel('ens-pub-session-manager-' + Date.now());
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 700);
      channel.subscribe(status => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await channel.send({ type: 'broadcast', event: 'update', payload: { scope: 'applications' } });
    setTimeout(() => supabase.removeChannel(channel), 300);
  } catch (error) {
    console.warn('session manager broadcast failed', error);
  }
}

function errMsg(error) {
  const message = error?.message || '';
  if (message.includes('network') || message.includes('fetch')) return '네트워크 오류가 발생했습니다. 다시 시도해주세요';
  if (message.includes('JWT') || message.includes('auth')) return '인증 오류입니다. 새로고침 후 다시 시도해주세요';
  return message || '오류가 발생했습니다';
}
