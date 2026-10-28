import { initTheme, toggleTheme } from '../utils/theme.js';
import { escapeHtml } from '../utils/html.js';

const INDEX_URLS = [
  { url: 'data/backups/index.json', base: '' },
  { url: 'https://raw.githubusercontent.com/kudohae/kuagc-schedule/gh-pages/data/backups/index.json', base: 'https://raw.githubusercontent.com/kudohae/kuagc-schedule/gh-pages/' },
];

const state = {
  backups: [],
  indexBase: '',
  selectedPath: '',
  selectedBackup: null,
};

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
  loadBackupIndex();
});

async function loadBackupIndex() {
  list().innerHTML = '<div class="empty-state">백업 목록을 불러오고 있습니다.</div>';
  content().innerHTML = '<div class="empty-state">확인할 백업을 선택하세요.</div>';

  try {
    const loaded = await fetchBackupIndex();
    state.backups = latestFirst(loaded.index, 'generated_at');
    state.indexBase = loaded.base;
    renderBackupList();

    if (state.backups.length > 0) {
      await selectBackup(state.backups[0].path);
    } else {
      content().innerHTML = '<div class="empty-state">저장된 백업 파일이 없습니다.</div>';
    }
  } catch (error) {
    state.backups = [];
    list().innerHTML = `
      <div class="error-box">
        백업 목록을 불러오지 못했습니다.<br>
        상세 오류: ${escapeHtml(error.message || error)}
      </div>
    `;
  }
}

async function fetchBackupIndex() {
  const errors = [];
  for (const candidate of INDEX_URLS) {
    try {
      const response = await fetch(`${candidate.url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return { index: await response.json(), base: candidate.base };
    } catch (error) {
      errors.push(`${candidate.url}: ${error.message || error}`);
    }
  }
  throw new Error(errors.join(' / '));
}

function renderBackupList() {
  if (!state.backups.length) {
    list().innerHTML = '<div class="empty-state">저장된 백업 파일이 없습니다.</div>';
    return;
  }

  list().innerHTML = state.backups.map(backup => `
    <button
      class="backup-item ${backup.path === state.selectedPath ? 'active' : ''}"
      type="button"
      data-path="${escapeHtml(backup.path)}"
    >
      ${escapeHtml(formatDateTimePlain(backup.generated_at))}의 데이터 백업
    </button>
  `).join('');

  list().querySelectorAll('.backup-item').forEach(button => {
    button.addEventListener('click', () => selectBackup(button.dataset.path));
  });
}

async function selectBackup(path) {
  const entry = state.backups.find(backup => backup.path === path);
  if (!entry) return;

  state.selectedPath = path;
  renderBackupList();
  content().innerHTML = `<div class="empty-state">${escapeHtml(formatDateTimePlain(entry.generated_at))} 백업을 불러오고 있습니다.</div>`;

  try {
    const backup = await fetchBackupSnapshot(entry.path);
    state.selectedBackup = backup;
    renderSelectedBackup(backup);
  } catch (error) {
    state.selectedBackup = null;
    content().innerHTML = `
      <div class="error-box">
        선택한 백업 파일을 불러오지 못했습니다.<br>
        상세 오류: ${escapeHtml(error.message || error)}
      </div>
    `;
  }
}

async function fetchBackupSnapshot(path) {
  const url = state.indexBase ? `${state.indexBase}${path}` : path;
  const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function renderSelectedBackup(backup) {
  content().innerHTML = `
    <div class="selected-title">
      <h2>${escapeHtml(formatDateTimePlain(backup.generated_at))}의 데이터 백업</h2>
    </div>
    ${renderTime()}
    ${renderSchool()}
    ${renderEnsemble()}
    ${renderAdminSheets(backup.admin_sheets || [])}
  `;
}

function renderTime() {
  const rounds = latestFirst(state.selectedBackup.time?.rounds || [], 'created_at');
  return `
    <section class="backup-section">
      <div class="section-title">
        <h3>시간배정 신청</h3>
      </div>
      ${rounds.length ? rounds.map((round, index) => renderTimeRound(round, index)).join('') : empty('시간배정 기록이 없습니다.')}
    </section>
  `;
}

function renderSchool() {
  const rounds = latestFirst(state.selectedBackup.school?.rounds || [], 'created_at');
  return `
    <section class="backup-section">
      <div class="section-title">
        <h3>스쿨 신청</h3>
      </div>
      ${rounds.length ? rounds.map((round, index) => renderSchoolRound(round, index)).join('') : empty('스쿨 기록이 없습니다.')}
    </section>
  `;
}

function renderEnsemble() {
  const rounds = latestFirst(state.selectedBackup.ensemble?.rounds || [], 'created_at');
  return `
    <section class="backup-section">
      <div class="section-title">
        <h3>합주 신청</h3>
      </div>
      ${rounds.length ? rounds.map((round, index) => renderEnsembleRound(round, index)).join('') : empty('합주 기록이 없습니다.')}
    </section>
  `;
}

function renderAdminSheets(sheets) {
  if (!sheets.length) return '';
  return `
    <section class="backup-section">
      <div class="section-title">
        <h3>관리자 백업 탭</h3>
      </div>
      <div class="sheet-grid">
        ${sheets.map(sheet => `
          <div class="sheet-card">
            <div class="sheet-name">${escapeHtml(sheet.title)}</div>
            <div class="sheet-rows">${Number(sheet.rows?.length || 0).toLocaleString('ko-KR')} rows</div>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function renderTimeRound(round, index) {
  const rows = round.applications || [];
  return roundCard(
    round,
    index,
    `${rows.length}건`,
    table(
      ['제출 시각', '팀', '팀 정보', '1순위', '2순위', '3순위'],
      rows.map(application => [
        formatDateTime(application.submitted_at),
        application.team_name_short || application.team_name || '—',
        application.team_info || '—',
        application.pref1 || '—',
        application.pref2 || '—',
        application.pref3 || '—',
      ])
    )
  );
}

function renderSchoolRound(round, index) {
  const schoolRows = round.schools || [];
  const applicationRows = round.applications || [];
  return roundCard(
    round,
    index,
    `${applicationRows.length}건`,
    `
      <div class="subhead">개설 스쿨 <span class="subnote">${schoolRows.length}개</span></div>
      ${table(
        ['스쿨', '강사', '정원', '시간', '설명'],
        schoolRows.map(school => [
          school.name || '—',
          school.teacher_name || '—',
          school.capacity || '—',
          school.schedule || '—',
          school.description || '—',
        ])
      )}
      <div class="subhead">신청자 <span class="subnote">${applicationRows.length}명</span></div>
      ${table(
        ['신청 시각', '이름', '학번', '1순위', '2순위', '배정', '상태'],
        applicationRows.map(application => [
          formatDateTime(application.created_at),
          application.applicant_name || '—',
          application.student_id || '—',
          application.pref1_school || '—',
          application.pref2_school || '—',
          application.assigned_school || '—',
          schoolStatus(application),
        ])
      )}
    `
  );
}

function renderEnsembleRound(round, index) {
  const songRows = round.songs || [];
  const sessionRows = round.session_applications || [];
  const manualRows = round.manual_entries || [];
  return roundCard(
    round,
    index,
    `${songRows.length}곡 / ${sessionRows.length}세션`,
    `
      <div class="subhead">곡 신청 <span class="subnote">${songRows.length}곡</span></div>
      ${table(
        ['신청 시각', '곡', '아티스트', '신청자', '학번', '필요 세션', '상태', '결성 여부', '메모'],
        songRows.map(song => [
          formatDateTime(song.created_at),
          song.title || '—',
          song.artist || '—',
          song.applicant_name || '—',
          song.student_id || '—',
          joinList(song.sessions) || '—',
          song.status || '—',
          song.is_formed || '—',
          song.public_note || '—',
        ]),
        [8]
      )}
      <div class="subhead">세션 신청 <span class="subnote">${sessionRows.length}건</span></div>
      ${table(
        ['신청 시각', '곡', '아티스트', '신청자', '학번', '세션', '차수', '상태'],
        sessionRows.map(application => [
          formatDateTime(application.created_at),
          application.song_title || '—',
          application.artist || '—',
          application.applicant_name || '—',
          application.student_id || '—',
          joinList(application.sessions) || '—',
          `${application.session_round || 1}차`,
          application.status || '—',
        ])
      )}
      <div class="subhead">수동 편성 기록 <span class="subnote">${manualRows.length}줄</span></div>
      ${table(
        ['팀', '곡', '아티스트', '세션', '멤버'],
        manualRows.map(entry => [
          entry.team_no || '—',
          entry.song_name || '—',
          entry.artist_name || '—',
          entry.session_name || '—',
          entry.member_name || '—',
        ])
      )}
    `
  );
}

function roundCard(round, index, countLabel, body) {
  const dates = [
    round.created_at ? `시작 ${formatDateTime(round.created_at)}` : '',
    round.open_at ? `오픈 ${formatDateTime(round.open_at)}` : '',
    round.close_at ? `마감 ${formatDateTime(round.close_at)}` : '',
    round.song_close_at ? `곡 마감 ${formatDateTime(round.song_close_at)}` : '',
    round.session_close_at ? `세션 마감 ${formatDateTime(round.session_close_at)}` : '',
    round.session2_close_at ? `2차 마감 ${formatDateTime(round.session2_close_at)}` : '',
  ].filter(Boolean);
  const meta = [
    round.type ? typeLabel(round.type) : '',
    round.phase ? `단계 ${phaseLabel(round.phase)}` : '',
    round.status ? `상태 ${round.status}` : '',
    ...dates,
  ].filter(Boolean);

  return `
    <details class="round-card" ${index < 2 ? 'open' : ''}>
      <summary>
        <div class="round-main">
          <div class="round-name">${escapeHtml(round.name || '이름 없는 회차')}</div>
          <div class="round-meta">${meta.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</div>
        </div>
        <div class="round-count">${escapeHtml(countLabel)}</div>
      </summary>
      <div class="round-body">${body}</div>
    </details>
  `;
}

function table(headers, rows, noteColumns = []) {
  if (!rows.length) return '<div class="empty-state">표시할 행이 없습니다.</div>';
  const noteSet = new Set(noteColumns);
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              ${row.map((cell, index) => `<td class="${noteSet.has(index) ? 'note-cell' : ''}">${escapeHtml(cell || '—')}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function latestFirst(rows, field) {
  return [...rows].sort((a, b) => new Date(b[field] || 0) - new Date(a[field] || 0));
}

function schoolStatus(application) {
  if (application.assigned_school) return `배정: ${application.assigned_school}`;
  if (application.status === 'pending') return '대기';
  if (application.status === 'assigned') return '배정됨';
  if (application.status === 'unassigned') return '미배정';
  return application.status || '—';
}

function typeLabel(type) {
  if (type === 'regular') return '일반합주';
  if (type === 'busking') return '버스킹합주';
  return type;
}

function phaseLabel(phase) {
  const labels = {
    draft: '준비',
    song: '곡 신청',
    song_end: '곡 신청 마감',
    session: '세션 신청',
    session_end: '세션 신청 마감',
    session2: '세션 2차 신청',
    session2_end: '세션 2차 신청 마감',
    closed: '종료',
  };
  return labels[phase] || phase;
}

function joinList(value) {
  return Array.isArray(value) ? value.join(', ') : value || '';
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDateTimePlain(value) {
  if (!value) return '시각 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '시각 오류';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second}`;
}

function empty(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function list() {
  return document.getElementById('backupList');
}

function content() {
  return document.getElementById('backupContent');
}
