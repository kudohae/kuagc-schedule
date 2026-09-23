const ALLOCATION_MARKER = '__BAND_ALLOCATION__:';
const ALLOCATION_STATES = new Set(['force_on', 'force_off', 'extra_on']);

export function normalizeBandRole(value) {
  const raw = String(value || '').trim();
  const compact = raw.replace(/\s+/g, '').toLowerCase();
  if (/^(보컬|vocal)\d*$/.test(compact)) return '보컬';
  if (/^(기타|guitar)\d*$/.test(compact)) return '기타';
  if (/^(베이스|bass)\d*$/.test(compact)) return '베이스';
  if (/^(키보드|건반|keyboard|key)\d*$/.test(compact)) return '키보드';
  if (/^(드럼|drum|drums)\d*$/.test(compact)) return '드럼';
  return raw;
}

function splitMemberNote(note) {
  const value = String(note || '');
  const markerIndex = value.lastIndexOf(ALLOCATION_MARKER);
  if (markerIndex < 0) return { note: value, directives: {} };
  const encoded = value.slice(markerIndex + ALLOCATION_MARKER.length).trim();
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded));
    const directives = Object.fromEntries(Object.entries(parsed || {})
      .filter(([role, state]) => normalizeBandRole(role) && ALLOCATION_STATES.has(state))
      .map(([role, state]) => [normalizeBandRole(role), state]));
    return { note: value.slice(0, markerIndex).replace(/\n$/, ''), directives };
  } catch {
    return { note: value, directives: {} };
  }
}

export function memberRoleDirective(member, role) {
  return splitMemberNote(member?.note).directives[normalizeBandRole(role)] || '';
}

export function memberNoteWithDirective(member, role, state = '') {
  const parsed = splitMemberNote(member?.note);
  const normalizedRole = normalizeBandRole(role);
  if (ALLOCATION_STATES.has(state)) parsed.directives[normalizedRole] = state;
  else delete parsed.directives[normalizedRole];
  const entries = Object.keys(parsed.directives);
  if (!entries.length) return parsed.note;
  return `${parsed.note}${parsed.note ? '\n' : ''}${ALLOCATION_MARKER}${encodeURIComponent(JSON.stringify(parsed.directives))}`;
}

export function allocationKey(member, role) {
  return `${String(member?.id)}::${normalizeBandRole(role)}`;
}

function byCreated(a, b) {
  return String(a?.created_at || '').localeCompare(String(b?.created_at || ''))
    || String(a?.id || '').localeCompare(String(b?.id || ''));
}

export function calculateSongAllocation(song, rows, visibleWantedRoles, getApplicantRole) {
  const requirements = new Map();
  for (const rawRole of visibleWantedRoles(song)) {
    const role = normalizeBandRole(rawRole);
    if (role) requirements.set(role, (requirements.get(role) || 0) + 1);
  }

  const statuses = new Map();
  const filledByRole = new Map();
  const applicantRole = normalizeBandRole(getApplicantRole(song));
  for (const [role, capacity] of requirements) {
    const candidates = rows
      .filter(member => (member.roles || []).map(normalizeBandRole).includes(role))
      .sort(byCreated);
    const forced = [];
    const automatic = [];
    const extras = [];

    for (const member of candidates) {
      const directive = memberRoleDirective(member, role);
      if (directive === 'force_off' || (member.is_included === false && !directive)) {
        statuses.set(allocationKey(member, role), false);
      } else if (directive === 'force_on') forced.push(member);
      else if (directive === 'extra_on') extras.push(member);
      else automatic.push(member);
    }

    const applicantUsesSlot = applicantRole === role ? 1 : 0;
    const remaining = Math.max(0, capacity - applicantUsesSlot - forced.length);
    const selectedAutomatic = new Set(automatic.slice(0, remaining).map(member => String(member.id)));
    forced.forEach(member => statuses.set(allocationKey(member, role), true));
    automatic.forEach(member => statuses.set(allocationKey(member, role), selectedAutomatic.has(String(member.id))));
    extras.forEach(member => statuses.set(allocationKey(member, role), true));
    filledByRole.set(role, applicantUsesSlot + forced.length + selectedAutomatic.size + extras.length);
  }

  const isComplete = requirements.size > 0
    && [...requirements].every(([role, capacity]) => (filledByRole.get(role) || 0) >= capacity);
  return { requirements, statuses, filledByRole, isComplete };
}

export function isMemberRoleIncluded(allocation, member, role) {
  return allocation.statuses.get(allocationKey(member, role)) === true;
}

export function includedRoles(allocation, member) {
  return [...new Set((member?.roles || []).map(normalizeBandRole).filter(role => isMemberRoleIncluded(allocation, member, role)))];
}

export function compareMembersForRole(a, b, role) {
  const aExtra = memberRoleDirective(a, role) === 'extra_on';
  const bExtra = memberRoleDirective(b, role) === 'extra_on';
  return Number(aExtra) - Number(bExtra) || byCreated(a, b);
}
