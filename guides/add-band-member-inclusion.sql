-- Add an administrator-controlled team inclusion state to band applicants.
-- Public applications keep the default true and cannot set or update this field.

alter table public.band_members
  add column if not exists is_included boolean not null default true;
