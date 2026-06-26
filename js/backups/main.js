import { initTheme, toggleTheme } from '../utils/theme.js';
import { escapeHtml } from '../utils/html.js';

const BACKUP_URLS = [
  'data/backups/latest.json',
  'https://raw.githubusercontent.com/kudohae/kuagc-schedule/gh-pages/data/backups/latest.json',
];
const STALE_AFTER_MS = 30 * 60 * 1000;

const state = {
  backup: null,
  activeTab: 'overview',
  query: '',
};

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
  document.getElementById('reloadBtn')?.addEventListener('click', loadBackup);
  document.getElementById('backupSearch')?.addEventListener('input', event => {
    state.query = event.target.value.trim().toLowerCase();
    renderContent();
  });
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.addEventListener('click', () => {
      state.activeTab = button.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
      renderContent();
    });
  });
  loadBackup();
});

async function loadBackup() {
  setStatus('pending', '백업 파일 확인 중');
  content().innerHTML = '<div class="empty-state">백업 파일을 불러오고 있습니다.</div>';

  try {
    const loaded = await fetchBackupJson();
    state.backup = loaded.backup;
    const jsonLink = document.getElementById('jsonLink');
    if (jsonLink) jsonLink.href = loaded.url;
    renderSummary();
    renderContent();

    const age = Date.now() - Date.parse(state.backup.generated_at || 0);
    if (Number.isFinite(age) && age > STALE_AFTER_MS) {
      setStatus('stale', `최근 백업: ${relativeTime(state.backup.generated_at)}`);
    } else {
      setStatus('ok', `최근 백업: ${relativeTime(state.backup.generated_at)}`);
    }
  } catch (error) {
    state.backup = null;
    document.getElementById('summaryGrid').innerHTML = '';
    setStatus('err', '백업 파일을 읽지 못함');
    content().innerHTML = `
      <div class="error-box">
        백업 파일을 불러오지 못했습니다. 아직 자동 백업이 한 번도 배포되지 않았거나, 배포 중일 수 있습니다.<br>
        상세 오류: ${escapeHtml(error.message || error)}
      </div>
    `;
  }
}

async function fetchBackupJson() {
  const errors = [];
  for (const url of BACKUP_URLS) {
    try {
      const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return { backup: await response.json(), url };
    } catch (error) {
      errors.push(`${url}: ${error.message || error}`);
    }
  }
  throw new Error(errors.join(' / '));
}

function renderSummary() {
  const backup = state.backup;
  const counts = backup.counts || {};
  const totalApplications =
    Number(counts.time_applications || 0) +
    Number(counts.school_applications || 0) +
    Number(counts.song_applications || 0) +
    Number(counts.session_applications || 0);

  document.getElementById('summaryGrid').innerHTML = [
    summaryCard('백업 생성', formatDateTime(backup.generated_at), `${relativeTime(backup.generated_at)} 저장됨`),
    summaryCard('신청 기록', `${totalApplications.toLocaleString('ko-KR')}건`, '시간배정, 스쿨, 합주 신청 합계'),
    summaryCard('합주 데이터', `${counts.song_applications || 0}곡`, `세션 신청 ${counts.session_applications || 0}건`),
    summaryCard('저장 방식', '정적 JSON', 'DB가 비어도 마지막 배포 백업은 남음'),
  ].join('');
}

function renderContent() {
  if (!state.backup) return;
  if (state.activeTab === 'time') return renderTime();
  if (state.activeTab === 'school') return renderSchool();
  if (state.activeTab === 'ensemble') return renderEnsemble();
  return renderOverview();
}

function renderOverview() {
  const backup = state.backup;
  const events = collectEvents(backup).filter(matches).slice(0, 80);
  const sheets = backup.admin_sheets || [];

  content().innerHTML = `
    <div class="section-title">
      <div>
        <h2>최근 기록 흐름</h2>
        <p>백업 파일 안의 신청 기록을 최신순으로 합쳐 보여줍니다.</p>
      </div>
    </div>
    ${events.length ? `<div class="timeline">${events.map(renderEvent).join('')}</div>` : empty('검색 결과가 없습니다.')}
    <div class="section-title">
      <div>
        <h2>관리자 백업 탭</h2>
        <p>자동 백업 파일이 관리자 페이지의 백업 형식과 맞는지 확인하는 용도입니다.</p>
      </div>
    </div>
    <div class="sheet-grid">
      ${sheets
        .map(sheet => `
          <div class="sheet-card">
            <div class="sheet-name">${escapeHtml(sheet.title)}</div>
            <div class="sheet-rows">${Number(sheet.rows?.length || 0).toLocaleString('ko-KR')} rows</div>
          </div>
        `)
        .join('')}
    </div>
  `;
}

function renderTime() {
  const rounds = latestFirst(state.backup.time?.rounds || [], 'created_at').filter(round =>
    matches(round) || (round.applications || []).some(matches)
  );

  content().innerHTML = `
    <div class="section-title">
      <div>
        <h2>시간배정 신청</h2>
        <p>회차별 팀 신청 기록과 1, 2, 3순위 희망 시간을 확인합니다.</p>
      </div>
    </div>
    ${rounds.length ? rounds.map((round, index) => renderTimeRound(round, index)).join('') : empty('시간배정 기록이 없습니다.')}
  `;
}

function renderSchool() {
  const rounds = latestFirst(state.backup.school?.rounds || [], 'created_at').filter(round =>
    matches(round) || (round.schools || []).some(matches) || (round.applications || []).some(matches)
  );

  content().innerHTML = `
    <div class="section-title">
      <div>
        <h2>스쿨 신청</h2>
        <p>스쿨 회차, 개설 수업, 신청자 선호도와 배정 상태를 확인합니다.</p>
      </div>
    </div>
    ${rounds.length ? rounds.map((round, index) => renderSchoolRound(round, index)).join('') : empty('스쿨 기록이 없습니다.')}
  `;
}

function renderEnsemble() {
  const rounds = latestFirst(state.backup.ensemble?.rounds || [], 'created_at').filter(round =>
    matches(round) ||
    (round.songs || []).some(matches) ||
    (round.session_applications || []).some(matches) ||
    (round.manual_entries || []).some(matches)
  );

  content().innerHTML = `
    <div class="section-title">
      <div>
        <h2>합주 신청</h2>
        <p>곡 신청, 세션 신청, 공개 메모와 수동 편성 기록을 한 곳에서 확인합니다.</p>
      </div>
    </div>
    ${rounds.length ? rounds.map((round, index) => renderEnsembleRound(round, index)).join('') : empty('합주 기록이 없습니다.')}
  `;
}

function renderTimeRound(round, index) {
  const rows = (round.applications || []).filter(matches);
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
  const schoolRows = (round.schools || []).filter(matches);
  const applicationRows = (round.applications || []).filter(matches);
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
  const songRows = (round.songs || []).filter(matches);
  const sessionRows = (round.session_applications || []).filter(matches);
  const manualRows = (round.manual_entries || []).filter(matches);
  return roundCard(
    round,
    index,
    `${songRows.length}곡 / ${sessionRows.length}세션`,
    `
      <div class="subhead">곡 신청 <span class="subnote">${songRows.length}곡</span></div>
      ${table(
        ['신청 시각', '곡', '아티스트', '신청자', '학번', '필요 세션', '상태', '메모'],
        songRows.map(song => [
          formatDateTime(song.created_at),
          song.title || '—',
          song.artist || '—',
          song.applicant_name || '—',
          song.student_id || '—',
          joinList(song.sessions) || '—',
          song.status || '—',
          song.public_note || '—',
        ]),
        [7]
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
    <details class="round-card" ${index < 4 ? 'open' : ''}>
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
          ${rows
            .map(row => `
              <tr>
                ${row
                  .map((cell, index) => `<td class="${noteSet.has(index) ? 'note-cell' : ''}">${escapeHtml(cell || '—')}</td>`)
                  .join('')}
              </tr>
            `)
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function collectEvents(backup) {
  const events = [];
  for (const round of backup.time?.rounds || []) {
    for (const application of round.applications || []) {
      events.push({
        section: '시간배정',
        date: application.submitted_at,
        title: application.team_name_short || application.team_name || '팀 신청',
        meta: `${application.pref1 || '—'} / ${application.pref2 || '—'} / ${application.pref3 || '—'}`,
        data: application,
      });
    }
  }
  for (const round of backup.school?.rounds || []) {
    for (const application of round.applications || []) {
      events.push({
        section: '스쿨',
        date: application.created_at,
        title: `${application.applicant_name || '신청자'} · ${application.pref1_school || '—'}`,
        meta: `${application.student_id || '—'} / ${schoolStatus(application)}`,
        data: application,
      });
    }
  }
  for (const round of backup.ensemble?.rounds || []) {
    for (const song of round.songs || []) {
      events.push({
        section: '합주 곡',
        date: song.created_at,
        title: `${song.title || '곡'} - ${song.artist || '아티스트'}`,
        meta: `${song.applicant_name || '—'} / ${joinList(song.sessions) || '세션 미기록'}`,
        data: song,
      });
    }
    for (const application of round.session_applications || []) {
      events.push({
        section: '합주 세션',
        date: application.created_at,
        title: application.song_title || '세션 신청',
        meta: `${application.applicant_name || '—'} / ${joinList(application.sessions) || '—'} / ${application.session_round || 1}차`,
        data: application,
      });
    }
  }
  return events
    .filter(event => event.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function renderEvent(event) {
  return `
    <div class="event">
      <div class="event-top">
        <span class="chip">${escapeHtml(event.section)}</span>
        <span class="muted mono">${escapeHtml(formatDateTime(event.date))}</span>
      </div>
      <div class="event-title">${escapeHtml(event.title)}</div>
      <div class="event-meta">${escapeHtml(event.meta || '')}</div>
    </div>
  `;
}

function summaryCard(key, value, detail) {
  return `
    <div class="summary-card">
      <div class="summary-k">${escapeHtml(key)}</div>
      <div class="summary-v">${escapeHtml(value)}</div>
      <div class="summary-d">${escapeHtml(detail)}</div>
    </div>
  `;
}

function setStatus(kind, text) {
  const status = document.getElementById('backupStatus');
  status.innerHTML = `<span class="status-dot ${escapeHtml(kind)}"></span><span>${escapeHtml(text)}</span>`;
}

function matches(value) {
  if (!state.query) return true;
  return JSON.stringify(value || {}).toLowerCase().includes(state.query);
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

function relativeTime(value) {
  if (!value) return '시각 없음';
  const diff = Date.now() - Date.parse(value);
  if (!Number.isFinite(diff)) return '시각 오류';
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) return '방금 전';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.round(hours / 24)}일 전`;
}

function empty(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function content() {
  return document.getElementById('backupContent');
}
