import test from 'node:test';
import assert from 'node:assert/strict';
import { availableTeamCategories, teamByNumberInCategory, teamsInCategory } from '../js/timeassign/teamSelection.js';

const defaults = { 합주: '합주', 스쿨: '스쿨', 이외: '이외' };
const teams = [
  { id: 1, name: '1팀', type: '합주' },
  { id: 2, name: '1팀', type: '합주' },
  { id: 3, name: '2팀', type: '합주' },
  { id: 4, name: '기타 입문 1반', type: '스쿨' },
];
const categories = {
  정기공연: ['id:1', 'id:3'],
  버스킹: ['id:2'],
};

test('lists team categories while keeping fixed classifications last', () => {
  assert.deepEqual(availableTeamCategories(teams, categories, defaults), ['버스킹', '정기공연', '스쿨']);
});

test('filters identical team numbers by selected category and keeps team ids distinct', () => {
  assert.deepEqual(teamsInCategory(teams, categories, defaults, '정기공연').map(team => team.id), [1, 3]);
  assert.deepEqual(teamsInCategory(teams, categories, defaults, '버스킹').map(team => team.id), [2]);
});

test('returns no team options before a category is selected', () => {
  assert.deepEqual(teamsInCategory(teams, categories, defaults, ''), []);
});

test('finds a numbered team only inside the selected category', () => {
  assert.equal(teamByNumberInCategory(teams, categories, defaults, '정기공연', '1')?.id, 1);
  assert.equal(teamByNumberInCategory(teams, categories, defaults, '버스킹', '1')?.id, 2);
  assert.equal(teamByNumberInCategory(teams, categories, defaults, '정기공연', '7'), null);
  assert.equal(teamByNumberInCategory(teams, categories, defaults, '', '1'), null);
});
