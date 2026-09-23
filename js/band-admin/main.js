import { supabase } from '../supabase.js';
import { escapeHtml as esc } from '../utils/html.js';

let host = null;
let user = null;
let rounds = [];
let round = null;
let songs = [];
let members = [];
let selectedSongId = null;
let destroyed = false;
let realtimeChannel = null;
let realtimeRefreshTimer = null;
let realtimeReconnectTimer = null;
let realtimeReplacing = false;
let realtimeStatus = 'idle';
let realtimeEventCount = 0;
let pendingRealtimeSignals = [];
let embedded = false;
const ADMIN_EMAIL = 'kuagcku@gmail.com';
const REALTIME_TOPIC = 'band-sync-v1';
const REALTIME_EVENT = 'band_changed';
const FIXED_ROLE_MARKER = '__BAND_FIXED__';
const APPLICANT_ROLE_PREFIX = '__BAND_APPLICANT_ROLE__:';

const parseRoles = value => String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean);
const rolesText = roles => (roles || []).join(', ');
const byCreated = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id));
const fixedMarkerPattern = /^_+BAND_FIXED_+$/i;
const applicantMarkerPattern = /^_+BAND_APPLICANT_ROLE_+:(.+)$/i;
const isMetadataRole = value => fixedMarkerPattern.test(String(value || '').trim()) || applicantMarkerPattern.test(String(value || '').trim());
const visibleWantedRoles = song => (song?.wanted_roles || []).filter(role => !isMetadataRole(role));
const isFixedSong = song => (song?.wanted_roles || []).some(role => fixedMarkerPattern.test(String(role || '').trim()));
const getApplicantRole = song => {
  const match = (song?.wanted_roles || []).map(role => String(role || '').trim().match(applicantMarkerPattern)).find(Boolean);
  return match?.[1] || '';
};

function normalizeRole(value) {
  const raw = String(value || '').trim();
  const compact = raw.replace(/\s+/g, '').toLowerCase();
  if (/^(보컬|vocal)\d*$/.test(compact)) return '보컬';
  if (/^(기타|guitar)\d*$/.test(compact)) return '기타';
  if (/^(베이스|bass)\d*$/.test(compact)) return '베이스';
  if (/^(키보드|건반|keyboard|key)\d*$/.test(compact)) return '키보드';
  if (/^(드럼|drum|drums)\d*$/.test(compact)) return '드럼';
  return raw;
}

function parseWantedRoles(value) {
  return parseRoles(value).flatMap(item => {
    const match = item.match(/^(.*?)(\d+)$/);
    if (!match || !match[1].trim()) return [item];
    const count = Math.max(1, Number(match[2]));
    return Array.from({ length: count }, () => match[1].trim());
  });
}

function wantedRolesText(roles) {
  const counts = new Map();
  for (const item of (roles || []).filter(role => !isMetadataRole(role))) {
    const role = normalizeRole(item);
    if (role) counts.set(role, (counts.get(role) || 0) + 1);
  }
  return [...counts].map(([role, count]) => `${role}${count > 1 ? count : ''}`).join(', ');
}

function songRoleOptions(song) {
  return [...new Set(visibleWantedRoles(song).map(normalizeRole).filter(Boolean))];
}

function songMembers(song) {
  const rows = members.filter(member => member.song_id === song.id);
  const applicantRole = getApplicantRole(song);
  const studentId = String(song.student_id || '').trim();
  if (applicantRole && !rows.some(member => String(member.student_id || '').trim() === studentId)) {
    rows.push({ id: `applicant-${song.id}`, song_id: song.id, applicant_name: song.applicant_name, student_id: song.student_id, roles: [applicantRole], created_at: song.created_at, is_included: true, is_song_applicant: true });
  }
  return rows.sort(byCreated);
}

function groupMembersByRole(rows) {
  const grouped = new Map();
  for (const member of rows) {
    const roles = [...new Set((member.roles || []).map(normalizeRole).filter(Boolean))];
    for (const role of (roles.length ? roles : ['그 외'])) {
      if (!grouped.has(role)) grouped.set(role, []);
      grouped.get(role).push(member);
    }
  }
  const roleIndex = role => ['보컬', '기타', '베이스', '키보드', '드럼', '그 외'].indexOf(role);
  return [...grouped].map(([role, members]) => ({ role, members: members.sort(byCreated) })).sort((a, b) => {
    const ai = roleIndex(a.role);
    const bi = roleIndex(b.role);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.role.localeCompare(b.role, 'ko');
  });
}

function formatMemberTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '<time>--.--.-- --:--:--</time>';
  const part = number => String(number).padStart(2, '0');
  const day = `${part(date.getFullYear() % 100)}.${part(date.getMonth() + 1)}.${part(date.getDate())}`;
  const time = `${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
  return `<time datetime="${esc(date.toISOString())}"><span>${day}</span><span>${time}</span></time>`;
}

function participantRows() {
  const grouped = new Map();
  for (const member of songs.flatMap(songMembers).filter(item => item.is_included !== false)) {
    const key = String(member.student_id || '').trim() || `name:${member.applicant_name}`;
    if (!grouped.has(key)) grouped.set(key, { key, name: member.applicant_name, studentId: member.student_id, roles: new Set(), songs: new Map() });
    const item = grouped.get(key);
    item.name = member.applicant_name || item.name;
    const normalizedRoles = (member.roles || []).map(normalizeRole).filter(Boolean);
    normalizedRoles.forEach(role => item.roles.add(role));
    if (!item.songs.has(member.song_id)) item.songs.set(member.song_id, new Set());
    normalizedRoles.forEach(role => item.songs.get(member.song_id).add(role));
  }
  return [...grouped.values()].sort((a, b) => b.songs.size - a.songs.size || a.name.localeCompare(b.name, 'ko') || String(a.studentId).localeCompare(String(b.studentId)));
}

function showMessage(message, type = '') {
  const el = host.querySelector('[data-admin-message]');
  if (!el) return;
  el.textContent = message;
  el.className = `band-admin-message is-visible${type ? ` is-${type}` : ''}`;
  window.setTimeout(() => el?.classList.remove('is-visible'), 3500);
}

const scheduleField = (kind, suffix) => suffix === 'mode' ? `${kind}_schedule_mode` : `${kind}_${suffix === 'opens_at' ? 'open_at' : 'close_at'}`;
const scheduleMode = (item, kind) => item?.[scheduleField(kind, 'mode')] || 'manual';
const padDatePart = value => String(value).padStart(2, '0');

function toDateTimeInput(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}T${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`;
}

function formatScheduleDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'yy.mm.dd hh:mm:ss';
  return `${padDatePart(date.getFullYear() % 100)}.${padDatePart(date.getMonth() + 1)}.${padDatePart(date.getDate())} ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`;
}

function renderRoundControls(item) {
  const control = (kind, label) => scheduleMode(item, kind) === 'auto'
    ? `<button class="band-round-scheduled" type="button" data-open-schedule aria-label="${label} 예약 설정 열기"><span aria-hidden="true">⏰</span><span>${label}</span></button>`
    : `<label><input name="${kind}_application_open" type="checkbox" ${item[`${kind}_application_open`] ? 'checked' : ''}><span>${label}</span></label>`;
  return `${control('song', '곡 신청')}${control('session', '세션 신청')}<button class="band-admin-schedule" type="button" data-manage-schedule>예약</button><button class="band-admin-blind${item.is_blinded ? ' is-active' : ''}" type="button" data-toggle-blind>${item.is_blinded ? '블라인드 해제' : '회차 블라인드'}</button>`;
}

function renderLogin(errorMessage = '') {
  host.innerHTML = `<main class="band-admin-app band-admin-login"><form data-login-form>
    <a href="#band" class="band-admin-mark"><img src="img/logo.png" alt=""><span>BAND BOARD</span></a>
    <h1>Band Admin</h1><p>관리자 계정으로 로그인하세요.</p>
    <label><span>이메일</span><input name="email" type="email" required autocomplete="username" value="kuagcku@gmail.com"></label>
    <label><span>비밀번호</span><input name="password" type="password" required autocomplete="current-password"></label>
    <div class="band-admin-form-error">${esc(errorMessage)}</div><button type="submit">로그인</button>
    <a href="#band">공개 페이지로 돌아가기</a>
  </form></main>`;
  host.querySelector('[data-login-form]').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    const data = new FormData(event.currentTarget);
    const { error } = await supabase.auth.signInWithPassword({ email: String(data.get('email')).trim(), password: String(data.get('password')) });
    if (error) { renderLogin(error.message); return; }
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) { renderLogin(userError?.message || '로그인 정보를 확인하지 못했습니다.'); return; }
    if (userData.user.email !== ADMIN_EMAIL) {
      await supabase.auth.signOut();
      renderLogin('관리자 계정이 아닙니다.');
      return;
    }
    user = userData.user;
    await loadData();
    subscribeRealtime();
  });
}

function renderShell() {
  host.innerHTML = `<main class="band-admin-app" data-realtime="${realtimeStatus}" data-realtime-events="${realtimeEventCount}">
    ${embedded ? '' : '<header class="band-admin-topbar"><a class="band-admin-brand" href="admin.html#ensemble"><img src="img/logo.png" alt=""><span>BAND ADMIN</span></a></header>'}
    <div class="band-admin-page">
      <section class="band-admin-round"><div class="band-admin-round-head"><label class="band-admin-round-picker"><span>회차:</span><select data-round-select aria-label="회차 선택">${rounds.map(item => `<option value="${item.id}" ${item.id === round?.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label><button type="button" data-manage-rounds>+ 회차 관리</button></div>${round ? `<div class="band-round-options band-admin-round-options" data-round-controls>${renderRoundControls(round)}</div>` : '<p>회차 관리에서 회차를 추가하세요.</p>'}</section>
      <button class="band-admin-participants-trigger" type="button" data-show-participants>신청자 확인 <span>${participantRows().length}명</span></button>
      <div class="band-admin-columns"><section class="band-admin-song-list"><header><div><h1>곡</h1><span>${songs.length}곡</span></div><button type="button" data-add-song ${round ? '' : 'disabled'}>+ 곡 추가</button></header><div data-song-list></div></section><section class="band-admin-editor" data-editor></section><aside class="band-admin-participants" data-participants></aside></div>
    </div><div class="band-admin-message" data-admin-message role="status"></div>
  </main>`;
  bindShell();
  renderSongList();
  renderEditor();
  renderParticipants();
}

function bindShell() {
  host.querySelector('[data-manage-rounds]').addEventListener('click', openRoundManagerModal);
  host.querySelector('[data-show-participants]').addEventListener('click', openParticipantsModal);
  host.querySelector('[data-add-song]').addEventListener('click', () => openSongModal());
  host.querySelectorAll('[data-round-controls] input').forEach(input => input.addEventListener('change', () => updateRoundSetting(input)));
  host.querySelector('[data-toggle-blind]')?.addEventListener('click', openBlindModal);
  host.querySelectorAll('[data-manage-schedule], [data-open-schedule]').forEach(button => button.addEventListener('click', openScheduleModal));
  host.querySelector('[data-round-select]')?.addEventListener('change', async event => {
    round = rounds.find(item => item.id === Number(event.target.value)) || null;
    selectedSongId = null;
    await loadRoundData();
  });
}

function bindRoundControls(scope) {
  scope.querySelectorAll('input').forEach(input => input.addEventListener('change', () => updateRoundSetting(input)));
  scope.querySelector('[data-toggle-blind]')?.addEventListener('click', openBlindModal);
  scope.querySelectorAll('[data-manage-schedule], [data-open-schedule]').forEach(button => button.addEventListener('click', openScheduleModal));
}

function openScheduleModal() {
  if (!round) return;
  closeModal(true);
  const panel = (kind, title) => {
    const mode = scheduleMode(round, kind);
    return `<section class="band-schedule-panel${mode === 'manual' ? ' is-manual' : ''}" data-schedule-kind="${kind}"><header><h3>${title}</h3><label class="band-schedule-switch"><input type="checkbox" name="${kind}_auto" ${mode === 'auto' ? 'checked' : ''}><span>${mode === 'auto' ? '자동' : '수동'}</span></label></header><div class="band-schedule-fields"><label><span>신청 시작</span><input type="datetime-local" step="1" name="${kind}_opens_at" value="${toDateTimeInput(round[scheduleField(kind, 'opens_at')])}" ${mode === 'manual' ? 'disabled' : ''}><small>${formatScheduleDate(round[scheduleField(kind, 'opens_at')])}</small></label><label><span>신청 종료</span><input type="datetime-local" step="1" name="${kind}_closes_at" value="${toDateTimeInput(round[scheduleField(kind, 'closes_at')])}" ${mode === 'manual' ? 'disabled' : ''}><small>${formatScheduleDate(round[scheduleField(kind, 'closes_at')])}</small></label></div></section>`;
  };
  host.insertAdjacentHTML('beforeend', `<div class="band-admin-modal" data-admin-modal><section class="band-schedule-manager" role="dialog" aria-modal="true"><header><h2>신청 예약</h2><button type="button" data-close aria-label="닫기">×</button></header><form><div class="band-schedule-grid">${panel('song', '곡 신청')}${panel('session', '세션 신청')}</div><p class="band-round-manager-error" data-error role="status"></p><footer><button type="button" data-close>취소</button><button type="submit">예약 저장</button></footer></form></section></div>`);
  const modal = host.querySelector('[data-admin-modal]');
  const form = modal.querySelector('form');
  const syncPanel = kind => {
    const section = form.querySelector(`[data-schedule-kind="${kind}"]`);
    const automatic = form.elements[`${kind}_auto`].checked;
    section.classList.toggle('is-manual', !automatic);
    section.querySelector('.band-schedule-switch span').textContent = automatic ? '자동' : '수동';
    section.querySelectorAll('input[type="datetime-local"]').forEach(input => { input.disabled = !automatic; });
  };
  modal.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', closeModal));
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  ['song', 'session'].forEach(kind => {
    form.elements[`${kind}_auto`].addEventListener('change', () => syncPanel(kind));
    ['opens_at', 'closes_at'].forEach(suffix => form.elements[`${kind}_${suffix}`].addEventListener('input', event => { event.target.nextElementSibling.textContent = formatScheduleDate(event.target.value); }));
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const payload = {};
    try {
      ['song', 'session'].forEach(kind => {
        const automatic = form.elements[`${kind}_auto`].checked;
        payload[scheduleField(kind, 'mode')] = automatic ? 'auto' : 'manual';
        if (!automatic) return;
        const opensAt = form.elements[`${kind}_opens_at`].value;
        const closesAt = form.elements[`${kind}_closes_at`].value;
        if (!opensAt || !closesAt || new Date(opensAt) >= new Date(closesAt)) throw new Error(`${kind === 'song' ? '곡' : '세션'} 신청의 시작·종료 시간을 올바르게 입력해주세요.`);
        payload[scheduleField(kind, 'opens_at')] = new Date(opensAt).toISOString();
        payload[scheduleField(kind, 'closes_at')] = new Date(closesAt).toISOString();
        payload[`${kind}_application_open`] = Date.now() >= new Date(opensAt).getTime() && Date.now() < new Date(closesAt).getTime();
      });
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      const { error } = await supabase.from('band_rounds').update(payload).eq('id', round.id);
      if (error) throw error;
      Object.assign(round, payload);
      Object.assign(rounds.find(item => item.id === round.id), payload);
      await announceRealtimeChange('round_schedule', round.id);
      closeModal();
      const controls = host.querySelector('[data-round-controls]');
      if (controls) { controls.innerHTML = renderRoundControls(round); bindRoundControls(controls); }
      showMessage('신청 예약을 저장했습니다.', 'success');
    } catch (error) { form.querySelector('[data-error]').textContent = error.message; form.querySelector('[type="submit"]').disabled = false; }
  });
}

function renderSongList() {
  const list = host.querySelector('[data-song-list]');
  if (!songs.length) { list.innerHTML = '<div class="band-admin-empty">등록된 곡이 없습니다.</div>'; return; }
  list.innerHTML = songs.map(song => {
    const rows = songMembers(song);
    const included = rows.filter(member => member.is_included !== false).length;
    const status = isFixedSong(song) ? '고정' : song.is_formed ? '결성' : '미결성';
    return `<button type="button" class="${song.id === selectedSongId ? 'is-selected' : ''}${isFixedSong(song) ? ' is-fixed' : ''}" data-song-id="${song.id}"><span><b>${esc(song.title)}</b><small>${esc(song.artist)}</small></span><span class="band-admin-song-meta"><strong class="is-${isFixedSong(song) ? 'fixed' : song.is_formed ? 'formed' : 'open'}"><i></i>${status}</strong><em>${included}/${rows.length}명</em></span></button>`;
  }).join('');
  list.querySelectorAll('[data-song-id]').forEach(button => button.addEventListener('click', () => {
    selectedSongId = Number(button.dataset.songId);
    renderSongList();
    renderEditor();
    if (window.matchMedia('(max-width: 820px)').matches) openSongEditorModal(songs.find(item => item.id === selectedSongId));
  }));
}

function updateSongListItem(song) {
  const button = host.querySelector(`[data-song-id="${song.id}"]`);
  if (!button) return;
  const fixed = isFixedSong(song);
  const status = fixed ? '고정' : song.is_formed ? '결성' : '미결성';
  button.classList.toggle('is-fixed', fixed);
  const title = button.querySelector('b');
  const artist = button.querySelector('small');
  const badge = button.querySelector('.band-admin-song-meta strong');
  if (title) title.textContent = song.title;
  if (artist) artist.textContent = song.artist;
  if (badge) {
    badge.className = `is-${fixed ? 'fixed' : song.is_formed ? 'formed' : 'open'}`;
    badge.innerHTML = `<i></i>${status}`;
  }
}

function renderParticipants(target = host.querySelector('[data-participants]')) {
  if (!target) return;
  const rows = participantRows();
  target.innerHTML = `<header><div><h2>참여자</h2><span>${rows.length}명</span></div></header><div class="band-admin-participant-list">${rows.length ? rows.map(item => {
    const details = [...item.songs].map(([songId, roles]) => ({ song: songs.find(song => song.id === songId), roles: [...roles] })).filter(item => item.song);
    return `<article data-participant-key="${esc(item.key)}"><div class="band-admin-participant-head"><span class="band-admin-participant-identity"><b>${esc(item.name)}</b><small>${esc(item.studentId || '')}</small></span><span class="band-admin-participant-actions"><strong>${item.songs.size}곡</strong><button type="button" data-participant-toggle aria-expanded="false">참여 현황</button></span></div><p>${[...item.roles].map(role => `<span>${esc(role)}</span>`).join('') || '<span>세션 미지정</span>'}</p><div class="band-admin-participant-drawer" aria-hidden="true"><div>${details.map(detail => `<p><b>${esc(detail.song.title)}</b><span>${detail.roles.map(role => esc(role)).join(', ') || '세션 미지정'}</span></p>`).join('')}</div><button type="button" data-participant-collapse>접기</button></div></article>`;
  }).join('') : '<div class="band-admin-empty">포함된 참여자가 없습니다.</div>'}</div>`;
  target.querySelectorAll('[data-participant-toggle]').forEach(button => button.addEventListener('click', () => setParticipantExpanded(button.closest('article'), !button.closest('article').classList.contains('is-expanded'))));
  target.querySelectorAll('[data-participant-collapse]').forEach(button => button.addEventListener('click', () => setParticipantExpanded(button.closest('article'), false)));
}

function setParticipantExpanded(article, expanded) {
  if (!article) return;
  article.classList.toggle('is-expanded', expanded);
  article.querySelector('[data-participant-toggle]')?.setAttribute('aria-expanded', String(expanded));
  article.querySelector('.band-admin-participant-drawer')?.setAttribute('aria-hidden', String(!expanded));
}

function songFields(song = {}) {
  return `<div class="band-admin-grid"><label><span>곡 제목</span><input name="title" required value="${esc(song.title || '')}"></label><label><span>가수</span><input name="artist" required value="${esc(song.artist || '')}"></label><label><span>곡 신청자</span><input name="applicant_name" required value="${esc(song.applicant_name || '')}"></label><label><span>학번</span><input name="student_id" required value="${esc(song.student_id || '')}"></label><label class="is-wide"><span>필요 세션</span><input name="wanted_roles" value="${esc(wantedRolesText(song.wanted_roles))}" placeholder="보컬, 기타2, 베이스, 드럼"><small>1명이면 세션 이름만, 여러 명이면 이름 뒤에 필요한 인원수를 적으세요. 예: 기타2</small></label><input type="hidden" name="applicant_role" value="${esc(getApplicantRole(song))}"><label class="is-wide"><span>메모</span><textarea name="note" rows="3">${esc(song.note || '')}</textarea></label><div class="band-admin-team-flags is-wide"><label class="band-admin-formed"><input name="is_formed" type="checkbox" ${song.is_formed ? 'checked' : ''}><span><b>결성 팀으로 표시</b><small>공개 페이지에서 결성 팀으로 분류됩니다.</small></span></label><label class="band-admin-formed"><input name="is_fixed" type="checkbox" ${isFixedSong(song) ? 'checked' : ''}><span><b>고정 팀</b><small>이 팀을 고정하고 세션 신청을 받지 않습니다.</small></span></label></div></div>`;
}

function memberFields(member = {}) {
  return `<div class="band-admin-grid"><label><span>이름</span><input name="applicant_name" required value="${esc(member.applicant_name || '')}"></label><label><span>학번</span><input name="student_id" required value="${esc(member.student_id || '')}"></label><label class="is-wide"><span>신청 세션</span><input name="roles" value="${esc(rolesText(member.roles))}" placeholder="기타, 코러스"></label></div>`;
}

function renderMemberRow(member, role) {
  return `<article class="${member.is_included === false ? 'is-excluded' : ''}${member.is_song_applicant ? ' is-song-applicant' : ''}">${member.is_song_applicant ? '<span class="band-admin-inclusion is-applicant">신청자</span>' : `<button class="band-admin-inclusion ${member.is_included === false ? 'is-off' : 'is-on'}" type="button" data-toggle-member="${member.id}" aria-label="${esc(member.applicant_name)} 팀 포함 상태 변경">${member.is_included === false ? 'OFF' : 'ON'}</button>`}<div class="band-admin-member-info"><b>${esc(member.applicant_name)}</b><small><span>${esc(member.student_id)}</span>${formatMemberTimestamp(member.created_at)}</small></div><p><span>${esc(role)}</span></p>${member.is_song_applicant ? '<div class="band-admin-member-actions"><span>곡 신청자</span></div>' : `<div class="band-admin-member-actions"><button type="button" data-edit-member="${member.id}">수정</button><button class="band-admin-move" type="button" data-move-member="${member.id}">이동</button><button class="is-danger" type="button" data-delete-member="${member.id}">삭제</button></div>`}</article>`;
}

function renderEditor(editor = host.querySelector('[data-editor]')) {
  if (!editor) return;
  const song = songs.find(item => item.id === selectedSongId);
  if (!song) { editor.innerHTML = '<div class="band-admin-empty is-large">편집할 곡을 선택하세요.</div>'; return; }
  const rows = songMembers(song);
  const includedCount = rows.filter(member => member.is_included !== false).length;
  const memberGroups = groupMembersByRole(rows);
  editor.innerHTML = `<header><div><span>SONG #${song.id}</span><h2>${esc(song.title)}</h2></div><button class="is-danger" type="button" data-delete-song>곡 삭제</button></header>
    <form class="band-admin-card" data-song-form data-song-id="${song.id}">${songFields(song)}</form>
    <section class="band-admin-members"><header><div><h3>세션 신청</h3><span>${includedCount}명 포함 · ${rows.length}건 · 세션별 신청 시각순</span></div><button type="button" data-add-member ${isFixedSong(song) ? 'disabled' : ''}>+ 세션 추가</button></header><div>${rows.length ? memberGroups.map(group => `<section class="band-admin-member-group"><header><h4>${esc(group.role)}</h4><span>${group.members.length}명</span></header>${group.members.map(member => renderMemberRow(member, group.role)).join('')}</section>`).join('') : '<div class="band-admin-empty">세션 신청이 없습니다.</div>'}</div></section>`;
  const songForm = editor.querySelector('[data-song-form]');
  songForm.addEventListener('submit', event => event.preventDefault());
  songForm.addEventListener('input', () => { songForm.dataset.dirty = 'true'; });
  songForm.querySelectorAll('input:not([type="checkbox"]), textarea').forEach(input => input.addEventListener('blur', () => saveSongForm(songForm, song)));
  songForm.querySelectorAll('input[type="checkbox"]').forEach(input => input.addEventListener('change', () => {
    songForm.dataset.dirty = 'true';
    saveSongForm(songForm, song);
  }));
  editor.querySelector('[data-delete-song]').addEventListener('click', () => deleteSong(song));
  editor.querySelector('[data-add-member]').addEventListener('click', () => openMemberModal(song));
  editor.querySelectorAll('[data-toggle-member]').forEach(button => button.addEventListener('click', () => toggleMember(members.find(item => item.id === Number(button.dataset.toggleMember)))));
  editor.querySelectorAll('[data-edit-member]').forEach(button => button.addEventListener('click', () => openMemberModal(song, members.find(item => item.id === Number(button.dataset.editMember)))));
  editor.querySelectorAll('[data-move-member]').forEach(button => button.addEventListener('click', () => openMoveMemberModal(members.find(item => item.id === Number(button.dataset.moveMember)))));
  editor.querySelectorAll('[data-delete-member]').forEach(button => button.addEventListener('click', () => deleteMember(members.find(item => item.id === Number(button.dataset.deleteMember)))));
}

function closeModal(immediate = false) {
  const modal = host.querySelector('[data-admin-modal]');
  if (!modal) return;
  if (immediate === true || !window.matchMedia('(max-width: 820px)').matches) { modal.remove(); return; }
  if (modal.classList.contains('is-closing')) return;
  modal.classList.add('is-closing');
  const panel = modal.querySelector(':scope > section');
  const remove = () => modal.remove();
  panel?.addEventListener('animationend', remove, { once: true });
  window.setTimeout(remove, 260);
}

function openModal(title, fields, submitLabel, onSubmit) {
  closeModal(true);
  host.insertAdjacentHTML('beforeend', `<div class="band-admin-modal" data-admin-modal><section role="dialog" aria-modal="true"><header><h2>${esc(title)}</h2><button type="button" data-close aria-label="닫기">×</button></header><form><div class="band-admin-modal-body">${fields}</div><p data-error></p><footer><button type="button" data-close>취소</button><button type="submit">${esc(submitLabel)}</button></footer></form></section></div>`);
  const modal = host.querySelector('[data-admin-modal]');
  const form = modal.querySelector('form');
  modal.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', closeModal));
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try { await onSubmit(new FormData(form)); closeModal(); } catch (error) { form.querySelector('[data-error]').textContent = error.message; submit.disabled = false; }
  });
  return modal;
}

async function updateRoundSetting(input) {
  if (!round || !input) return;
  const field = input.name;
  const previousValue = Boolean(round[field]);
  const nextValue = input.checked;
  input.disabled = true;
  const { error } = await supabase.from('band_rounds').update({ [field]: nextValue }).eq('id', round.id);
  input.disabled = false;
  if (error) {
    input.checked = previousValue;
    showMessage(error.message, 'error');
    return;
  }
  round[field] = nextValue;
  const stored = rounds.find(item => item.id === round.id);
  if (stored) stored[field] = nextValue;
  await announceRealtimeChange('round_setting', round.id);
  showMessage(`${field === 'song_application_open' ? '곡' : '세션'} 신청 설정을 반영했습니다.`, 'success');
}

function openBlindModal() {
  if (!round) return;
  const willBlind = !round.is_blinded;
  const message = willBlind
    ? '관리자의 합주 팀 구성을 비공개로 진행하기 위해 합주 신청 페이지를 블라인드합니다. 계속하시겠습니까?'
    : '블라인드를 해제하고 합주 신청 페이지를 다시 공개하시겠습니까?';
  openModal('회차 블라인드', `<p class="band-admin-confirm-copy">${message}</p>`, willBlind ? '확인' : '해제', async () => {
    const { error } = await supabase.from('band_rounds').update({ is_blinded: willBlind }).eq('id', round.id);
    if (error) {
      if (String(error.message || '').includes('is_blinded')) {
        throw new Error('DB에 블라인드 컬럼이 없습니다. guides/add-band-round-blind.sql을 Supabase SQL Editor에서 먼저 실행해주세요.');
      }
      throw error;
    }
    round.is_blinded = willBlind;
    const stored = rounds.find(item => item.id === round.id);
    if (stored) stored.is_blinded = willBlind;
    await announceRealtimeChange('round_blind', round.id);
    const button = host.querySelector('[data-toggle-blind]');
    if (button) {
      button.classList.toggle('is-active', willBlind);
      button.textContent = willBlind ? '블라인드 해제' : '회차 블라인드';
    }
    showMessage(willBlind ? '공개 페이지를 블라인드했습니다.' : '공개 페이지 블라인드를 해제했습니다.', 'success');
  });
}

function openRoundManagerModal() {
  const openApplicationCount = rounds.reduce((count, item) => count + Number(Boolean(item.song_application_open)) + Number(Boolean(item.session_application_open)), 0);
  closeModal(true);
  host.insertAdjacentHTML('beforeend', `<div class="band-admin-modal" data-admin-modal><section class="band-round-manager" role="dialog" aria-modal="true"><header><h2>회차 관리</h2><button type="button" data-close aria-label="닫기">×</button></header><div class="band-admin-modal-body">
    <div class="band-round-manager-summary"><div><span>현재 열린 신청</span><strong>${openApplicationCount}개</strong></div><button type="button" data-show-round-add>+ 추가</button></div>
    <form class="band-round-add" data-round-add hidden><label><span>새 회차 이름</span><input name="name" required placeholder="2027-1 정기공연 합주"></label><button type="submit">추가</button></form>
    <div class="band-round-list">${rounds.map((item, index) => `<article data-round-item="${item.id}"><div class="band-round-order-controls" aria-label="${esc(item.name)} 순서 변경"><button type="button" data-round-move="-1" aria-label="${esc(item.name)} 위로 이동" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-round-move="1" aria-label="${esc(item.name)} 아래로 이동" ${index === rounds.length - 1 ? 'disabled' : ''}>↓</button></div><div class="band-round-item-content"><div class="band-round-item-head"><input name="name" value="${esc(item.name)}" aria-label="회차 이름"><button class="is-danger" type="button" data-delete-round="${item.id}">삭제</button></div><div class="band-round-options"><label><input name="song_application_open" type="checkbox" ${item.song_application_open ? 'checked' : ''}><span>곡 신청</span></label><label><input name="session_application_open" type="checkbox" ${item.session_application_open ? 'checked' : ''}><span>세션 신청</span></label></div></div></article>`).join('') || '<div class="band-admin-empty">등록된 회차가 없습니다.</div>'}</div>
    <p class="band-round-manager-error" data-round-manager-error role="status"></p>
  </div></section></div>`);
  const modal = host.querySelector('[data-admin-modal]');
  modal.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', closeModal));
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  modal.querySelector('[data-show-round-add]').addEventListener('click', event => {
    const form = modal.querySelector('[data-round-add]');
    form.hidden = !form.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) form.querySelector('input').focus();
  });
  modal.querySelector('[data-round-add]').addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name')).trim();
    if (!confirm(`'${name}' 회차를 추가하시겠습니까?`)) return;
    try {
      const { data: created, error } = await supabase.from('band_rounds').insert({ name, is_active: false, sort_order: 0 }).select().single();
      if (error) throw error;
      round = created;
      await announceRealtimeChange('round_created', created.id);
      await loadData();
      openRoundManagerModal();
      showMessage('회차를 추가했습니다.', 'success');
    } catch (error) { showMessage(error.message, 'error'); }
  });
  const managerError = modal.querySelector('[data-round-manager-error]');
  const roundList = modal.querySelector('.band-round-list');
  const persistRoundOrder = async () => {
    const ids = [...roundList.querySelectorAll('[data-round-item]')].map(card => Number(card.dataset.roundItem));
    const previous = [...rounds];
    const previousOrders = new Map(rounds.map(item => [item.id, item.sort_order]));
    rounds = ids.map(id => rounds.find(item => item.id === id));
    rounds.forEach((item, index) => { item.sort_order = index + 1; });
    managerError.textContent = '';
    const results = await Promise.all(rounds.map(item => supabase.from('band_rounds').update({ sort_order: item.sort_order }).eq('id', item.id)));
    const failure = results.find(result => result.error)?.error;
    if (failure) { previous.forEach(item => { item.sort_order = previousOrders.get(item.id); }); rounds = previous; managerError.textContent = failure.message; openRoundManagerModal(); return; }
    await announceRealtimeChange('round_order', round?.id);
    const select = host.querySelector('[data-round-select]');
    if (select) select.innerHTML = rounds.map(item => `<option value="${item.id}" ${item.id === round?.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('');
  };
  const refreshOpenCount = () => {
    const count = rounds.reduce((sum, item) => sum + Number(Boolean(item.song_application_open)) + Number(Boolean(item.session_application_open)), 0);
    modal.querySelector('.band-round-manager-summary strong').textContent = `${count}개`;
  };
  const syncSelectedRound = (item, field, value) => {
    if (round?.id !== item.id) return;
    round[field] = value;
    const control = host.querySelector(`[data-round-controls] [name="${field}"]`);
    if (control) control.checked = value;
  };
  const refreshRoundMoveButtons = () => {
    const cards = [...roundList.querySelectorAll('[data-round-item]')];
    cards.forEach((card, index) => {
      card.querySelector('[data-round-move="-1"]').disabled = index === 0;
      card.querySelector('[data-round-move="1"]').disabled = index === cards.length - 1;
    });
  };
  modal.querySelectorAll('[data-round-item]').forEach(card => {
    const item = rounds.find(value => value.id === Number(card.dataset.roundItem));
    if (!item) return;
    card.querySelectorAll('[data-round-move]').forEach(button => button.addEventListener('click', async () => {
      const direction = Number(button.dataset.roundMove);
      const sibling = direction < 0 ? card.previousElementSibling : card.nextElementSibling;
      if (!sibling) return;
      roundList.insertBefore(card, direction < 0 ? sibling : sibling.nextElementSibling);
      refreshRoundMoveButtons();
      await persistRoundOrder();
      card.querySelector(`[data-round-move="${direction}"]`)?.focus();
    }));
    const nameInput = card.querySelector('[name="name"]');
    nameInput.addEventListener('blur', async () => {
      const previousName = item.name;
      const nextName = nameInput.value.trim();
      if (!nextName) { nameInput.value = previousName; managerError.textContent = '회차 이름을 입력해주세요.'; return; }
      if (nextName === previousName) return;
      nameInput.disabled = true;
      managerError.textContent = '';
      const { error } = await supabase.from('band_rounds').update({ name: nextName }).eq('id', item.id);
      nameInput.disabled = false;
      if (error) { nameInput.value = previousName; managerError.textContent = error.message; return; }
      item.name = nextName;
      await announceRealtimeChange('round_updated', item.id);
      if (round?.id === item.id) round.name = nextName;
      const option = host.querySelector(`[data-round-select] option[value="${item.id}"]`);
      if (option) option.textContent = nextName;
    });
    card.querySelectorAll('.band-round-options input').forEach(input => input.addEventListener('change', async () => {
      const field = input.name;
      const previousValue = Boolean(item[field]);
      const nextValue = input.checked;
      input.disabled = true;
      managerError.textContent = '';
      const { error } = await supabase.from('band_rounds').update({ [field]: nextValue }).eq('id', item.id);
      input.disabled = false;
      if (error) { input.checked = previousValue; managerError.textContent = error.message; return; }
      item[field] = nextValue;
      await announceRealtimeChange('round_setting', item.id);
      syncSelectedRound(item, field, nextValue);
      refreshOpenCount();
    }));
  });
  modal.querySelectorAll('[data-delete-round]').forEach(button => button.addEventListener('click', async () => {
    const item = rounds.find(value => value.id === Number(button.dataset.deleteRound));
    if (!item || !confirm(`'${item.name}' 회차와 소속 곡 및 세션 신청을 모두 삭제하시겠습니까?`)) return;
    const { error } = await supabase.from('band_rounds').delete().eq('id', item.id);
    if (error) { showMessage(error.message, 'error'); return; }
    if (round?.id === item.id) round = null;
    await announceRealtimeChange('round_deleted', item.id);
    await loadData();
    openRoundManagerModal();
    showMessage('회차를 삭제했습니다.', 'success');
  }));
}

function openParticipantsModal() {
  closeModal(true);
  host.insertAdjacentHTML('beforeend', `<div class="band-admin-modal" data-admin-modal><section class="band-admin-participants-modal" role="dialog" aria-modal="true"><header><h2>신청자 확인</h2><button type="button" data-close aria-label="닫기">×</button></header><div class="band-admin-participants" data-participants-modal></div></section></div>`);
  const modal = host.querySelector('[data-admin-modal]');
  modal.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', closeModal));
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  renderParticipants(modal.querySelector('[data-participants-modal]'));
}

function openSongEditorModal(song) {
  if (!song) return;
  closeModal(true);
  host.insertAdjacentHTML('beforeend', `<div class="band-admin-modal band-admin-song-modal" data-admin-modal><section role="dialog" aria-modal="true"><header><h2>곡 정보</h2><button type="button" data-close aria-label="닫기">×</button></header><div class="band-admin-mobile-editor" data-mobile-editor></div></section></div>`);
  const modal = host.querySelector('[data-admin-modal]');
  modal.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', closeModal));
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  renderEditor(modal.querySelector('[data-mobile-editor]'));
}

function openSongModal() {
  openModal('곡 추가', songFields(), '곡 추가', async data => {
    const { data: created, error } = await supabase.from('band_songs').insert(songPayload(data, round.id)).select().single();
    if (error) throw error;
    selectedSongId = created.id;
    await announceRealtimeChange('song_created', created.id);
    await loadRoundData();
    showMessage('곡을 추가했습니다.', 'success');
  });
}

function openMemberModal(song, member = null) {
  openModal(member ? '세션 신청 수정' : '세션 신청 추가', memberFields(member || {}), member ? '저장' : '추가', async data => {
    const payload = { applicant_name: String(data.get('applicant_name')).trim(), student_id: String(data.get('student_id')).trim(), roles: parseRoles(data.get('roles')) };
    const query = member ? supabase.from('band_members').update(payload).eq('id', member.id) : supabase.from('band_members').insert({ ...payload, song_id: song.id });
    const { error } = await query;
    if (error) throw error;
    await announceRealtimeChange(member ? 'member_updated' : 'member_created', member?.id || song.id);
    await loadRoundData();
    showMessage(member ? '세션 신청을 수정했습니다.' : '세션 신청을 추가했습니다.', 'success');
  });
}

function openMoveMemberModal(member) {
  if (!member) return;
  const currentSong = songs.find(song => song.id === member.song_id);
  if (!currentSong) return;
  const currentRole = normalizeRole(member.roles?.[0] || '') || songRoleOptions(currentSong)[0] || '';
  const fields = `<div class="band-move-summary"><b>${esc(member.applicant_name)}</b><span>기존 곡: ${esc(currentSong.title)}</span><span>기존 세션: ${esc(rolesText(member.roles) || '미지정')}</span></div><div class="band-admin-grid"><label class="is-wide"><span>어떤 곡으로 이동할까요?</span><select name="song_id" data-move-song>${songs.map(song => `<option value="${song.id}" ${song.id === currentSong.id ? 'selected' : ''}>${esc(song.title)} · ${esc(song.artist)}</option>`).join('')}</select></label><label class="is-wide"><span>무슨 세션으로 배치할까요?</span><select name="role" data-move-role></select></label></div>`;
  const modal = openModal('세션 이동', fields, '이동', async data => {
    const targetSongId = Number(data.get('song_id'));
    const role = String(data.get('role') || '').trim();
    if (!songs.some(song => song.id === targetSongId)) throw new Error('이동할 곡을 선택해주세요.');
    if (!role) throw new Error('배치할 세션을 선택해주세요.');
    const { error } = await supabase.from('band_members').update({ song_id: targetSongId, roles: [role] }).eq('id', member.id);
    if (error) throw error;
    selectedSongId = targetSongId;
    await announceRealtimeChange('member_moved', member.id);
    await loadRoundData();
    showMessage(`${member.applicant_name}님의 세션을 이동했습니다.`, 'success');
  });
  const songSelect = modal.querySelector('[data-move-song]');
  const roleSelect = modal.querySelector('[data-move-role]');
  const renderRoles = () => {
    const target = songs.find(song => song.id === Number(songSelect.value));
    const roles = songRoleOptions(target);
    const preferred = target?.id === currentSong.id ? currentRole : roles[0];
    roleSelect.innerHTML = roles.map(role => `<option value="${esc(role)}" ${role === preferred ? 'selected' : ''}>${esc(role)}</option>`).join('');
    roleSelect.disabled = !roles.length;
  };
  songSelect.addEventListener('change', renderRoles);
  renderRoles();
}

function songPayload(data, roundId) {
  const wantedRoles = parseWantedRoles(data.get('wanted_roles'));
  const applicantRole = String(data.get('applicant_role') || '').trim();
  if (data.get('is_fixed') === 'on') wantedRoles.push(FIXED_ROLE_MARKER);
  if (applicantRole) wantedRoles.push(`${APPLICANT_ROLE_PREFIX}${applicantRole}`);
  return { round_id: roundId, title: String(data.get('title')).trim(), artist: String(data.get('artist')).trim(), applicant_name: String(data.get('applicant_name')).trim(), student_id: String(data.get('student_id')).trim(), wanted_roles: wantedRoles, note: String(data.get('note')).trim(), is_formed: data.get('is_formed') === 'on' };
}

async function toggleMember(member) {
  if (!member) return;
  const next = member.is_included === false;
  const { error } = await supabase.from('band_members').update({ is_included: next }).eq('id', member.id);
  if (error) { showMessage(error.message, 'error'); return; }
  member.is_included = next;
  await announceRealtimeChange('member_toggled', member.id);
  renderSongList();
  renderEditor();
  renderParticipants();
  const mobileEditor = host.querySelector('[data-mobile-editor]');
  if (mobileEditor) renderEditor(mobileEditor);
  showMessage(next ? '팀에 포함했습니다.' : '팀에서 제외했습니다.', 'success');
}

async function saveSongForm(form, song) {
  if (!form || !song || form.dataset.dirty !== 'true') return;
  if (form.dataset.saving === 'true') { form.dataset.pendingSave = 'true'; return; }
  form.dataset.saving = 'true';
  const payload = songPayload(new FormData(form), round.id);
  const { error } = await supabase.from('band_songs').update(payload).eq('id', song.id);
  form.dataset.saving = 'false';
  if (error) { showMessage(error.message, 'error'); return; }
  Object.assign(song, payload);
  form.dataset.dirty = 'false';
  await announceRealtimeChange('song_updated', song.id);
  updateSongListItem(song);
  const header = form.closest('[data-editor], [data-mobile-editor]')?.querySelector(':scope > header h2');
  if (header) header.textContent = song.title;
  const addMember = form.closest('[data-editor], [data-mobile-editor]')?.querySelector('[data-add-member]');
  if (addMember) addMember.disabled = isFixedSong(song);
  showMessage('변경사항을 저장했습니다.', 'success');
  if (form.dataset.pendingSave === 'true') {
    form.dataset.pendingSave = 'false';
    form.dataset.dirty = 'true';
    await saveSongForm(form, song);
  }
}

async function deleteSong(song) {
  if (!confirm(`'${song.title}' 곡과 소속 세션 신청을 모두 삭제할까요?`)) return;
  const { error } = await supabase.from('band_songs').delete().eq('id', song.id);
  if (error) { showMessage(error.message, 'error'); return; }
  selectedSongId = null;
  await announceRealtimeChange('song_deleted', song.id);
  await loadRoundData();
  showMessage('곡을 삭제했습니다.', 'success');
}

async function deleteMember(member) {
  if (!member || !confirm(`${member.applicant_name}님의 세션 신청을 삭제할까요?`)) return;
  const { error } = await supabase.from('band_members').delete().eq('id', member.id);
  if (error) { showMessage(error.message, 'error'); return; }
  await announceRealtimeChange('member_deleted', member.id);
  await loadRoundData();
  showMessage('세션 신청을 삭제했습니다.', 'success');
}

async function fetchRoundData() {
  if (!round) { songs = []; members = []; return; }
  const { data: songRows, error: songError } = await supabase.from('band_songs').select('*').eq('round_id', round.id).order('created_at').order('id');
  if (songError) throw songError;
  songs = songRows || [];
  const ids = songs.map(song => song.id);
  members = [];
  if (ids.length) {
    const { data, error } = await supabase.from('band_members').select('*').in('song_id', ids).order('created_at').order('id');
    if (error) throw error;
    members = data || [];
  }
  if (!songs.some(song => song.id === selectedSongId)) selectedSongId = songs[0]?.id || null;
}

async function fetchAdminData() {
  const preferredRoundId = round?.id;
  const { data, error } = await supabase.from('band_rounds').select('*').order('sort_order').order('created_at', { ascending: false });
  if (error) throw error;
  rounds = data || [];
  round = rounds.find(item => item.id === preferredRoundId) || rounds[0] || null;
  await fetchRoundData();
}

async function loadRoundData() {
  await fetchRoundData();
  renderShell();
}

function captureForm(form) {
  return {
    songId: form.dataset.songId,
    mobile: Boolean(form.closest('[data-mobile-editor]')),
    fields: [...form.elements].filter(field => field.name).map(field => ({
      name: field.name,
      value: field.value,
      checked: field.checked,
      type: field.type,
    })),
  };
}

function restoreForm(saved) {
  const scope = saved.mobile ? host.querySelector('[data-mobile-editor]') : host.querySelector('[data-editor]');
  const form = scope?.querySelector(`[data-song-form][data-song-id="${saved.songId}"]`);
  if (!form) return;
  for (const savedField of saved.fields) {
    const field = [...form.elements].find(item => item.name === savedField.name);
    if (!field) continue;
    if (savedField.type === 'checkbox' || savedField.type === 'radio') field.checked = savedField.checked;
    else field.value = savedField.value;
  }
  form.dataset.dirty = 'true';
}

function captureRealtimeState() {
  const active = document.activeElement;
  const activeState = active && host.contains(active) && active.matches('input, textarea, select') ? {
    name: active.name,
    value: active.value,
    checked: active.checked,
    start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
    songId: active.closest('[data-song-form]')?.dataset.songId || null,
    mobile: Boolean(active.closest('[data-mobile-editor]')),
    roundId: active.closest('[data-round-item]')?.dataset.roundItem || null,
  } : null;
  const scrolls = ['[data-song-list]', '[data-editor]', '[data-participants]', '[data-mobile-editor]', '.band-admin-modal > section', '.band-round-list']
    .flatMap(selector => [...host.querySelectorAll(selector)].map((element, index) => ({ selector, index, top: element.scrollTop, left: element.scrollLeft })));
  return {
    dirtyForms: [...host.querySelectorAll('[data-song-form][data-dirty="true"]')].map(captureForm),
    managerOpen: Boolean(host.querySelector('.band-round-manager')),
    participantsOpen: Boolean(host.querySelector('[data-participants-modal]')),
    expandedParticipants: [...host.querySelectorAll('[data-participant-key].is-expanded')].map(article => article.dataset.participantKey),
    activeState,
    scrolls,
    pageX: window.scrollX,
    pageY: window.scrollY,
  };
}

function restoreActiveField(saved) {
  if (!saved) return;
  let scope = host;
  if (saved.roundId) scope = host.querySelector(`[data-round-item="${saved.roundId}"]`) || host;
  else if (saved.songId) scope = saved.mobile ? host.querySelector('[data-mobile-editor]') : host.querySelector('[data-editor]');
  const field = scope?.querySelector(`[name="${saved.name}"]`);
  if (!field) return;
  if (saved.roundId) {
    if (field.type === 'checkbox' || field.type === 'radio') field.checked = saved.checked;
    else field.value = saved.value;
  }
  field.focus({ preventScroll: true });
  if (saved.start !== null && typeof field.setSelectionRange === 'function') field.setSelectionRange(saved.start, saved.end);
}

function restoreRealtimeState(state) {
  state.dirtyForms.forEach(restoreForm);
  for (const key of state.expandedParticipants) host.querySelectorAll('[data-participant-key]').forEach(article => { if (article.dataset.participantKey === key) setParticipantExpanded(article, true); });
  restoreActiveField(state.activeState);
  for (const saved of state.scrolls) {
    const element = host.querySelectorAll(saved.selector)[saved.index];
    if (element) { element.scrollTop = saved.top; element.scrollLeft = saved.left; }
  }
  window.scrollTo(state.pageX, state.pageY);
}

function syncAdminShell(state) {
  const select = host.querySelector('[data-round-select]');
  if (select) select.innerHTML = rounds.map(item => `<option value="${item.id}" ${item.id === round?.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('');
  const controls = host.querySelector('[data-round-controls]');
  if (controls && round) {
    controls.innerHTML = renderRoundControls(round);
    bindRoundControls(controls);
  }
  const trigger = host.querySelector('[data-show-participants] span');
  if (trigger) trigger.textContent = `${participantRows().length}명`;
  const count = host.querySelector('.band-admin-song-list header span');
  if (count) count.textContent = `${songs.length}곡`;
  renderSongList();
  renderEditor();
  renderParticipants();
  if (host.querySelector('[data-mobile-editor]')) renderEditor(host.querySelector('[data-mobile-editor]'));
  if (state.participantsOpen) renderParticipants(host.querySelector('[data-participants-modal]'));
  if (state.managerOpen) openRoundManagerModal();
}

async function refreshFromRealtime() {
  if (destroyed || !host?.querySelector('.band-admin-page')) return;
  const state = captureRealtimeState();
  try {
    await fetchAdminData();
    if (destroyed) return;
    syncAdminShell(state);
    restoreRealtimeState(state);
  } catch (error) {
    if (!destroyed) showMessage(error?.message || '실시간 데이터를 갱신하지 못했습니다.', 'error');
  }
}

function scheduleRealtimeRefresh() {
  window.clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = window.setTimeout(refreshFromRealtime, 120);
}

function handleRealtimeChange() {
  realtimeEventCount += 1;
  const app = host?.querySelector('.band-admin-app');
  if (app) app.dataset.realtimeEvents = String(realtimeEventCount);
  scheduleRealtimeRefresh();
}

async function announceRealtimeChange(scope, id = null) {
  const payload = { scope, id, source: 'band-admin', sent_at: Date.now() };
  if (!realtimeChannel || realtimeStatus !== 'connected') {
    pendingRealtimeSignals.push(payload);
    return;
  }
  try {
    const result = await realtimeChannel.send({
      type: 'broadcast',
      event: REALTIME_EVENT,
      payload,
    });
    if (result !== 'ok') {
      pendingRealtimeSignals.push(payload);
      console.warn('Band realtime broadcast was not acknowledged:', result);
    }
  } catch (error) {
    pendingRealtimeSignals.push(payload);
    console.warn('Band realtime broadcast failed:', error);
  }
}

async function flushRealtimeSignals() {
  if (!realtimeChannel || realtimeStatus !== 'connected' || !pendingRealtimeSignals.length) return;
  const queued = pendingRealtimeSignals;
  pendingRealtimeSignals = [];
  for (const payload of queued) await announceRealtimeChange(payload.scope, payload.id);
}

function subscribeRealtime() {
  if (destroyed || realtimeReplacing) return;
  realtimeReplacing = true;
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase.channel(REALTIME_TOPIC, { config: { broadcast: { self: false, ack: true } } })
    .on('broadcast', { event: REALTIME_EVENT }, handleRealtimeChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'band_rounds' }, handleRealtimeChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'band_songs' }, handleRealtimeChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'band_members' }, handleRealtimeChange)
    .subscribe(status => {
      realtimeReplacing = false;
      realtimeStatus = status === 'SUBSCRIBED' ? 'connected' : status.toLowerCase();
      const app = host?.querySelector('.band-admin-app');
      if (app) app.dataset.realtime = realtimeStatus;
      if (destroyed) return;
      if (status === 'SUBSCRIBED') {
        flushRealtimeSignals();
        return;
      }
      if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        window.clearTimeout(realtimeReconnectTimer);
        realtimeReconnectTimer = window.setTimeout(subscribeRealtime, 2500);
      }
    });
}

async function loadData() {
  try {
    await fetchAdminData();
    renderShell();
  } catch (error) {
    host.innerHTML = `<main class="band-admin-app band-admin-failure"><h1>관리자 데이터를 불러오지 못했습니다</h1><p>${esc(error.message)}</p><button type="button" data-retry>다시 시도</button></main>`;
    host.querySelector('[data-retry]').addEventListener('click', loadData);
  }
}

export async function init(container, options = {}) {
  host = container;
  embedded = Boolean(options.embedded);
  destroyed = false;
  realtimeStatus = 'idle';
  realtimeEventCount = 0;
  pendingRealtimeSignals = [];
  if (!embedded) document.body.classList.add('band-admin-mode');
  host.classList.toggle('is-band-admin-embedded', embedded);
  const { data, error } = await supabase.auth.getUser();
  if (!error && data.user?.email === ADMIN_EMAIL) {
    user = data.user;
    await loadData();
    subscribeRealtime();
  } else {
    if (data.user) await supabase.auth.signOut();
    renderLogin(data.user ? '관리자 계정이 아닙니다.' : '');
  }
  const refreshWhenVisible = () => { if (document.visibilityState === 'visible') scheduleRealtimeRefresh(); };
  document.addEventListener('visibilitychange', refreshWhenVisible);
  window.addEventListener('online', scheduleRealtimeRefresh);
  return () => {
    destroyed = true;
    window.clearTimeout(realtimeRefreshTimer);
    window.clearTimeout(realtimeReconnectTimer);
    document.removeEventListener('visibilitychange', refreshWhenVisible);
    window.removeEventListener('online', scheduleRealtimeRefresh);
    if (realtimeChannel) supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
    pendingRealtimeSignals = [];
    if (!embedded) document.body.classList.remove('band-admin-mode');
    host?.classList.remove('is-band-admin-embedded');
    if (host) host.innerHTML = '';
    host = null;
    embedded = false;
  };
}
