function compareSubmitted(a, b) {
  const submittedDiff = new Date(a.submitted_at) - new Date(b.submitted_at);
  return submittedDiff !== 0 ? submittedDiff : a.id - b.id;
}

// Only the latest submission for each team is valid. Process those submissions
// in first-come order, checking all preferences before moving to the next team.
export function calculateTimeAssignments(applications) {
  const latestPerTeam = new Map();

  for (const application of applications) {
    const previous = latestPerTeam.get(application.team_id);
    if (!previous || compareSubmitted(application, previous) > 0) {
      latestPerTeam.set(application.team_id, application);
    }
  }

  const sorted = [...latestPerTeam.values()].sort(compareSubmitted);
  const occupied = new Set();

  return sorted.map(application => {
    for (const preference of [1, 2, 3]) {
      const day = application[`pref${preference}_day`];
      const hour = application[`pref${preference}_hour`];
      if (day == null || hour == null) continue;

      const slot = `${day}-${hour}`;
      if (occupied.has(slot)) continue;

      occupied.add(slot);
      return {
        id: application.id,
        assigned_day: day,
        assigned_hour: hour,
        assigned_pref: preference,
      };
    }

    return {
      id: application.id,
      assigned_day: null,
      assigned_hour: null,
      assigned_pref: null,
    };
  });
}
