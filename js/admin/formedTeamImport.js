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

function allocationFor(song, allMembers) {
  return calculateSongAllocation(
    song,
    allMembers.filter(member => member.song_id === song.id),
    visibleWantedRoles,
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

  rows.forEach(member => {
    const roles = isFixedSong(song)
      ? (member.roles || []).map(normalizeBandRole).filter(Boolean)
      : includedRoles(allocation, member);
    if (roles.length) addPerson(member.applicant_name, member.student_id, roles);
  });
  return [...people.values()];
}

export function buildFormedTeamRows({ songs, members, tag = '', startNumber = 1, color, storageType = '합주' }) {
  return songs.map((song, index) => ({
    name: `${tag ? `${tag} ` : ''}${startNumber + index}팀`,
    type: storageType,
    color,
    info: String(song.title || '').trim(),
    members: bandTeamMembers(song, members),
  }));
}
