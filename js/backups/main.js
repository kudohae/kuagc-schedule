import { initTheme, toggleTheme } from '../utils/theme.js';
import { escapeHtml } from '../utils/html.js';
import { supabase } from '../supabase.js';

const BACKUP_URLS = [
  'data/backups/latest.json',
  'https://raw.githubusercontent.com/kudohae/kuagc-schedule/gh-pages/data/backups/latest.json',
];
const BACKUP_INDEX_URLS = [
  'data/backups/index.json',
  'https://raw.githubusercontent.com/kudohae/kuagc-schedule/gh-pages/data/backups/index.json',
];
const RAW_BACKUP_BASE = 'https://raw.githubusercontent.com/kudohae/kuagc-schedule/gh-pages/';
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

const state = {
  backup: null,
  backupUrl: '',
  index: [],
  indexBaseUrl: '',
  selectedAt: '',
  activeTab: 'overview',
  query: '',
};

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
  document.getElementById('reloadBtn')?.addEventListener('click', loadBackup);
  document.getElementById('compareBtn')?.addEventListener('click', compareWithLiveData);
  document.getElementById('snapshotAt')?.addEventListener('change', event => {
    loadSnapshotForTime(event.target.value);
  });
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
    await loadBackupIndex();
    const loaded = await fetchBackupJson();
    state.backup = loaded.backup;
    state.backupUrl = loaded.url;
    state.selectedAt = '';
    const snapshotInput = document.getElementById('snapshotAt');
    if (snapshotInput) snapshotInput.value = '';
    const jsonLink = document.getElementById('jsonLink');
    if (jsonLink) jsonLink.href = loaded.url;
    updateSnapshotNote();
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

async function loadBackupIndex() {
  try {
    const loaded = await fetchJsonFromUrls(BACKUP_INDEX_URLS);
    state.index = Array.isArray(loaded.data) ? loaded.data : [];
    state.indexBaseUrl = loaded.url.replace(/data\/backups\/index\.json(?:\?.*)?$/, '');
  } catch {
    state.index = [];
    state.indexBaseUrl = '';
  }
}

async function fetchBackupJson() {
  const loaded = await fetchJsonFromUrls(BACKUP_URLS);
  return { backup: loaded.data, url: loaded.url };
}

async function fetchJsonFromUrls(urls) {
  const errors = [];
  for (const url of urls) {
    try {
      const response = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return { data: await response.json(), url };
    } catch (error) {
      errors.push(`${url}: ${error.message || error}`);
    }
  }
  throw new Error(errors.join(' / '));
}

async function loadSnapshotForTime(localValue) {
  if (!localValue) return loadBackup();
  if (!state.index.length) await loadBackupIndex();
  if (!state.index.length) {
    toastLike('시점별 백업 목록을 찾을 수 없습니다.');
    return;
  }

  const selectedTime = new Date(localValue).getTime();
  const snapshots = [...state.index]
    .filter(item => item?.generated_at && item?.path)
    .sort((a, b) => Date.parse(a.generated_at) - Date.parse(b.generated_at));
  const target = snapshots.filter(item => Date.parse(item.generated_at) <= selectedTime).pop() || snapshots[0];
  const url = resolveBackupPath(target.path);

  setStatus('pending', '선택 시점 백업 확인 중');
  try {
    const loaded = await fetchJsonFromUrls([url]);
    state.backup = loaded.data;
    state.backupUrl = loaded.url;
    state.selectedAt = localValue;
    const jsonLink = document.getElementById('jsonLink');
    if (jsonLink) jsonLink.href = loaded.url;
    updateSnapshotNote();
    renderSummary();
    renderContent();
    setStatus('ok', `표시 중: ${formatDateTime(state.backup.generated_at)}`);
  } catch (error) {
    setStatus('err', '선택 백업을 읽지 못함');
    content().innerHTML = `<div class="error-box">선택한 시점의 백업을 불러오지 못했습니다.<br>${escapeHtml(error.message || error)}</div>`;
  }
}

function resolveBackupPath(path) {
  if (/^https?:\/\//.test(path)) return path;
  if (state.indexBaseUrl) return `${state.indexBaseUrl}${path}`;
  return `${RAW_BACKUP_BASE}${path}`;
}

function updateSnapshotNote() {
  const note = document.getElementById('snapshotNote');
  if (!note || !state.backup) return;
  const selectedText = state.selectedAt ? `선택 시점 ${formatDateTime(new Date(state.selectedAt).toISOString())}` : '최신 백업';
  note.textContent = `${selectedText} · 표시 백업 ${formatDateTime(state.backup.generated_at)} 기준`;
}

function toastLike(message) {
  content().insertAdjacentHTML('afterbegin', `<div class="error-box">${escapeHtml(message)}</div>`);
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

async function compareWithLiveData() {
  if (!state.backup) return;
  const popup = window.open('', '_blank', 'width=1100,height=760');
  if (!popup) {
    alert('팝업이 차단되었습니다. 팝업을 허용한 뒤 다시 눌러주세요.');
    return;
  }
  popup.document.write(buildCompareShell('실시간 데이터를 불러오는 중입니다.'));
  popup.document.close();

  try {
    const live = await fetchLiveRows();
    const diff = buildDiff(state.backup, live);
    popup.document.open();
    popup.document.write(renderComparePopup(diff));
    popup.document.close();
  } catch (error) {
    popup.document.open();
    popup.document.write(buildCompareShell(`대조 실패: ${escapeHtml(error.message || error)}`));
    popup.document.close();
  }
}

async function fetchLiveRows() {
  const specs = [
    ['timeRounds', 'application_rounds', '*', 'created_at'],
    ['timeApplications', 'time_applications', '*,teams(name,info)', 'submitted_at'],
    ['schoolRounds', 'school_rounds', '*', 'created_at'],
    ['schoolApplications', 'school_applications', '*', 'created_at'],
    ['schools', 'schools', '*', 'created_at'],
    ['ensembleRounds', 'ensemble_rounds', '*', 'created_at'],
    ['songApplications', 'song_applications', '*', 'created_at'],
    ['sessionApplications', 'session_applications', '*', 'created_at'],
    ['manualEntries', 'manual_entries', '*', 'sort_key'],
  ];
  const entries = await Promise.all(
    specs.map(async ([key, table, select, order]) => [key, await fetchSupabaseRows(table, select, order)])
  );
  return Object.fromEntries(entries);
}

async function fetchSupabaseRows(table, select, order) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    let query = supabase.from(table).select(select).range(from, to);
    if (order) query = query.order(order, { ascending: true });
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

function buildDiff(backup, live) {
  const specs = [
    ['timeRounds', '시간 회차', backup.time?.rounds?.map(row => row.raw) || [], live.timeRounds],
    ['timeApplications', '시간배정 신청', (backup.time?.rounds || []).flatMap(round => round.applications || []).map(row => row.raw), live.timeApplications],
    ['schoolRounds', '스쿨 회차', backup.school?.rounds?.map(row => row.raw) || [], live.schoolRounds],
    ['schools', '스쿨 반', (backup.school?.rounds || []).flatMap(round => round.schools || []).map(row => row.raw), live.schools],
    ['schoolApplications', '스쿨 신청', (backup.school?.rounds || []).flatMap(round => round.applications || []).map(row => row.raw), live.schoolApplications],
    ['ensembleRounds', '합주 회차', backup.ensemble?.rounds?.map(row => row.raw) || [], live.ensembleRounds],
    ['songApplications', '합주 곡 신청', (backup.ensemble?.rounds || []).flatMap(round => round.songs || []).map(row => row.raw), live.songApplications],
    ['sessionApplications', '합주 세션 신청', (backup.ensemble?.rounds || []).flatMap(round => round.session_applications || []).map(row => row.raw), live.sessionApplications],
    ['manualEntries', '수동 편성', (backup.ensemble?.rounds || []).flatMap(round => round.manual_entries || []).map(row => row.raw), live.manualEntries],
  ];

  const sections = specs.map(([key, label, backupRows, liveRows]) => compareRows(key, label, backupRows, liveRows || []));
  return {
    generatedAt: backup.generated_at,
    selectedAt: state.selectedAt,
    comparedAt: new Date().toISOString(),
    sections,
    totals: sections.reduce(
      (acc, section) => ({
        added: acc.added + section.added.length,
        removed: acc.removed + section.removed.length,
        changed: acc.changed + section.changed.length,
      }),
      { added: 0, removed: 0, changed: 0 }
    ),
  };
}

function compareRows(key, label, backupRows, liveRows) {
  const backupMap = new Map((backupRows || []).filter(Boolean).map(row => [rowKey(row), row]));
  const liveMap = new Map((liveRows || []).filter(Boolean).map(row => [rowKey(row), row]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, row] of liveMap.entries()) {
    if (!backupMap.has(id)) added.push({ id, row });
    else {
      const before = normalizeRow(backupMap.get(id));
      const after = normalizeRow(row);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changed.push({ id, before: backupMap.get(id), after: row, fields: changedFields(before, after) });
      }
    }
  }
  for (const [id, row] of backupMap.entries()) {
    if (!liveMap.has(id)) removed.push({ id, row });
  }

  return { key, label, backupCount: backupMap.size, liveCount: liveMap.size, added, removed, changed };
}

function rowKey(row) {
  return String(row?.id ?? `${row?.round_id || ''}:${row?.team_no || ''}:${row?.sort_key || ''}:${JSON.stringify(row)}`);
}

function normalizeRow(row) {
  return sortObject(stripVolatile(row || {}));
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== 'object') return value;
  const next = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === '__rowNum__') continue;
    next[key] = stripVolatile(val);
  }
  return next;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortObject(value[key])]));
}

function changedFields(before, after) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
  return keys.filter(key => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
}

function renderComparePopup(diff) {
  const total = diff.totals.added + diff.totals.removed + diff.totals.changed;
  const sections = diff.sections.filter(section => section.added.length || section.removed.length || section.changed.length);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>실시간 데이터 대조</title>
${comparePopupStyle()}
</head>
<body>
  <main>
    <h1>실시간 데이터 대조</h1>
    <p class="meta">백업 기준: ${escapeHtml(formatDateTime(diff.generatedAt))} · 대조 시각: ${escapeHtml(formatDateTime(diff.comparedAt))}</p>
    <div class="summary">
      <div><b>${total}</b><span>전체 차이</span></div>
      <div><b>${diff.totals.added}</b><span>현재에만 있음</span></div>
      <div><b>${diff.totals.removed}</b><span>백업에만 있음</span></div>
      <div><b>${diff.totals.changed}</b><span>내용 변경</span></div>
    </div>
    ${sections.length ? sections.map(renderDiffSection).join('') : '<section class="ok">차이점이 없습니다.</section>'}
  </main>
</body>
</html>`;
}

function buildCompareShell(message) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>실시간 데이터 대조</title>${comparePopupStyle()}</head><body><main><h1>실시간 데이터 대조</h1><section class="ok">${message}</section></main></body></html>`;
}

function renderDiffSection(section) {
  return `<section>
    <h2>${escapeHtml(section.label)}</h2>
    <p class="meta">백업 ${section.backupCount}개 · 현재 ${section.liveCount}개</p>
    ${renderDiffGroup('현재에만 있음', section.added, item => summarizeRow(item.row))}
    ${renderDiffGroup('백업에만 있음', section.removed, item => summarizeRow(item.row))}
    ${renderDiffGroup('내용 변경', section.changed, item => `${summarizeRow(item.after)}<br><small>변경 필드: ${escapeHtml(item.fields.join(', ') || '알 수 없음')}</small>`)}
  </section>`;
}

function renderDiffGroup(title, items, render) {
  if (!items.length) return '';
  return `<h3>${escapeHtml(title)} ${items.length}건</h3>
    <div class="table-wrap"><table><tbody>
      ${items.slice(0, 200).map(item => `<tr><td>${render(item)}</td></tr>`).join('')}
    </tbody></table></div>
    ${items.length > 200 ? `<p class="meta">처음 200건만 표시했습니다.</p>` : ''}`;
}

function summarizeRow(row) {
  const primary = row?.title || row?.name || row?.applicant_name || row?.song_name || row?.team_name || `ID ${row?.id || '—'}`;
  const secondary = [
    row?.artist,
    row?.student_id,
    row?.round_id ? `round ${row.round_id}` : '',
    row?.status,
    row?.created_at ? formatDateTime(row.created_at) : '',
    row?.submitted_at ? formatDateTime(row.submitted_at) : '',
  ].filter(Boolean).join(' · ');
  return `<b>${escapeHtml(primary)}</b>${secondary ? `<br><small>${escapeHtml(secondary)}</small>` : ''}`;
}

function comparePopupStyle() {
  return `<style>
    body{margin:0;background:#f4f4f5;color:#111;font-family:Arial,'Noto Sans KR',sans-serif;font-size:14px}
    main{max-width:1040px;margin:0 auto;padding:24px}
    h1{font-size:24px;margin:0 0 8px} h2{font-size:18px;margin:24px 0 4px} h3{font-size:14px;margin:16px 0 8px}
    .meta{color:#666;font-size:12px;margin:0 0 12px}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}
    .summary div,.ok,section{background:#fff;border:1px solid #ddd;border-radius:8px;padding:14px}.summary b{display:block;font-size:24px}.summary span{color:#666;font-size:12px}
    section{margin-top:12px}.table-wrap{border:1px solid #ddd;border-radius:6px;overflow:auto;background:#fff}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #eee;padding:8px 10px;line-height:1.45}tr:last-child td{border-bottom:0}small{color:#666}
  </style>`;
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
