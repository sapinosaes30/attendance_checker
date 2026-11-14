# ClassPing v2

ClassPing v2 is a phone-friendly attendance manager built with Node.js, Express, plain HTML/CSS/JavaScript, Supabase, Render, and PDFKit. It preserves the existing date-based attendance records while adding a unified historical attendance sheet and XLSX, CSV, and PDF exports.

## Roles

- **Administrator**: records, edits, finalizes, and reopens attendance; manages the roster, class information, and weekday subjects; downloads attendance; and views the persistent download log and private JSON backup.
- **Viewer**: can only open the unified attendance sheet and download attendance files. Viewer write attempts are rejected by the server, even if a hidden control is manually requested.

The internal role value `monitor` and the Render environment variable `MONITOR_PASSWORD` are retained for compatibility. Only the visible label changed to Administrator.

ClassPing uses shared role passwords rather than named user accounts. The download log therefore attributes an export to the Administrator or Viewer role, not to a specific person.

## Project files

```text
attendance_checker-main/
  config/
    default-data.json
    supabase-setup.sql
    supabase-download-history.sql
  data/
  lib/
    export-utils.js
  public/
    app.js
    index.html
    styles.css
  test/
    export-utils.test.js
  server.js
  package.json
  render.yaml
  README.md
  CHANGELOG.md
  TEST-REPORT.md
  DEPLOYMENT.md
  .env.example
```

The `default-data.json` file contains class roster information. Keep the GitHub repository private and do not share the ZIP publicly.

## Before official use

The starter configuration contains the class roster and weekday subjects carried over from the existing project. Review every student name, subject name, school heading, adviser, Administrator signature name, and attendance symbol in **Class setup** before submitting official records. The official-style PDF preserves the existing layout approach, but it is based on a photographed form rather than an original blank document; check print preview and school requirements instead of assuming pixel-perfect reproduction. Draft period PDFs are labeled **DRAFT - FOR REVIEW**; finalize the date after checking all marks before using an official copy.

## Install and run locally

1. Install Node.js 20 or newer.
2. Extract the project ZIP.
3. Open a terminal or PowerShell in the extracted project folder (the folder containing `package.json`).
4. Copy `.env.example` to `.env` and set a long random `SESSION_SECRET`, a strong `MONITOR_PASSWORD`, and a different `VIEWER_PASSWORD`.
5. Leave `SUPABASE_URL` and `SUPABASE_SECRET_KEY` blank to use local JSON storage, or enter your own Supabase project values for a connected test environment.
6. Run:

```powershell
npm install
npm start
```

7. Open `http://localhost:3000`.

Local-only fallback passwords are available only when the matching variables are not set and `NODE_ENV` is not `production`:

- Administrator: `monitor1234`
- Viewer: `class1234`

Set your own passwords before anyone else uses the application. Production startup refuses to run without `SESSION_SECRET`, `MONITOR_PASSWORD`, `VIEWER_PASSWORD`, `SUPABASE_URL`, and a server key (`SUPABASE_SECRET_KEY` or the legacy `SUPABASE_SERVICE_ROLE_KEY`).

## Supabase setup and safe migration

### Existing attendance database

The original application stores class information and attendance in the `public.classping_state` JSONB table. The updated application continues to use that table and its existing data structure.

**Do not delete, truncate, recreate, or replace `classping_state`. Do not upload `config/default-data.json` over your live class data.** For local JSON development, the starter file initializes a new local data folder. In production, if Supabase has no existing `classping_state` row, the server now stops instead of inserting the ZIP's starter roster. Verify the configured project and restore/initialize the intended state deliberately before restarting.

If you are creating a completely new Supabase project, run `config/supabase-setup.sql` once to create the original state table. If you already have the live ClassPing database, do not rerun setup just to deploy this update.

### Add the download-history table

Before deploying this version to a Supabase-backed Render service:

1. Open the existing Supabase project.
2. Open **SQL Editor** and start a new query.
3. Copy and run the complete contents of `config/supabase-download-history.sql`.
4. Confirm that the new `classping_download_history` table appears in the public schema.

This is an additive migration. It creates a separate audit table and index, enables Row Level Security, and removes direct access for browser roles. It does not change or delete `classping_state` or any attendance record. The server accesses both tables using the server-only Supabase Secret key.

Rollback guidance: to roll back the application code, redeploy the previous version and leave the new table in place. Keeping the table is safe and preserves download logs. Do not drop it unless you intentionally want to permanently erase the download history.

The download log is written after the server has successfully finished sending the export response. A disconnected or failed response is not recorded as a successful download. A server/database failure while writing the log is reported in the Render logs; it does not invalidate the already-sent file.

## Render deployment

The included `render.yaml` keeps the existing Render Blueprint setup and environment-variable names.

1. Keep the GitHub repository **Private**. The starter configuration includes class roster data.
2. Back up the existing repository and preserve the current deployed commit before replacing files.
3. Upload the contents of this project folder to the repository root. `package.json`, `server.js`, `render.yaml`, `config/`, `lib/`, and `public/` should be at the root level.
4. In the existing Render service, confirm these environment variables are present:
   - `NODE_ENV=production`
   - `SESSION_SECRET` — a long random secret (the Blueprint may generate this automatically)
   - `MONITOR_PASSWORD` — administrator password
   - `VIEWER_PASSWORD` — separate viewer password
   - `SUPABASE_URL` — existing Supabase project URL
   - `SUPABASE_SECRET_KEY` — existing server-side Supabase Secret key
5. Do not change the existing Supabase URL or key to a different project. Do not expose the Secret key in GitHub, `.env.example`, frontend files, screenshots, or messages.
6. Deploy the updated repository through the existing Render service or Blueprint.
7. Open `/health` and confirm it returns `{ "ok": true }`. Then log in as Administrator and Viewer and perform the role checks below.

The project keeps the original Render + Supabase + private GitHub hosting design and does not require a paid library or hosting-provider migration. Free-tier pricing, quotas, sleep/pause policies, and availability can change; check the providers' current terms rather than treating this setup as a guaranteed $0 or always-on service. The Render filesystem is temporary, so production storage must remain connected to Supabase. Local JSON storage is for development only.

## Attendance and unified sheet

- Attendance is saved as a draft while the Administrator marks students.
- Statuses are stored as `P`, `A`, `L`, and `E`; the class-configured symbols are displayed in the sheet and existing PDF output.
- A day cannot be finalized while a student/subject cell remains unmarked.
- Finalized records are read-only until an Administrator reopens the date.
- When a student is removed from the current roster, the student is archived instead of having their old attendance marks deleted. Former students remain visible in the unified historical sheet and exports; adding the same name back can reuse the archived ID. This protects marks going forward; marks deleted by an older version before this update cannot be reconstructed from the current state.
- The unified sheet shows students as rows and date/subject combinations as columns. It supports a month filter and horizontal scrolling; the student column remains sticky while scrolling.
- The app keeps the previous daily, weekly, and monthly official-layout PDF exports.

## Export formats and history

Both roles can download:

- **XLSX**: all saved dates and subjects in one workbook, with frozen student-identification columns and header filters.
- **CSV**: the same all-history matrix in one CSV file.
- **PDF**: a printable all-history matrix. Very wide or long records are split into multiple landscape pages within one PDF.
- **Daily, weekly, and monthly PDFs**: original period-based official-sheet exports.

Administrators additionally have access to the JSON backup and persistent download history. The history stores the role, timestamp, file format, export scope, filename, number of dates included, and basic export details. It is append-only in the application; there is no delete or clear-history control.

## Security notes

- Session cookies are HttpOnly, SameSite=Lax, signed, and expire after seven days. Production cookies use Secure.
- The server checks the Administrator role on every attendance or class-setup write endpoint. Hiding a button is not the security boundary.
- Viewer navigation is restricted to the unified attendance sheet and downloads. Attempts to open Administrator-only pages are redirected to an allowed Viewer page.
- The server-side Supabase Secret key must never be sent to the browser.
- Login throttling is in-memory per application process. It is useful for basic protection but is not a distributed rate limiter; deployments with multiple instances would need shared rate-limit storage.
- Because the two roles use shared passwords, the application cannot identify a specific person in a download log. Use individual accounts if individual attribution becomes a requirement.

## Verification checklist after deployment

1. Sign in as Administrator. Confirm the Overview, Take attendance, Attendance sheet, Daily records, Downloads, and Class setup sections are available.
2. Save a test mark on a non-critical date, verify the sheet reflects it, and then remove/revert the test entry if needed. Do not use a real historical date for an unapproved test.
3. Sign out and sign in as Viewer. Confirm the only available destinations are Attendance sheet and Downloads.
4. As Viewer, attempt a write request to an attendance endpoint and the class setup endpoint. Both should return HTTP 403.
5. As Viewer, attempt `/api/backup` and `/api/download-history`. Both should return HTTP 403.
6. Download XLSX, CSV, and PDF. Open the files and check dates, subjects, student names, and marks.
7. Sign in as Administrator and confirm the download history shows successful exports.
8. Sign out and confirm the login screen returns.

## Tests and known limits

Run the automated local checks with:

```powershell
npm test
```

The test suite covers matrix construction, CSV escaping, XLSX package structure, the production Supabase fail-safe, and source-level role checks. A PDFKit generation test is included but will be skipped when dependencies are unavailable. The suite does not connect to your live Render or Supabase account. Before changing the live repository, run the deployment checklist above against your existing database.

The historical PDF is a compact landscape matrix and may use multiple pages for wide or large attendance histories. Very large class histories will produce larger downloads. Existing period PDFs retain their original official-sheet style.
