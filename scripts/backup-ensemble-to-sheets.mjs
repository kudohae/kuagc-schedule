const SUPABASE_URL = requiredEnv('SUPABASE_URL').replace(/\/+$/, '');
const SUPABASE_KEY = requiredEnv('SUPABASE_ANON_KEY');
const APPS_SCRIPT_WEBAPP_URL = process.env.GOOGLE_SHEETS_WEBAPP_URL || '';
const APPS_SCRIPT_SHARED_SECRET = process.env.GOOGLE_SHEETS_WEBAPP_SECRET || '';
const DRY_RUN = process.env.BACKUP_DRY_RUN === '1';

const BACKUP_TABLES = [
  { name: 'ensemble_rounds', order: 'created_at.asc' },
  { name: 'song_applications', order: 'created_at.asc' },
  { name: 'session_applications', order: 'created_at.asc' },
  { name: 'manual_entries', order: 'round_id.asc,team_no.asc,sort_key.asc' },
];

const SHEET_COLUMNS = {
  backup_status: ['synced_at', 'source', 'round_count', 'song_count', 'session_count', 'manual_entry_count'],
  latest_song_status: [
    'round_id',
    'round_name',
    'round_type',
    'phase',
    'song_id',
    'song_title',
    'artist',
    'public_note',
    'applicant_name',
    'student_id',
    'needed_sessions',
    'filled_sessions',
    'pending_sessions',
    'created_at',
  ],
};

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
    await Promise.all(BACKUP_TABLES.map(async table => [table.name, await fetchSupabaseRows(table)]))
  );

  const syncedAt = new Date().toISOString();
  const sheets = [
    {
      title: 'backup_status',
      rows: [
        SHEET_COLUMNS.backup_status,
        [
          syncedAt,
          'Supabase KUAGC Schedule',
          tables.ensemble_rounds.length,
          tables.song_applications.length,
          tables.session_applications.length,
          tables.manual_entries.length,
        ],
      ],
    },
    ...BACKUP_TABLES.map(table => ({
      title: table.name,
      rows: rowsToSheetValues(tables[table.name]),
    })),
    {
      title: 'latest_song_status',
      rows: buildLatestSongStatusRows(tables),
    },
  ];

  const payload = {
    secret: APPS_SCRIPT_SHARED_SECRET,
    synced_at: syncedAt,
    source: 'kuagc-schedule',
    sheets,
  };

  if (DRY_RUN) {
    console.log(`Dry run built ${sheets.length} sheets from ${tables.song_applications.length} songs and ${tables.session_applications.length} session applications.`);
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

  console.log(`Backed up ${tables.song_applications.length} songs and ${tables.session_applications.length} session applications at ${syncedAt}.`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function fetchSupabaseRows({ name, order }) {
  const pageSize = 1000;
  const rows = [];

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const url = new URL(`${SUPABASE_URL}/rest/v1/${name}`);
    url.searchParams.set('select', '*');
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

function rowsToSheetValues(rows) {
  if (!rows.length) return [['id']];
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))].sort(sortHeaders);
  return [headers, ...rows.map(row => headers.map(header => stringifyCell(row[header])))];
}

function buildLatestSongStatusRows(tables) {
  const roundsById = new Map(tables.ensemble_rounds.map(round => [round.id, round]));
  const sessionBySongId = new Map();

  for (const application of tables.session_applications) {
    if (!sessionBySongId.has(application.song_id)) sessionBySongId.set(application.song_id, []);
    sessionBySongId.get(application.song_id).push(application);
  }

  const dataRows = tables.song_applications
    .filter(song => song.status !== 'rejected')
    .map(song => {
      const round = roundsById.get(song.round_id) || {};
      const applications = sessionBySongId.get(song.id) || [];
      const filledSessions = uniqueSorted(applications.filter(app => app.status === 'confirmed').flatMap(app => app.sessions || []));
      const pendingSessions = uniqueSorted(applications.filter(app => app.status !== 'rejected' && app.status !== 'confirmed').flatMap(app => app.sessions || []));

      return [
        song.round_id,
        round.name || '',
        round.type || '',
        round.phase || '',
        song.id,
        song.title || '',
        song.artist || '',
        song.public_note || '',
        song.applicant_name || '',
        song.student_id || '',
        (song.sessions || []).join(', '),
        filledSessions.join(', '),
        pendingSessions.join(', '),
        song.created_at || '',
      ];
    });

  return [SHEET_COLUMNS.latest_song_status, ...dataRows];
}

function stringifyCell(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function sortHeaders(a, b) {
  const preferred = ['id', 'round_id', 'song_id', 'type', 'name', 'phase', 'title', 'artist', 'public_note', 'applicant_name', 'student_id', 'sessions', 'status', 'created_at'];
  const ai = preferred.indexOf(a);
  const bi = preferred.indexOf(b);
  if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  return a.localeCompare(b);
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'ko'));
}
