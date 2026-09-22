import { supabase } from '../supabase.js';
import { escapeHtml as esc } from '../utils/html.js';

let host = null;
let rounds = [];
let round = null;
let songs = [];
let membersBySong = new Map();
let selectedSongId = null;
let searchQuery = '';
let statusFilter = 'all';
let hideFixedTeams = false;
let destroyed = false;
let realtimeChannel = null;
let realtimeRefreshTimer = null;
let realtimeReconnectTimer = null;
let realtimeReplacing = false;
let realtimeStatus = 'idle';
let realtimeEventCount = 0;
let pendingRealtimeSignals = [];

const REALTIME_TOPIC = 'band-sync-v1';
const REALTIME_EVENT = 'band_changed';

const ROLE_ORDER = ['보컬', '기타', '베이스', '키보드', '드럼', '그 외'];
const FIXED_ROLE_MARKER = '__BAND_FIXED__';
const APPLICANT_ROLE_PREFIX = '__BAND_APPLICANT_ROLE__:';

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
  return raw || '그 외';
}

function parseRoles(value) {
  return String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean);
}

function parseWantedRoles(value) {
  return parseRoles(value).flatMap(item => {
    const match = item.match(/^(.*?)(\d+)$/);
    if (!match || !match[1].trim()) return [item];
    const count = Math.max(1, Number(match[2]));
    return Array.from({ length: count }, () => match[1].trim());
  });
}

function sortRoles(entries) {
  return [...entries].sort((a, b) => {
    const ai = ROLE_ORDER.indexOf(a.role);
    const bi = ROLE_ORDER.indexOf(b.role);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.role.localeCompare(b.role, 'ko');
  });
}

function getRequirements(song) {
  const counts = new Map();
  for (const raw of visibleWantedRoles(song)) {
    const role = normalizeRole(raw);
    counts.set(role, (counts.get(role) || 0) + 1);
  }
  return sortRoles([...counts].map(([role, count]) => ({ role, count })));
}

function getMembers(song) {
  const members = [...(membersBySong.get(song.id) || [])];
  const applicantRole = getApplicantRole(song);
  const studentId = String(song.student_id || '').trim();
  if (applicantRole && !members.some(member => String(member.student_id || '').trim() === studentId)) {
    members.push({ id: `applicant-${song.id}`, song_id: song.id, applicant_name: song.applicant_name, student_id: song.student_id, roles: [applicantRole], created_at: song.created_at, is_included: true, is_song_applicant: true });
  }
  return members.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)));
}

function getIncludedMembers(song) {
  return getMembers(song).filter(member => member.is_included !== false);
}

function formatAppliedAt(value) {
  if (!value) return '시간 정보 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '시간 정보 없음';
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function getRoleCounts(song) {
  const counts = new Map();
  for (const member of getIncludedMembers(song)) {
    for (const raw of member.roles || []) {
      const role = normalizeRole(raw);
      counts.set(role, (counts.get(role) || 0) + 1);
    }
  }
  return counts;
}

function getMissingRoles(song) {
  const counts = getRoleCounts(song);
  return getRequirements(song)
    .map(requirement => ({ ...requirement, filled: counts.get(requirement.role) || 0, missing: Math.max(0, requirement.count - (counts.get(requirement.role) || 0)) }))
    .filter(requirement => requirement.missing > 0);
}

function getSearchText(song) {
  const members = getMembers(song);
  return [song.title, song.artist, song.applicant_name, ...visibleWantedRoles(song), ...members.flatMap(member => [member.applicant_name, ...(member.roles || [])])]
    .join(' ').toLocaleLowerCase('ko');
}

function visibleSongs() {
  const query = searchQuery.toLocaleLowerCase('ko');
  return songs.filter(song => {
    if (hideFixedTeams && isFixedSong(song)) return false;
    if (statusFilter === 'formed' && !song.is_formed) return false;
    if (statusFilter === 'unformed' && song.is_formed) return false;
    return !query || getSearchText(song).includes(query);
  });
}

function renderStatus(song) {
  if (isFixedSong(song)) return '<span class="band-status band-status-fixed"><i></i>고정</span>';
  return song.is_formed
    ? '<span class="band-status band-status-formed"><i></i>결성</span>'
    : '<span class="band-status band-status-open"><i></i>미결성</span>';
}

function renderRoleSummary(song) {
  const requirements = getRequirements(song);
  const counts = getRoleCounts(song);
  if (!requirements.length) return '<span class="band-muted">필요 세션 자유 모집</span>';
  return requirements.map(({ role, count }) => {
    const filled = counts.get(role) || 0;
    return `<span class="band-session-mini${filled >= count ? ' is-full' : ''}">${esc(role)} <b>${filled}/${count}</b></span>`;
  }).join('');
}

function renderList() {
  const list = host.querySelector('[data-band-list]');
  const filtered = visibleSongs();
  host.querySelector('[data-band-result-count]').textContent = `${filtered.length}곡`;
  if (!filtered.length) {
    list.innerHTML = '<div class="band-empty"><strong>검색 결과가 없습니다</strong><span>다른 곡, 사람 또는 세션을 검색해보세요.</span></div>';
    renderDetail(null);
    return;
  }
  if (!filtered.some(song => song.id === selectedSongId)) selectedSongId = filtered[0].id;
  list.innerHTML = filtered.map((song, index) => `<button class="band-song${song.id === selectedSongId ? ' is-selected' : ''}${isFixedSong(song) ? ' is-fixed' : ''}" type="button" data-song-id="${song.id}">
    <span class="band-song-index">${String(index + 1).padStart(2, '0')}</span>
    <span class="band-song-main"><span class="band-song-title">${esc(song.title)}</span><span class="band-song-artist">${esc(song.artist)}</span><span class="band-song-sessions">${renderRoleSummary(song)}</span></span>
    <span class="band-song-meta">${renderStatus(song)}<span>${getIncludedMembers(song).length}명</span></span>
  </button>`).join('');
  list.querySelectorAll('[data-song-id]').forEach(button => button.addEventListener('click', () => {
    selectedSongId = Number(button.dataset.songId);
    renderList();
    if (isMobileView()) openSongDetail(songs.find(song => song.id === selectedSongId));
  }));
  if (!isMobileView()) renderDetail(songs.find(song => song.id === selectedSongId) || null);
}

function renderMember(member) {
  const suffix = String(member.student_id || '').slice(-3);
  const excluded = member.is_included === false;
  return `<li class="band-member${excluded ? ' is-excluded' : ''}">
    <span class="band-avatar" aria-hidden="true">${esc(String(member.applicant_name || '?').slice(0, 1))}</span>
    <span class="band-member-name"><b>${esc(member.applicant_name)}</b>${suffix ? `<small>${esc(suffix)}</small>` : ''}${member.is_song_applicant ? '<em>곡 신청자</em>' : ''}${excluded ? '<em>비포함</em>' : ''}</span>
    <span class="band-member-roles">${(member.roles || []).map(role => `<span>${esc(role)}</span>`).join('') || '<span>자유 세션</span>'}</span>
    <time datetime="${esc(member.created_at || '')}">${esc(formatAppliedAt(member.created_at))}</time>
  </li>`;
}

function renderDetail(song, detail = host.querySelector('[data-band-detail]')) {
  if (!detail) return;
  if (!song) {
    detail.innerHTML = '<div class="band-detail-empty">표시할 곡이 없습니다.</div>';
    return;
  }
  const members = getMembers(song);
  const includedMembers = getIncludedMembers(song);
  const requirements = getRequirements(song);
  const counts = getRoleCounts(song);
  const missing = getMissingRoles(song);
  const fixed = isFixedSong(song);
  const canApply = Boolean(round?.session_application_open) && !fixed;
  detail.classList.toggle('band-detail-fixed', fixed);
  detail.innerHTML = `<div class="band-detail-head">
      <div><div class="band-detail-status">${renderStatus(song)}</div><h2>${esc(song.title)}</h2><p>${esc(song.artist)}</p></div>
      <div class="band-applicant"><span>곡 신청자</span><b>${esc(song.applicant_name)}</b></div>
    </div>
    <form class="band-song-note" data-song-note-form>
      <div><label for="band-song-note-${song.id}">공개 메모</label><span><button type="button" data-note-clear>지우기</button><button type="submit">저장</button></span></div>
      <textarea id="band-song-note-${song.id}" data-song-note placeholder="이 곡에 관한 메모를 남겨보세요.">${esc(song.note || '')}</textarea>
    </form>
    <section class="band-detail-section">
      <div class="band-section-title"><h3>필요 세션</h3><span>${requirements.reduce((sum, item) => sum + item.count, 0)}자리</span></div>
      <div class="band-requirements">${requirements.length ? requirements.map(({ role, count }) => {
        const filled = counts.get(role) || 0;
        return `<button class="band-requirement${filled >= count ? ' is-full' : ''}" type="button" data-apply-role="${esc(role)}" ${canApply ? '' : 'disabled'}><span>${esc(role)}</span><strong>${filled}<small> / ${count}</small></strong><i style="--progress:${Math.min(100, Math.round((filled / count) * 100))}%"></i></button>`;
      }).join('') : '<span class="band-muted">정해진 자리가 없습니다. 원하는 세션으로 신청할 수 있습니다.</span>'}</div>
      ${requirements.length ? (missing.length ? `<div class="band-missing"><b>빈자리</b>${missing.map(item => `<span>${esc(item.role)} ${item.missing}명</span>`).join('')}</div>` : '<div class="band-complete">필요한 자리가 모두 채워졌습니다.</div>') : ''}
    </section>
    <button class="band-primary band-apply-session${fixed ? ' is-fixed' : ''}" type="button" data-apply-session ${canApply ? '' : 'disabled'}>${fixed ? '사전구성하여 고정된 팀입니다.' : canApply ? '이 곡에 세션 신청' : '세션 신청 닫힘'}</button>
    <section class="band-detail-section">
      <div class="band-section-title"><h3>세션 신청 현황</h3><span>${includedMembers.length}명 포함 · ${members.length}건</span></div>
      ${members.length ? `<ul class="band-member-list">${members.map(renderMember).join('')}</ul>` : '<div class="band-no-members">아직 세션 신청이 없습니다.</div>'}
    </section>`;
  detail.querySelector('[data-apply-session]')?.addEventListener('click', () => openMemberForm(song));
  detail.querySelectorAll('[data-apply-role]').forEach(button => button.addEventListener('click', () => openMemberForm(song, button.dataset.applyRole)));
  const noteForm = detail.querySelector('[data-song-note-form]');
  const noteInput = detail.querySelector('[data-song-note]');
  const resizeNote = () => {
    noteInput.style.height = 'auto';
    noteInput.style.height = `${Math.max(62, noteInput.scrollHeight)}px`;
  };
  noteInput.addEventListener('input', () => {
    noteInput.dataset.dirty = 'true';
    resizeNote();
  });
  resizeNote();
  noteForm.addEventListener('submit', event => {
    event.preventDefault();
    saveSongNote(song, noteInput.value, noteForm);
  });
  noteForm.querySelector('[data-note-clear]').addEventListener('click', () => {
    noteInput.value = '';
    noteInput.dataset.dirty = 'true';
    resizeNote();
    saveSongNote(song, '', noteForm);
  });
}

function isMobileView() {
  return window.matchMedia('(max-width: 820px)').matches;
}

function openSongDetail(song) {
  if (!song) return;
  closeModal(true);
  host.insertAdjacentHTML('beforeend', `<div class="band-modal band-song-detail-modal" data-band-modal role="presentation"><section class="band-modal-panel" role="dialog" aria-modal="true" aria-labelledby="band-detail-modal-title">
    <div class="band-modal-head"><h2 id="band-detail-modal-title">곡 상세 정보</h2><button type="button" data-modal-close aria-label="닫기">×</button></div>
    <div class="band-mobile-detail" data-band-mobile-detail></div>
  </section></div>`);
  const modal = host.querySelector('[data-band-modal]');
  modal.querySelectorAll('[data-modal-close]').forEach(button => button.addEventListener('click', closeModal));
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  renderDetail(song, modal.querySelector('[data-band-mobile-detail]'));
}

function renderStats() {
  const formed = songs.filter(song => song.is_formed);
  const uniqueMembers = new Set(formed.flatMap(song => getIncludedMembers(song).map(member => String(member.student_id || '').trim() || `name:${member.applicant_name}`)));
  host.querySelector('[data-band-stats]').innerHTML = `<span><b>${songs.length}</b> 전체 곡</span><span><b>${formed.length}</b> 결성 팀</span><span><b>${uniqueMembers.size}</b> 참여자</span>`;
}

function showNotice(message, type = '') {
  const notice = host.querySelector('[data-band-notice]');
  notice.textContent = message;
  notice.className = `band-notice is-visible${type ? ` is-${type}` : ''}`;
  window.setTimeout(() => notice?.classList.remove('is-visible'), 3500);
}

async function saveSongNote(song, value, form) {
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  const { error } = await supabase.rpc('set_band_song_note', { p_song_id: song.id, p_note: value });
  buttons.forEach(button => { button.disabled = false; });
  if (error) {
    showNotice(error.message || '메모를 저장하지 못했습니다.', 'error');
    return;
  }
  song.note = value;
  await announceRealtimeChange('song_note', song.id);
  const input = form.querySelector('[data-song-note]');
  if (input) input.dataset.dirty = 'false';
  showNotice(value ? '메모를 저장했습니다.' : '메모를 지웠습니다.', 'success');
}

function closeModal(immediate = false) {
  const modal = host.querySelector('[data-band-modal]');
  if (!modal) return;
  if (immediate === true || !isMobileView()) { modal.remove(); return; }
  if (modal.classList.contains('is-closing')) return;
  modal.classList.add('is-closing');
  const panel = modal.querySelector('.band-modal-panel');
  const remove = () => modal.remove();
  panel?.addEventListener('animationend', remove, { once: true });
  window.setTimeout(remove, 260);
}

function openForm({ title, submitLabel, fields, onReady, onSubmit }) {
  closeModal(true);
  host.insertAdjacentHTML('beforeend', `<div class="band-modal" data-band-modal role="presentation"><section class="band-modal-panel" role="dialog" aria-modal="true" aria-labelledby="band-modal-title">
    <div class="band-modal-head"><h2 id="band-modal-title">${esc(title)}</h2><button type="button" data-modal-close aria-label="닫기">×</button></div>
    <form data-band-form><div class="band-form-grid">${fields}</div><p class="band-form-error" data-form-error></p><div class="band-form-actions"><button type="button" class="band-secondary" data-modal-close>취소</button><button type="submit" class="band-primary">${esc(submitLabel)}</button></div></form>
  </section></div>`);
  const modal = host.querySelector('[data-band-modal]');
  const form = modal.querySelector('form');
  onReady?.(form);
  modal.querySelectorAll('[data-modal-close]').forEach(button => button.addEventListener('click', closeModal));
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const errorEl = form.querySelector('[data-form-error]');
    submit.disabled = true;
    errorEl.textContent = '';
    try {
      await onSubmit(new FormData(form));
      closeModal();
    } catch (error) {
      errorEl.textContent = error?.message || '저장하지 못했습니다.';
      submit.disabled = false;
    }
  });
  window.setTimeout(() => form.querySelector('input')?.focus(), 0);
}

function commonApplicantFields() {
  return `<label><span>이름</span><input name="applicant_name" required maxlength="80" autocomplete="name"></label><label><span>학번</span><input name="student_id" required maxlength="40" inputmode="numeric" autocomplete="off"></label>`;
}

function openSongForm() {
  if (!round?.song_application_open) return;
  openForm({
    title: '곡 신청',
    submitLabel: '곡 등록',
    fields: `${commonApplicantFields()}<label><span>곡 제목</span><input name="title" required maxlength="200"></label><label><span>가수</span><input name="artist" required maxlength="200"></label><label class="band-field-wide"><span>필요 세션</span><input name="roles" placeholder="보컬, 기타2, 베이스, 드럼" autocomplete="off"><small>1명이면 세션 이름만, 여러 명이면 이름 뒤에 필요한 인원수를 적으세요. 예: 기타2</small></label><fieldset class="band-applicant-role band-field-wide"><legend>신청자가 맡을 세션</legend><input type="hidden" name="applicant_role"><div data-applicant-role-options><span>필요 세션을 먼저 입력하세요.</span></div><small>곡 신청자 본인이 맡을 세션을 선택하세요.</small></fieldset><label class="band-field-wide"><span>메모</span><textarea name="note" rows="3" maxlength="1000"></textarea></label>`,
    onReady: form => {
      const rolesInput = form.elements.roles;
      const roleInput = form.elements.applicant_role;
      const options = form.querySelector('[data-applicant-role-options]');
      const renderOptions = () => {
        const roles = [...new Set(parseWantedRoles(rolesInput.value).map(normalizeRole).filter(Boolean))];
        if (!roles.includes(roleInput.value)) roleInput.value = '';
        options.innerHTML = roles.length ? roles.map(role => `<button type="button" data-applicant-role="${esc(role)}" aria-pressed="${roleInput.value === role}">${esc(role)}</button>`).join('') : '<span>필요 세션을 먼저 입력하세요.</span>';
        options.querySelectorAll('[data-applicant-role]').forEach(button => button.addEventListener('click', () => {
          roleInput.value = button.dataset.applicantRole;
          options.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        }));
      };
      rolesInput.addEventListener('input', renderOptions);
      renderOptions();
    },
    onSubmit: async data => {
      const applicantRole = String(data.get('applicant_role') || '').trim();
      if (!applicantRole) throw new Error('곡 신청자가 맡을 세션을 선택해주세요.');
      const payload = { round_id: round.id, applicant_name: String(data.get('applicant_name')).trim(), student_id: String(data.get('student_id')).trim(), title: String(data.get('title')).trim(), artist: String(data.get('artist')).trim(), wanted_roles: [...parseWantedRoles(data.get('roles')), `${APPLICANT_ROLE_PREFIX}${applicantRole}`], note: String(data.get('note')).trim() };
      const { data: created, error } = await supabase.from('band_songs').insert(payload).select().single();
      if (error) throw error;
      selectedSongId = created.id;
      await announceRealtimeChange('song_created', created.id);
      await loadAndRender(false);
      showNotice('곡 신청이 등록되었습니다.', 'success');
    },
  });
}

function openMemberForm(song, preselectedRole = '') {
  if (!round?.session_application_open || isFixedSong(song)) return;
  const requirements = getRequirements(song);
  const counts = getRoleCounts(song);
  if (!requirements.length) {
    showNotice('이 곡에는 신청 가능한 세션이 등록되지 않았습니다.', 'error');
    return;
  }
  openForm({
    title: `${song.title} · 세션 신청`,
    submitLabel: '세션 등록',
    fields: `${commonApplicantFields()}<fieldset class="band-role-options band-field-wide"><legend>신청 세션</legend><div>${requirements.map(({ role, count }) => {
      const available = (counts.get(role) || 0) < count;
      return `<label><input type="checkbox" name="roles" value="${esc(role)}" ${role === preselectedRole ? 'checked' : ''}><span><b>${esc(role)}</b><em class="${available ? 'is-available' : ''}">${available ? '잔여석 있음' : '만석(대기열)'}</em></span></label>`;
    }).join('')}</div></fieldset>`,
    onSubmit: async data => {
      const selectedRoles = data.getAll('roles').map(value => String(value));
      if (!selectedRoles.length) throw new Error('신청할 세션을 하나 이상 선택해주세요.');
      const { error } = await supabase.from('band_members').insert({ song_id: song.id, applicant_name: String(data.get('applicant_name')).trim(), student_id: String(data.get('student_id')).trim(), roles: selectedRoles, note: '' });
      if (error) throw error;
      selectedSongId = song.id;
      await announceRealtimeChange('member_created', song.id);
      await loadAndRender(false);
      showNotice('세션 신청이 등록되었습니다.', 'success');
    },
  });
}

function renderShell() {
  if (round?.is_blinded) {
    host.innerHTML = `<main class="band-app band-is-blinded" data-realtime="${realtimeStatus}" data-realtime-events="${realtimeEventCount}"><div class="band-workspace"><section class="band-heading band-blind-heading"><div><span>합주 신청 시스템</span><label class="band-round-picker"><span class="sr-only">회차 선택</span><select data-band-round-select>${rounds.map(item => `<option value="${item.id}" ${item.id === round?.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label></div></section><div class="band-blind-message" role="status"><span aria-hidden="true">🙈</span><strong>관리자가 이 페이지를 가렸습니다.</strong></div></div></main>`;
    bindRoundPicker();
    return;
  }
  host.innerHTML = `<main class="band-app" data-realtime="${realtimeStatus}" data-realtime-events="${realtimeEventCount}"><div class="band-workspace"><section class="band-heading"><div><span>합주 신청 시스템</span><label class="band-round-picker"><span class="sr-only">회차 선택</span><select data-band-round-select>${rounds.map(item => `<option value="${item.id}" ${item.id === round?.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label></div><div class="band-heading-side"><div class="band-stats" data-band-stats></div><button class="band-primary" type="button" data-apply-song>+ 곡 신청</button></div></section>
    <section class="band-toolbar"><label class="band-search"><span aria-hidden="true">⌕</span><input type="search" data-band-search placeholder="곡, 사람, 세션 검색" autocomplete="off"></label><div class="band-filter-stack"><div class="band-segments" role="group" aria-label="결성 상태 필터"><button class="is-active" type="button" data-filter="all">전체</button><button type="button" data-filter="formed">결성</button><button type="button" data-filter="unformed">미결성</button></div><label class="band-hide-fixed"><input type="checkbox" data-hide-fixed ${hideFixedTeams ? 'checked' : ''}><span>고정 팀 숨기기</span></label></div><span class="band-result-count" data-band-result-count></span></section><div class="band-layout"><section class="band-list" data-band-list aria-label="곡 목록"></section><aside class="band-detail" data-band-detail aria-live="polite"></aside></div></div><div class="band-notice" data-band-notice role="status"></div></main>`;
  const songButton = host.querySelector('[data-apply-song]');
  songButton.disabled = !round?.song_application_open;
  songButton.textContent = round?.song_application_open ? '+ 곡 신청' : '곡 신청 닫힘';
  songButton.addEventListener('click', openSongForm);
  bindRoundPicker();
  host.querySelector('[data-band-search]').addEventListener('input', event => { searchQuery = event.target.value.trim(); renderList(); });
  host.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { statusFilter = button.dataset.filter; host.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('is-active', item === button)); renderList(); }));
  host.querySelector('[data-hide-fixed]').addEventListener('change', event => { hideFixedTeams = event.target.checked; selectedSongId = null; renderList(); });
}

function bindRoundPicker() {
  host.querySelector('[data-band-round-select]')?.addEventListener('change', event => {
    selectedSongId = null;
    round = rounds.find(item => item.id === Number(event.target.value)) || null;
    loadAndRender();
  });
}

function renderLoading() {
  host.innerHTML = '<main class="band-app band-loading"><img src="img/logo.png" alt=""><span>불러오는 중</span></main>';
}

function renderError(error) {
  host.innerHTML = `<main class="band-app band-error"><img src="img/logo.png" alt=""><h1>데이터를 불러오지 못했습니다</h1><p>${esc(error?.message || '잠시 후 다시 시도해주세요.')}</p><button type="button" data-band-retry>다시 시도</button></main>`;
  host.querySelector('[data-band-retry]').addEventListener('click', () => loadAndRender());
}

async function fetchBandData() {
  const preferredRoundId = round?.id;
  const { data: roundRows, error: roundError } = await supabase.from('band_rounds').select('*').order('sort_order').order('created_at', { ascending: false });
  if (roundError) throw roundError;
  rounds = roundRows || [];
  round = rounds.find(item => item.id === preferredRoundId) || rounds[0] || null;
  if (!round) { songs = []; membersBySong = new Map(); return; }
  const { data: songRows, error: songError } = await supabase.from('band_songs').select('*').eq('round_id', round.id).order('created_at').order('id');
  if (songError) throw songError;
  songs = songRows || [];
  let memberRows = [];
  if (songs.length) {
    const { data, error } = await supabase.from('band_members').select('*').in('song_id', songs.map(song => song.id)).order('created_at').order('id');
    if (error) throw error;
    memberRows = data || [];
  }
  membersBySong = new Map();
  for (const member of memberRows) {
    if (!membersBySong.has(member.song_id)) membersBySong.set(member.song_id, []);
    membersBySong.get(member.song_id).push(member);
  }
}

function captureRealtimeState() {
  const active = document.activeElement;
  const notes = [...host.querySelectorAll('[data-song-note]')]
    .filter(input => input === active || input.dataset.dirty === 'true')
    .map(input => ({
      id: input.id,
      value: input.value,
      dirty: input.dataset.dirty,
      active: input === active,
      start: input.selectionStart,
      end: input.selectionEnd,
    }));
  const scrolls = ['[data-band-list]', '[data-band-detail]', '[data-band-mobile-detail]', '.band-modal-panel']
    .map(selector => {
      const element = host.querySelector(selector);
      return element ? { selector, top: element.scrollTop, left: element.scrollLeft } : null;
    }).filter(Boolean);
  return { notes, scrolls, pageX: window.scrollX, pageY: window.scrollY };
}

function restoreRealtimeState(state) {
  for (const note of state.notes) {
    const input = document.getElementById(note.id);
    if (!input) continue;
    input.value = note.value;
    input.dataset.dirty = note.dirty;
    input.style.height = 'auto';
    input.style.height = `${Math.max(62, input.scrollHeight)}px`;
    if (note.active) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(note.start, note.end);
    }
  }
  for (const saved of state.scrolls) {
    const element = host.querySelector(saved.selector);
    if (element) { element.scrollTop = saved.top; element.scrollLeft = saved.left; }
  }
  window.scrollTo(state.pageX, state.pageY);
}

function syncRoundControls() {
  const select = host.querySelector('[data-band-round-select]');
  if (select) {
    select.innerHTML = rounds.map(item => `<option value="${item.id}" ${item.id === round?.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('');
  }
  const button = host.querySelector('[data-apply-song]');
  if (button) {
    button.disabled = !round?.song_application_open;
    button.textContent = round?.song_application_open ? '+ 곡 신청' : '곡 신청 닫힘';
  }
}

async function refreshFromRealtime() {
  if (destroyed || !host?.querySelector('.band-app')) return;
  const state = captureRealtimeState();
  try {
    await fetchBandData();
    if (destroyed) return;
    if (round?.is_blinded || !host.querySelector('[data-band-list]')) {
      renderShell();
      if (!round?.is_blinded) { renderStats(); renderList(); }
      restoreRealtimeState(state);
      return;
    }
    syncRoundControls();
    renderStats();
    renderList();
    const mobileDetail = host.querySelector('[data-band-mobile-detail]');
    if (mobileDetail) renderDetail(songs.find(song => song.id === selectedSongId) || null, mobileDetail);
    restoreRealtimeState(state);
  } catch (error) {
    if (!destroyed) showNotice(error?.message || '실시간 데이터를 갱신하지 못했습니다.', 'error');
  }
}

function scheduleRealtimeRefresh() {
  window.clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = window.setTimeout(refreshFromRealtime, 120);
}

function handleRealtimeChange() {
  realtimeEventCount += 1;
  const app = host?.querySelector('.band-app');
  if (app) app.dataset.realtimeEvents = String(realtimeEventCount);
  scheduleRealtimeRefresh();
}

async function announceRealtimeChange(scope, id = null) {
  const payload = { scope, id, source: 'band-public', sent_at: Date.now() };
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
      const app = host?.querySelector('.band-app');
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

async function loadAndRender(showLoading = true) {
  if (destroyed) return;
  if (showLoading) renderLoading();
  try {
    await fetchBandData();
    if (destroyed) return;
    renderShell();
    if (!round?.is_blinded) {
      renderStats();
      renderList();
    }
  } catch (error) {
    if (!destroyed) renderError(error);
  }
}

export async function init(container) {
  host = container;
  destroyed = false;
  round = null;
  songs = [];
  membersBySong = new Map();
  selectedSongId = null;
  searchQuery = '';
  statusFilter = 'all';
  realtimeStatus = 'idle';
  realtimeEventCount = 0;
  pendingRealtimeSignals = [];
  document.body.classList.add('band-mode');
  await loadAndRender();
  subscribeRealtime();
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
    document.body.classList.remove('band-mode');
    if (host) host.innerHTML = '';
    host = null;
  };
}
