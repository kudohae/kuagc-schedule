# CLAUDE.md — kuagc-schedule

## Pushing to GitHub

**`git push origin main` returns HTTP 403** — main is a protected branch.

### Correct workflow for pushing changes

```bash
# 1. Commit locally as usual
git add <files>
git commit -m "..."

# 2. Push to a feature branch (non-main branches work fine)
git push -u origin HEAD:claude/<descriptive-name>

# 3. Create PR and merge via MCP
mcp__github__create_pull_request  owner=kudohae repo=kuagc-schedule head=claude/<name> base=main
mcp__github__merge_pull_request   owner=kudohae repo=kuagc-schedule pullNumber=<N> merge_method=squash
```

**Do NOT use `mcp__github__push_files`** to push large files — admin.html is ~141KB and reading it in full burns significant API tokens. The git-branch-then-merge path avoids reading file content entirely.

## File overview

| File | Size | Purpose |
|------|------|---------|
| `admin.html` | ~2440 lines | Admin UI — schedule, teams, apply, school, ensemble, notices |
| `school.html` | ~490 lines | Public school application page |
| `index.html` | — | Public schedule view |
| `ensemble.html` | — | Public ensemble application page |
| `js/supabase.js` | — | Supabase client init |
| `js/schedule.js` | — | Data layer: all Supabase queries and business logic |

## Architecture

- Static HTML/JS with no build step — edit files directly
- Backend: Supabase (Postgres + Realtime + Auth)
- Admin auth: Supabase email/password (the admin user)
- All DB writes go through Supabase JS client (`supabase.from(...)`)

## School system (admin.html lines 810–1229)

**Tables:** `school_rounds`, `schools`, `school_applications`

`school_applications` columns include: `round_id`, `pref1_school_id`, `pref2_school_id`, `assigned_school_id`, `status` (`assigned`/`unassigned`/`pending`), `is_returning`

- `pending` status = returning student waiting for post-close assignment
- `pending` apps are processed in `adminSchoolClose()` when the round closes
- Returning-student logic only activates when `school_rounds.prioritize_returning = true`

When deleting a class (`deleteClass`), apps must be deleted by ALL three preference columns (`pref1_school_id`, `pref2_school_id`, `assigned_school_id`), not just `assigned_school_id`.
