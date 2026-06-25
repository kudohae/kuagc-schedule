const SUPABASE_URL = requiredEnv('SUPABASE_URL').replace(/\/+$/, '');
const SUPABASE_KEY = requiredEnv('SUPABASE_ANON_KEY');
const APPS_SCRIPT_WEBAPP_URL = process.env.GOOGLE_SHEETS_WEBAPP_URL || '';
const APPS_SCRIPT_SHARED_SECRET = process.env.GOOGLE_SHEETS_WEBAPP_SECRET || '';
const DRY_RUN = process.env.BACKUP_DRY_RUN === '1';

const COLORS = {
  green: '#D5E8D4',
  gray: '#E0E0E0',
  blue: '#DAE8FC',
};
const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
const TABLES = [
  { key: 'timeRounds', name: 'application_rounds', order: 'created_at.asc' },
  { key: 'timeApplications', name: 'time_applications', order: 'submitted_at.asc', select: '*,teams(name,info)' },
  { key: 'schoolRounds', name: 'school_rounds', order: 'created_at.asc' },
  { key: 'schoolApplications', name: 'school_applications', order: 'created_at.asc' },
  { key: 'schools', name: 'schools', select: 'id,name,round_id' },
  { key: 'ensembleRounds', name: 'ensemble_rounds', order: 'created_at.asc' },
  { key: 'songApplications', name: 'song_applications', order: 'created_at.asc' },
  { key: 'sessionApplications', name: 'session_applications', order: 'created_at.asc' },
];

main().catch(error => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});

async function main() {
  if (!DRY_RUN) {
    if (!APPS_SCRIPT_WEBAPP_URL) throw new Error('Missing required environment variable: GOOGLE_SHEETS_WEBAPP_URL');
    if (!APPS_SCRIPT_SHARED_SECRET) throw new Error('Missing required environment variable: GOOGLE_SHEETS_WEBAPP_SECRET');
  }

  const tables = Object.fromEntries(
    await Promise.all(TABLES.map(async table => [table.key, await fetchSupabaseRows(table)]))
  );
  const syncedAt = new Date().toISOString();
  const sheets = buildAdminBackupSheets(tables);
  const payload = {
    secret: APPS_SCRIPT_SHARED_SECRET,
    synced_at: syncedAt,
    source: 'kuagc-schedule',
    format: 'admin-backup',
    cleanup_sheet_titles: [
      'backup_status',
      'ensemble_rounds',
      'song_applications',
      'session_applications',
      'manual_entries',
      'latest_song_status',
    ],
    sheets,
  };

  if (DRY_RUN) {
    console.log(
      `Dry run built admin-format sheets: ${sheets.map(sheet => `${sheet.title} ${sheet.rows.length} rows`).join(', ')}.`
    );
    return;
  }

  const response = await fetch(APPS_SCRIPT_WEBAPP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Apps Script backup failed: ${response.status} ${await response.text()}`);
  }

  const resultText = await response.text();
  let result = {};
  try {
    result = resultText ? JSON.parse(resultText) : {};
  } catch {
    throw new Error(`Apps Script returned non-JSON response: ${resultText.slice(0, 200)}`);
  }

  if (result.ok !== true) {
    throw new Error(`Apps Script rejected backup: ${JSON.stringify(result)}`);
  }

  console.log(
    `Backed up admin-format sheets at ${syncedAt}: ${tables.timeApplications.length} time, ${tables.schoolApplications.length} school, ${tables.songApplications.length} songs, ${tables.sessionApplications.length} session applications.`
  );
}

function buildAdminBackupSheets(tables) {
  return [
    { title: '시간 신청', ...buildTimeSheet(tables) },
    { title: '스쿨 신청', ...buildSchoolSheet(tables) },
    { title: '합주 신청', ...buildEnsembleSheet(tables) },
  ];
}

function buildTimeSheet({ timeRounds, timeApplications }) {
  const rows = [];
  const backgrounds = [];
  const applicationsByRound = groupBy(timeApplications, application => application.round_id);

  for (const round of timeRounds || []) {
    const roundApplications = applicationsByRound.get(round.id) || [];
    if (roundApplications.length === 0 && !round.created_at) continue;

    pushMergedRow(rows, backgrounds, `${formatTimestamp(round.created_at)} 회차 시작`, 6, COLORS.green);
    for (const application of roundApplications) {
      pushRow(rows, backgrounds, [
        formatTimestamp(application.submitted_at) || '—',
        (application.teams?.name || '').replace(/팀$/, ''),
        application.teams?.info || '',
        dayStr(application.pref1_day, application.pref1_hour),
        application.pref2_day != null ? dayStr(application.pref2_day, application.pref2_hour) : '—',
        application.pref3_day != null ? dayStr(application.pref3_day, application.pref3_hour) : '—',
      ]);
    }
    pushMergedRow(
      rows,
      backgrounds,
      `${round.close_at ? formatTimestamp(round.close_at) : '(마감 일시 미기록)'} 회차 마감`,
      6,
      COLORS.gray
    );
  }

  return ensureRows(rows, backgrounds);
}

function buildSchoolSheet({ schoolRounds, schoolApplications, schools }) {
  const rows = [];
  const backgrounds = [];
  const schoolNameById = new Map((schools || []).map(school => [school.id, school.name]));
  const applicationsByRound = groupBy(schoolApplications, application => application.round_id);

  for (const round of schoolRounds || []) {
    const roundName = round.name || '스쿨 신청';
    const roundApplications = applicationsByRound.get(round.id) || [];
    if (roundApplications.length === 0 && !round.created_at) continue;

    pushMergedRow(rows, backgrounds, `${formatTimestamp(round.created_at)} '${roundName}' 시작`, 5, COLORS.green);
    for (const application of roundApplications) {
      pushRow(rows, backgrounds, [
        formatTimestamp(application.created_at) || '—',
        application.applicant_name || '',
        application.student_id || '',
        schoolNameById.get(application.pref1_school_id) || '—',
        application.pref2_school_id ? schoolNameById.get(application.pref2_school_id) || '—' : '—',
      ]);
    }
    pushMergedRow(
      rows,
      backgrounds,
      `${round.close_at ? formatTimestamp(round.close_at) : '(마감 일시 미기록)'} '${roundName}' 마감`,
      5,
      COLORS.gray
    );
  }

  return ensureRows(rows, backgrounds);
}

function buildEnsembleSheet({ ensembleRounds, songApplications, sessionApplications }) {
  const rows = [];
  const backgrounds = [];
  const songById = new Map((songApplications || []).map(song => [song.id, song]));
  const songsByRound = groupBy(songApplications, song => song.round_id);
  const sessionApplicationsBySong = groupBy(sessionApplications, application => application.song_id);
  const sessionApplicationsByRound = groupBy(sessionApplications, application => application.round_id);

  for (const type of ['regular', 'busking']) {
    for (const round of (ensembleRounds || []).filter(item => item.type === type)) {
      const typeName = type === 'regular' ? '일반합주' : '버스킹합주';
      const roundName = round.name || typeName;
      const roundSongs = (songsByRound.get(round.id) || []).filter(song => song.status !== 'rejected');
      const roundSession1 = (sessionApplicationsByRound.get(round.id) || []).filter(
        application => (application.session_round || 1) === 1
      );
      const roundSession2 = round.has_session2
        ? (sessionApplicationsByRound.get(round.id) || []).filter(application => (application.session_round || 1) === 2)
        : [];

      if (roundSongs.length === 0 && roundSession1.length === 0 && roundSession2.length === 0 && !round.created_at) continue;

      pushMergedRow(rows, backgrounds, `${formatTimestamp(round.created_at)} '${roundName}' 시작`, 7, COLORS.green);

      pushMergedRow(rows, backgrounds, '[곡 신청]', 7, COLORS.blue);
      for (const song of roundSongs) {
        const ownSessionApplication = (sessionApplicationsBySong.get(song.id) || []).find(
          application => application.student_id === song.student_id && (application.session_round || 1) === 1
        );
        pushRow(rows, backgrounds, [
          formatTimestamp(song.created_at) || '—',
          song.title || '',
          song.artist || '',
          song.applicant_name || '',
          song.student_id || '',
          joinArray(song.sessions),
          joinArray(ownSessionApplication?.sessions),
        ]);
      }
      pushMergedRow(
        rows,
        backgrounds,
        `${round.song_close_at ? formatTimestamp(round.song_close_at) : '(미기록)'} '${roundName}' 곡 신청 마감`,
        7,
        COLORS.gray
      );

      pushMergedRow(rows, backgrounds, '[세션 신청]', 7, COLORS.blue);
      for (const application of roundSession1) {
        const song = songById.get(application.song_id);
        pushRow(rows, backgrounds, [
          formatTimestamp(application.created_at) || '—',
          song?.title || '—',
          song?.artist || '—',
          application.applicant_name || '',
          application.student_id || '',
          joinArray(application.sessions),
          '1차',
        ]);
      }
      pushMergedRow(
        rows,
        backgrounds,
        `${round.session_close_at ? formatTimestamp(round.session_close_at) : '(미기록)'} '${roundName}' 세션 신청 마감`,
        7,
        COLORS.gray
      );

      if (round.has_session2) {
        pushMergedRow(rows, backgrounds, '[세션 2차 신청]', 7, COLORS.blue);
        for (const application of roundSession2) {
          const song = songById.get(application.song_id);
          pushRow(rows, backgrounds, [
            formatTimestamp(application.created_at) || '—',
            song?.title || '—',
            song?.artist || '—',
            application.applicant_name || '',
            application.student_id || '',
            joinArray(application.sessions),
            '2차',
          ]);
        }
        pushMergedRow(
          rows,
          backgrounds,
          `${round.session2_close_at ? formatTimestamp(round.session2_close_at) : '(미기록)'} '${roundName}' 2차 세션 신청 마감`,
          7,
          COLORS.gray
        );
      }
    }
  }

  return ensureRows(rows, backgrounds);
}

function ensureRows(rows, backgrounds) {
  if (rows.length > 0) return { rows, backgrounds };
  return {
    rows: [['데이터 없음']],
    backgrounds: [[null]],
  };
}

function pushMergedRow(rows, backgrounds, text, width, color) {
  rows.push([text || '', ...Array(width - 1).fill('')]);
  backgrounds.push(Array(width).fill(color || null));
}

function pushRow(rows, backgrounds, values) {
  rows.push(values.map(value => stringifyCell(value)));
  backgrounds.push(values.map(() => null));
}

function dayStr(day, hour) {
  return day != null ? `${DAYS[day] || day} ${hour ?? ''}`.trim() : '—';
}

function formatTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  return `${Number(parts.year)}년 ${Number(parts.month)}월 ${Number(parts.day)}일 ${Number(parts.hour)}시 ${parts.minute}분 ${parts.second}초`;
}

function joinArray(value) {
  return Array.isArray(value) ? value.join(', ') : '';
}

function groupBy(rows, getKey) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = getKey(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

function stringifyCell(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function fetchSupabaseRows({ name, order, select = '*' }) {
  const pageSize = 1000;
  const rows = [];

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const url = new URL(`${SUPABASE_URL}/rest/v1/${name}`);
    url.searchParams.set('select', select);
    if (order) url.searchParams.set('order', order);

    const response = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Range: `${from}-${to}`,
        Prefer: 'count=exact',
      },
    });

    if (!response.ok) {
      throw new Error(`Supabase ${name} fetch failed: ${response.status} ${await response.text()}`);
    }

    const batch = await response.json();
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}
