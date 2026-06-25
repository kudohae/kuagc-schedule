import crypto from 'node:crypto';

const SUPABASE_URL = requiredEnv('SUPABASE_URL').replace(/\/+$/, '');
const SUPABASE_KEY = requiredEnv('SUPABASE_ANON_KEY');
const GOOGLE_SHEET_ID = requiredEnv('GOOGLE_SHEET_ID');
const GOOGLE_SERVICE_ACCOUNT_JSON = requiredEnv('GOOGLE_SERVICE_ACCOUNT_JSON');

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
  const accessToken = await getGoogleAccessToken(parseServiceAccount(GOOGLE_SERVICE_ACCOUNT_JSON));
  const tables = Object.fromEntries(
    await Promise.all(BACKUP_TABLES.map(async table => [table.name, await fetchSupabaseRows(table)]))
  );

  const now = new Date().toISOString();
  const sheetData = [
    {
      title: 'backup_status',
      rows: [
        SHEET_COLUMNS.backup_status,
        [
          now,
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

  await ensureSheets(accessToken, sheetData.map(sheet => sheet.title));
  await clearSheets(accessToken, sheetData.map(sheet => sheet.title));
  await writeSheets(accessToken, sheetData);

  console.log(`Backed up ${tables.song_applications.length} songs and ${tables.session_applications.length} session applications at ${now}.`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseServiceAccount(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('service account JSON must include client_email and private_key');
    }
    return parsed;
  } catch (error) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid service account JSON: ${error.message}`);
  }
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

async function getGoogleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    serviceAccount.private_key
  );

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw new Error(`Google token request failed: ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  return json.access_token;
}

function signJwt(header, payload, privateKey) {
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey);
  return `${input}.${base64url(signature)}`;
}

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function ensureSheets(accessToken, titles) {
  const metadata = await sheetsFetch(accessToken, '', { method: 'GET' });
  const existing = new Set((metadata.sheets || []).map(sheet => sheet.properties.title));
  const missing = titles.filter(title => !existing.has(title));
  if (!missing.length) return;

  await sheetsFetch(accessToken, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: missing.map(title => ({ addSheet: { properties: { title } } })),
    }),
  });
}

async function clearSheets(accessToken, titles) {
  await sheetsFetch(accessToken, '/values:batchClear', {
    method: 'POST',
    body: JSON.stringify({ ranges: titles.map(title => `'${title.replace(/'/g, "''")}'!A:ZZZ`) }),
  });
}

async function writeSheets(accessToken, sheets) {
  await sheetsFetch(accessToken, '/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: sheets.map(sheet => ({
        range: `'${sheet.title.replace(/'/g, "''")}'!A1`,
        values: sheet.rows,
      })),
    }),
  });
}

async function sheetsFetch(accessToken, path, init) {
  const separator = path.startsWith('/') || path.startsWith(':') ? '' : '/';
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}${separator}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Google Sheets request failed: ${response.status} ${await response.text()}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : {};
}
