import {
  calculateSongAllocation,
  includedRoles,
  normalizeBandRole,
} from '../band/allocation.js';

const FIXED_PATTERN = /^_+BAND_FIXED_+$/i;
const APPLICANT_PATTERN = /^_+BAND_APPLICANT_ROLE_+:(.+)$/i;

const isMetadataRole = value => FIXED_PATTERN.test(String(value || '').trim())
  || APPLICANT_PATTERN.test(String(value || '').trim());
const visibleWantedRoles = song => (song?.wanted_roles || []).filter(role => !isMetadataRole(role));
const isFixedSong = song => (song?.wanted_roles || []).some(role => FIXED_PATTERN.test(String(role || '').trim()));
const applicantRole = song => {
  const match = (song?.wanted_roles || [])
    .map(role => String(role || '').trim().match(APPLICANT_PATTERN))
    .find(Boolean);
  return normalizeBandRole(match?.[1] || '');
};

export const normalizeTeamName = value => String(value || '').trim().toLocaleLowerCase('ko-KR');

function allocationFor(song, allMembers) {
  return calculateSongAllocation(
    song,
    allMembers.filter(member => member.song_id === song.id),
    visibleWantedRoles,
    applicantRole,
  );
}

export function isFormedBandSong(song, allMembers) {
  return isFixedSong(song) || song.is_formed === true || allocationFor(song, allMembers).isComplete;
}

export function bandTeamMembers(song, allMembers) {
  const rows = allMembers.filter(member => member.song_id === song.id);
  const allocation = allocationFor(song, allMembers);
  const people = new Map();
  const addPerson = (name, studentId, roles) => {
    const sid = String(studentId || '').trim();
    const key = sid || `name:${String(name || '').trim()}`;
    if (!key || key === 'name:') return;
    const person = people.get(key) || {
      name: String(name || '').trim(),
      student_id_last3: sid.slice(-3),
      sessions: [],
    };
    person.sessions = [...new Set([...person.sessions, ...roles.map(normalizeBandRole).filter(Boolean)])];
    people.set(key, person);
  };

  const ownerRole = applicantRole(song);
  addPerson(song.applicant_name, song.student_id, ownerRole ? [ownerRole] : []);
  rows.forEach(member => {
    const roles = isFixedSong(song)
      ? (member.roles || []).map(normalizeBandRole).filter(Boolean)
      : includedRoles(allocation, member);
    if (roles.length) addPerson(member.applicant_name, member.student_id, roles);
  });
  return [...people.values()];
}

export function buildFormedTeamRows({ songs, members, tag, color, storageType = '합주' }) {
  return songs.map((song, index) => ({
    name: `${tag} ${index + 1}팀`,
    type: storageType,
    color,
    info: String(song.title || '').trim(),
    members: bandTeamMembers(song, members),
  }));
}

export function formedTeamImportConflict(currentTeams, categoryName, rows, categories = {}) {
  const currentNames = new Set(currentTeams.map(team => normalizeTeamName(team.name)));
  const mappedNames = Object.entries(categories)
    .find(([name]) => normalizeTeamName(name) === normalizeTeamName(categoryName))?.[1] || [];
  const categoryHasTeams = Array.isArray(mappedNames) && mappedNames.some(name => currentNames.has(normalizeTeamName(name)));
  if (categoryHasTeams || currentTeams.some(team => normalizeTeamName(team.type) === normalizeTeamName(categoryName))) {
    return `'${categoryName}' 팀 분류가 이미 존재합니다. 회차 이름을 바꾼 뒤 다시 시도해주세요.`;
  }
  const duplicate = rows.find(row => currentNames.has(normalizeTeamName(row.name)));
  return duplicate ? `'${duplicate.name}' 팀이 이미 존재합니다. 팀 태그를 바꿔주세요.` : '';
}
