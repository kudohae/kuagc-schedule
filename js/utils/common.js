export const DAYS  = ['월','화','수','목','금','토','일'];
export const HOURS = Array.from({length:18},(_,i)=>i+8);
export const GRAY  = '#888888';

export const korSort = (a,k) => [...a].sort((x,y)=>x[k].localeCompare(y[k],'ko-KR',{numeric:true}));

export const getWeekDates = off => {
  const now=new Date(),mon=new Date(now);
  mon.setDate(now.getDate()-((now.getDay()+6)%7)+off*7);
  return Array.from({length:7},(_,i)=>{const d=new Date(mon);d.setDate(mon.getDate()+i);return `${d.getMonth()+1}/${d.getDate()}`;});
};

export const teamClr = t => t.type==='합주'?GRAY:(t.color||GRAY);
export const normalizeTeamKind = value => String(value || '').trim().toLocaleLowerCase('ko-KR');
export const teamCategoryToken = teamId => `id:${teamId}`;
const isTeamIdToken = value => /^id:\d+$/.test(String(value || '').trim());
const categoryHasTeamId = (members, team) => team?.id != null
  && members.some(item => String(item || '').trim() === teamCategoryToken(team.id));
const categoryHasLegacyName = (members, team) => members.some(item => !isTeamIdToken(item)
  && normalizeTeamKind(item) === normalizeTeamKind(team?.name));
export const teamCategory = (team, categories = {}, defaults = {}) => {
  const entries = Object.entries(categories).filter(([, members]) => Array.isArray(members));
  const entry = entries.find(([, members]) => categoryHasTeamId(members, team))
    || entries.find(([, members]) => categoryHasLegacyName(members, team));
  return entry?.[0] || defaults?.[team?.type] || team?.type || '';
};

export function setTeamCategoryForTeam(categories, team, categoryName, fallbackCategory = '') {
  const token = teamCategoryToken(team.id);
  const next = {};
  for (const [category, members] of Object.entries(categories || {})) {
    const filtered = Array.isArray(members)
      ? members.filter(item => String(item || '').trim() !== token)
      : [];
    if (filtered.length) next[category] = filtered;
  }
  if (normalizeTeamKind(categoryName) !== normalizeTeamKind(fallbackCategory) || team?.type === '합주') {
    const existingKey = Object.keys(next).find(category => normalizeTeamKind(category) === normalizeTeamKind(categoryName));
    const key = existingKey || categoryName;
    next[key] = [...new Set([...(next[key] || []), token])];
  }
  return next;
}

export function removeTeamsFromCategories(categories, teamsOrIds) {
  const teams = (teamsOrIds || []).map(item => typeof item === 'object' ? item : { id: item });
  const tokens = new Set(teams.filter(team => team.id != null).map(team => teamCategoryToken(team.id)));
  const allMembers = Object.values(categories || {}).flatMap(members => Array.isArray(members) ? members : []);
  const legacyNames = new Set(teams
    .filter(team => team.name && !allMembers.includes(teamCategoryToken(team.id)))
    .map(team => normalizeTeamKind(team.name)));
  const next = {};
  for (const [category, members] of Object.entries(categories || {})) {
    const filtered = Array.isArray(members)
      ? members.filter(item => {
        const value = String(item || '').trim();
        return !tokens.has(value) && (isTeamIdToken(value) || !legacyNames.has(normalizeTeamKind(value)));
      })
      : [];
    if (filtered.length) next[category] = filtered;
  }
  return next;
}

export function nextTeamNumberInCategory(teams, categories, defaults, categoryName) {
  const numbers = (teams || [])
    .filter(team => team?.type === '합주'
      && normalizeTeamKind(teamCategory(team, categories, defaults)) === normalizeTeamKind(categoryName))
    .map(team => String(team.name || '').match(/(\d+)팀$/)?.[1])
    .filter(Boolean)
    .map(Number);
  return numbers.length ? Math.max(...numbers) + 1 : 1;
}
export function setTeamKindForName(categories, teamName, kindName, fallbackKind = '') {
  const target = normalizeTeamKind(teamName);
  const next = {};
  for (const [kind, names] of Object.entries(categories || {})) {
    const filtered = Array.isArray(names) ? names.filter(name => normalizeTeamKind(name) !== target) : [];
    if (filtered.length) next[kind] = filtered;
  }
  if (normalizeTeamKind(kindName) !== normalizeTeamKind(fallbackKind)) {
    const existingKey = Object.keys(next).find(kind => normalizeTeamKind(kind) === normalizeTeamKind(kindName));
    const key = existingKey || kindName;
    next[key] = [...new Set([...(next[key] || []), teamName])];
  }
  return next;
}
export function renameTeamKind({ teams, categories = {}, defaults = {}, oldName, newName }) {
  const memberTeams = teams
    .filter(team => normalizeTeamKind(teamCategory(team, categories, defaults)) === normalizeTeamKind(oldName));
  const memberTokens = memberTeams.map(team => team?.id != null ? teamCategoryToken(team.id) : team.name);
  const targets = new Set(memberTeams.map(team => normalizeTeamKind(team.name)));
  const nextCategories = {};
  for (const [kind, names] of Object.entries(categories)) {
    const filtered = Array.isArray(names) ? names.filter(name => {
      if (memberTokens.includes(String(name || '').trim())) return false;
      return isTeamIdToken(name) || !targets.has(normalizeTeamKind(name));
    }) : [];
    if (filtered.length && normalizeTeamKind(kind) !== normalizeTeamKind(oldName)) nextCategories[kind] = filtered;
  }
  if (memberTokens.length) nextCategories[newName] = memberTokens;
  const nextDefaults = Object.fromEntries(Object.entries(defaults).map(([classification, kind]) => [
    classification,
    normalizeTeamKind(kind) === normalizeTeamKind(oldName) ? newName : kind,
  ]));
  return { categories: nextCategories, defaults: nextDefaults };
}
export const timeStr = h => h<24?h+':00':'0'+(h-24)+':00';

export const errMsg = e => {
  const m=e?.message||'';
  if(m.includes('unique')||m.includes('duplicate')) return '이미 동일한 데이터가 존재합니다';
  if(m.includes('foreign key')) return '참조 데이터가 존재하지 않습니다';
  if(m.includes('network')||m.includes('fetch')) return '네트워크 오류가 발생했습니다. 다시 시도해주세요';
  if(m.includes('JWT')||m.includes('auth')) return '인증 오류가 발생했습니다. 새로고침 후 시도해주세요';
  return m||'오류가 발생했습니다';
};

export function weekLabel(off){
  const now=new Date(),m=new Date(now);
  m.setDate(now.getDate()-((now.getDay()+6)%7)+off*7);
  const mo=m.getMonth()+1;
  const wn=Math.ceil((m.getDate()+(new Date(m.getFullYear(),m.getMonth(),1).getDay()+6)%7)/7);
  return `${mo}월 ${wn}주차`;
}
