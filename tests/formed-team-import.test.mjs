import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bandTeamMembers,
  buildFormedTeamRows,
  isFormedBandSong,
} from '../js/admin/formedTeamImport.js';
import {
  nextTeamNumberInCategory,
  removeTeamsFromCategories,
  renameTeamKind,
  setTeamCategoryForTeam,
  setTeamKindForName,
  teamCategory,
} from '../js/utils/common.js';

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

test('builds tagged team names with the compatible ensemble storage type', () => {
  const rows = buildFormedTeamRows({ songs: [song], members, tag: '정기공연', color: '#888888' });
  assert.equal(rows[0].name, '정기공연 1팀');
  assert.equal(rows[0].type, '합주');
  assert.equal(rows[0].info, '테스트 곡');
});

test('builds category-local team numbers without a name prefix', () => {
  const rows = buildFormedTeamRows({ songs: [song], members, startNumber: 4, color: '#888888' });
  assert.equal(rows[0].name, '4팀');
  assert.equal(rows[0].type, '합주');
});

test('renders a mapped round category while preserving the stored ensemble type', () => {
  const team = { name: '정기공연 1팀', type: '합주' };
  assert.equal(teamCategory(team, { 'A 회차': ['정기공연 1팀'] }), 'A 회차');
  assert.equal(team.type, '합주');
});

test('uses a renamed default kind without changing the fixed classification', () => {
  const team = { name: '1팀', type: '합주' };
  assert.equal(teamCategory(team, {}, { '합주': '정기공연' }), '정기공연');
  assert.equal(team.type, '합주');
});

test('renames a team kind and keeps future teams on the renamed default', () => {
  const teams = [{ name: '1팀', type: '합주' }, { name: '2팀', type: '합주' }];
  const result = renameTeamKind({
    teams,
    categories: {},
    defaults: { '합주': '합주', '스쿨': '스쿨', '이외': '이외' },
    oldName: '합주',
    newName: '2026-2 정기공연',
  });
  assert.deepEqual(result.categories, { '2026-2 정기공연': ['1팀', '2팀'] });
  assert.equal(result.defaults['합주'], '2026-2 정기공연');
  assert.equal(teamCategory({ name: '3팀', type: '합주' }, result.categories, result.defaults), '2026-2 정기공연');
});

test('assigns a manually added ensemble team to a custom kind', () => {
  assert.deepEqual(setTeamKindForName({}, '3팀', '2026-2 버스킹', '합주'), { '2026-2 버스킹': ['3팀'] });
});

test('distinguishes identical team names by stable team id', () => {
  const regular = { id: 10, name: '1팀', type: '합주' };
  const busking = { id: 20, name: '1팀', type: '합주' };
  let categories = setTeamCategoryForTeam({}, regular, '정기공연', '합주');
  categories = setTeamCategoryForTeam(categories, busking, '버스킹', '합주');
  assert.equal(teamCategory(regular, categories), '정기공연');
  assert.equal(teamCategory(busking, categories), '버스킹');
});

test('uses max plus one inside a category and does not reuse deleted numbers', () => {
  const teams = [
    { id: 1, name: '1팀', type: '합주' },
    { id: 3, name: '3팀', type: '합주' },
    { id: 4, name: '8팀', type: '합주' },
  ];
  const categories = { 정기공연: ['id:1', 'id:3'], 버스킹: ['id:4'] };
  assert.equal(nextTeamNumberInCategory(teams, categories, {}, '정기공연'), 4);
  assert.equal(nextTeamNumberInCategory(teams, categories, {}, '버스킹'), 9);
});

test('removes both stable and legacy category references for a deleted team', () => {
  assert.deepEqual(removeTeamsFromCategories({ 정기공연: ['1팀'], 버스킹: ['id:20'] }, [
    { id: 10, name: '1팀', type: '합주' },
    { id: 20, name: '2팀', type: '합주' },
  ]), {});
});

test('keeps a legacy same-name team when deleting an id-mapped team', () => {
  const categories = { 정기공연: ['1팀'], 버스킹: ['id:20'] };
  assert.deepEqual(removeTeamsFromCategories(categories, [
    { id: 20, name: '1팀', type: '합주' },
  ]), { 정기공연: ['1팀'] });
});
