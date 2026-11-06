# Google Sheets backup

This repository includes a GitHub Actions workflow that backs up request data from Supabase to Google Sheets every 10 minutes through a Google Apps Script web app.

## What gets backed up

The automated backup follows the same workbook shape as the backup file from `/admin.html`.

- `시간 신청`
- `스쿨 신청`
- `합주 신청`

The backup is one-way: Supabase remains the source of truth, and Google Sheets is a read/backup destination.

## Required GitHub Secrets

These are already set:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

The site operator still needs to add:

- `GOOGLE_SHEETS_WEBAPP_URL`
- `GOOGLE_SHEETS_WEBAPP_SECRET`

`GOOGLE_SHEETS_WEBAPP_SECRET` can be any long random string. Put the same value in the Apps Script `BACKUP_SECRET` script property.

## Apps Script setup

1. Create or open the target Google Sheet.
2. Open `Extensions` > `Apps Script`.
3. Paste the code below into `Code.gs`.
4. Open `Project Settings` > `Script properties`.
5. Add `BACKUP_SECRET` with the same value as the GitHub secret `GOOGLE_SHEETS_WEBAPP_SECRET`.
6. Deploy as a web app:
   - Execute as: `Me`
   - Who has access: `Anyone`
7. Copy the web app URL into the GitHub secret `GOOGLE_SHEETS_WEBAPP_URL`.

```javascript
const SPREADSHEET_ID = '1Kvv180Aobwz-u9z_6ZBxVUQMarg_mWdt-yC-ZEdSRr0';

function doPost(e) {
  const expectedSecret = PropertiesService.getScriptProperties().getProperty('BACKUP_SECRET');
  const payload = JSON.parse(e.postData.contents || '{}');

  if (!expectedSecret || payload.secret !== expectedSecret) {
    return jsonResponse({ ok: false, error: 'unauthorized' });
  }

  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const writtenTitles = [];

    for (const sheetData of payload.sheets || []) {
      const sheet = getOrCreateSheet_(spreadsheet, sheetData.title);
      writtenTitles.push(sheetData.title);
      sheet.clear();

      const rows = sheetData.rows || [];
      if (rows.length > 0) {
        const width = Math.max.apply(null, rows.map(row => row.length));
        const normalizedRows = rows.map(row => {
          const next = row.slice();
          while (next.length < width) next.push('');
          return next;
        });

        const range = sheet.getRange(1, 1, normalizedRows.length, width);
        range.setValues(normalizedRows);

        if (Array.isArray(sheetData.backgrounds) && sheetData.backgrounds.length > 0) {
          const normalizedBackgrounds = sheetData.backgrounds.map(row => {
            const next = row.slice();
            while (next.length < width) next.push(null);
            return next.map(color => color || null);
          });
          range.setBackgrounds(normalizedBackgrounds);
        }

        sheet.autoResizeColumns(1, Math.min(width, 20));
      }
    }

    cleanupGeneratedSheets_(spreadsheet, payload.cleanup_sheet_titles || [], writtenTitles);

    return jsonResponse({
      ok: true,
      synced_at: payload.synced_at,
      sheet_count: (payload.sheets || []).length,
    });
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateSheet_(spreadsheet, title) {
  return spreadsheet.getSheetByName(title) || spreadsheet.insertSheet(title);
}

function cleanupGeneratedSheets_(spreadsheet, titlesToRemove, titlesToKeep) {
  const keep = new Set(titlesToKeep || []);
  for (const title of titlesToRemove || []) {
    if (keep.has(title)) continue;
    const sheet = spreadsheet.getSheetByName(title);
    if (sheet && spreadsheet.getSheets().length > 1) {
      spreadsheet.deleteSheet(sheet);
    }
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
```

## Manual run

After setting the two Google-related GitHub secrets, open GitHub Actions, choose `Backup ensemble to Google Sheets`, and run it manually once. If it succeeds, the scheduled backup will continue every 10 minutes.
