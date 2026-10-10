-- Add the public-page blind switch to an existing band installation.

alter table public.band_rounds
  add column if not exists is_blinded boolean not null default false;

-- Make the new column visible to the Data API immediately.
notify pgrst, 'reload schema';
