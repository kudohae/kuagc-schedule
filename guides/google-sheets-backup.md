# Google Sheets ensemble backup

This repository includes a GitHub Actions workflow that backs up ensemble data from Supabase to Google Sheets every 10 minutes.

## What gets backed up

- `ensemble_rounds`
- `song_applications`, including `public_note`
- `session_applications`
- `manual_entries`
- `latest_song_status`, a readable joined summary
- `backup_status`, the latest sync timestamp and row counts

The backup is one-way: Supabase remains the source of truth, and Google Sheets is a read/backup destination.

## Required GitHub Secrets

Add these in GitHub repository settings:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON`

`SUPABASE_ANON_KEY` is enough because the backed-up tables are publicly readable in this app. If table read policies become private later, replace the workflow secret value with a service-role key and keep it only in GitHub Secrets.

`SUPABASE_URL` and `SUPABASE_ANON_KEY` were set when this workflow was added. In normal operation, only the two Google secrets need to be added by the site operator.

## Google setup

1. Create a Google Cloud service account.
2. Create a JSON key for that service account.
3. Create the target Google Sheet.
4. Share the Google Sheet with the service account `client_email` as an editor.
5. Put the full JSON key contents into `GOOGLE_SERVICE_ACCOUNT_JSON`.
6. Put the spreadsheet id from the sheet URL into `GOOGLE_SHEET_ID`.

## Manual run

After setting the secrets, open GitHub Actions, choose `Backup ensemble to Google Sheets`, and run it manually once. If it succeeds, the scheduled backup will continue every 10 minutes.
