import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../js/utils/timeAssignment.js', import.meta.url),
  'utf8',
);
const { calculateTimeAssignments } = await import(
  `data:text/javascript,${encodeURIComponent(source)}`
);

const application = (overrides) => ({
  id: 1,
  team_id: 1,
  submitted_at: '2026-09-22T18:00:00+09:00',
  pref1_day: null,
  pref1_hour: null,
  pref2_day: null,
  pref2_hour: null,
  pref3_day: null,
  pref3_hour: null,
  ...overrides,
});

test('checks all preferences for an earlier team before the next team', () => {
  const results = calculateTimeAssignments([
    application({id:1,team_id:1,pref1_day:0,pref1_hour:18}),
    application({
      id:2,
      team_id:2,
      submitted_at:'2026-09-22T18:00:01+09:00',
      pref1_day:0,
      pref1_hour:18,
      pref2_day:0,
      pref2_hour:19,
    }),
    application({
      id:3,
      team_id:3,
      submitted_at:'2026-09-22T18:00:02+09:00',
      pref1_day:0,
      pref1_hour:19,
    }),
  ]);

  assert.deepEqual(results, [
    {id:1,assigned_day:0,assigned_hour:18,assigned_pref:1},
    {id:2,assigned_day:0,assigned_hour:19,assigned_pref:2},
    {id:3,assigned_day:null,assigned_hour:null,assigned_pref:null},
  ]);
});

test('uses only the latest submission for each team', () => {
  const results = calculateTimeAssignments([
    application({id:1,team_id:1,pref1_day:0,pref1_hour:18}),
    application({
      id:2,
      team_id:1,
      submitted_at:'2026-09-22T18:00:01+09:00',
      pref1_day:1,
      pref1_hour:18,
    }),
  ]);

  assert.deepEqual(results, [
    {id:2,assigned_day:1,assigned_hour:18,assigned_pref:1},
  ]);
});

test('uses application id to break equal submission timestamps', () => {
  const results = calculateTimeAssignments([
    application({id:2,team_id:2,pref1_day:0,pref1_hour:18}),
    application({id:1,team_id:1,pref1_day:0,pref1_hour:18}),
  ]);

  assert.deepEqual(results, [
    {id:1,assigned_day:0,assigned_hour:18,assigned_pref:1},
    {id:2,assigned_day:null,assigned_hour:null,assigned_pref:null},
  ]);
});
