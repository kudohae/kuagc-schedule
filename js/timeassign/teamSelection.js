import { normalizeTeamKind, teamCategory } from '../utils/common.js?v=20260925-team-categories';

export function availableTeamCategories(teams, categories = {}, defaults = {}) {
  const names = [...new Set((teams || []).map(team => teamCategory(team, categories, defaults)).filter(Boolean))];
  const preferred = ['합주', '스쿨', '이외'].map(type => defaults[type] || type).filter(Boolean);
  const custom = names
    .filter(category => !preferred.some(item => normalizeTeamKind(item) === normalizeTeamKind(category)))
    .sort((a, b) => a.localeCompare(b, 'ko-KR', { numeric: true }));
  return [...new Set([preferred[0], ...custom, preferred[1], preferred[2]].filter(Boolean))]
    .filter(category => names.some(item => normalizeTeamKind(item) === normalizeTeamKind(category)));
}

export function teamsInCategory(teams, categories, defaults, category) {
  if (!category) return [];
  return (teams || [])
    .filter(team => normalizeTeamKind(teamCategory(team, categories, defaults)) === normalizeTeamKind(category))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko-KR', { numeric: true }));
}
