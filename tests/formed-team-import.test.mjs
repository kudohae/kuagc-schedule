import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bandTeamMembers,
  buildFormedTeamRows,
  formedTeamImportConflict,
  isFormedBandSong,
} from '../js/admin/formedTeamImport.js';

const song = {
  id: 10,
  title: '테스트 곡',
  applicant_name: '신청자',
  student_id: '202600001',
  wanted_roles: ['보컬', '기타', '__BAND_APPLICANT_ROLE__:보컬'],
  is_formed: false,
  created_at: '2026-09-20T01:00:00.000Z',
};
const members = [
  { id: 1, song_id: 10, applicant_name: '선착순', student_id: '202600002', roles: ['기타'], is_included: true, created_at: '2026-09-20T01:01:00.000Z' },
  { id: 2, song_id: 10, applicant_name: '후순위', student_id: '202600003', roles: ['기타'], is_included: true, created_at: '2026-09-20T01:02:00.000Z' },
];

test('imports only allocated members and includes the song applicant', () => {
  assert.equal(isFormedBandSong(song, members), true);
  assert.deepEqual(bandTeamMembers(song, members), [
    { name: '신청자', student_id_last3: '001', sessions: ['보컬'] },
    { name: '선착순', student_id_last3: '002', sessions: ['기타'] },
  ]);
});

test('builds tagged team names under the selected round category', () => {
  const rows = buildFormedTeamRows({ songs: [song], members, categoryName: 'A 회차', tag: '정기공연', color: '#888888' });
  assert.equal(rows[0].name, '정기공연 1팀');
  assert.equal(rows[0].type, 'A 회차');
  assert.equal(rows[0].info, '테스트 곡');
});

test('blocks an existing category before any insert', () => {
  const message = formedTeamImportConflict([{ name: '기존 팀', type: 'A 회차' }], 'A 회차', []);
  assert.match(message, /팀 분류가 이미 존재/);
});

test('blocks a generated team name that already exists', () => {
  const message = formedTeamImportConflict(
    [{ name: '정기공연 1팀', type: '스쿨' }],
    '새 회차',
    [{ name: '정기공연 1팀' }],
  );
  assert.match(message, /팀이 이미 존재/);
  assert.match(message, /팀 태그를 바꿔/);
});
