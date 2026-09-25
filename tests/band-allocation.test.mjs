import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../js/band/allocation.js', import.meta.url), 'utf8');
const {
  calculateSongAllocation,
  isMemberRoleIncluded,
  memberNoteWithDirective,
} = await import(`data:text/javascript,${encodeURIComponent(source)}`);

const song = {
  id: 1,
  wanted_roles: ['보컬', '기타'],
};
const visibleWantedRoles = item => item.wanted_roles;
const member = (id, createdAt, note = '') => ({
  id,
  song_id: 1,
  applicant_name: `신청자${id}`,
  student_id: String(id),
  roles: ['기타'],
  note,
  is_included: true,
  created_at: createdAt,
});
const applicant = {
  id: 0,
  song_id: 1,
  applicant_name: '곡 신청자',
  student_id: '0',
  roles: ['보컬'],
  note: '',
  is_included: true,
  is_song_applicant: true,
  created_at: '2026-09-23T00:00:00.000Z',
};

test('allocates each role by application time and forms the song when every role is full', () => {
  const first = member(1, '2026-09-23T00:00:00.001Z');
  const late = member(2, '2026-09-23T00:00:00.002Z');
  const allocation = calculateSongAllocation(song, [late, applicant, first], visibleWantedRoles);

  assert.equal(isMemberRoleIncluded(allocation, first, '기타'), true);
  assert.equal(isMemberRoleIncluded(allocation, late, '기타'), false);
  assert.equal(allocation.isComplete, true);
});

test('replacement forces the selected applicant on and the replaced applicant off', () => {
  const first = member(1, '2026-09-23T00:00:00.001Z');
  const late = member(2, '2026-09-23T00:00:00.002Z');
  first.note = memberNoteWithDirective(first, '기타', 'force_off');
  late.note = memberNoteWithDirective(late, '기타', 'force_on');
  const allocation = calculateSongAllocation(song, [applicant, first, late], visibleWantedRoles);

  assert.equal(isMemberRoleIncluded(allocation, first, '기타'), false);
  assert.equal(isMemberRoleIncluded(allocation, late, '기타'), true);
});

test('extra assignment exceeds capacity without evicting the existing member', () => {
  const first = member(1, '2026-09-23T00:00:00.001Z');
  const extra = member(2, '2026-09-23T00:00:00.002Z');
  extra.note = memberNoteWithDirective(extra, '기타', 'extra_on');
  const allocation = calculateSongAllocation(song, [applicant, first, extra], visibleWantedRoles);

  assert.equal(isMemberRoleIncluded(allocation, first, '기타'), true);
  assert.equal(isMemberRoleIncluded(allocation, extra, '기타'), true);
  assert.equal(allocation.filledByRole.get('기타'), 2);
});
