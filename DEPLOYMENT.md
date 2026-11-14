# ClassPing v2 — Safe Deployment Guide

This update is prepared for the existing Node.js + Express + Supabase + Render setup. It does not require a hosting change. Do not reset or replace the live Supabase attendance table.

## Before replacing anything

1. Keep the GitHub repository **Private**. The project contains class roster information.
2. In GitHub, open the existing repository and note the current deployed commit. Create a backup branch from that commit (for example, `backup-before-classping-update`) or download the current repository ZIP and keep it somewhere safe.
3. Do not share or upload `.env`, Supabase keys, passwords, cookies, or screenshots containing secrets.
4. Keep the existing Render environment-variable values. Do not generate a new Supabase project or point the app at a different database.

## Replace the project files

1. Download and extract the replacement ZIP.
2. Open the extracted `attendance_checker-main` folder. The files `package.json`, `server.js`, `render.yaml`, and `README.md` should be directly inside it.
3. Replace the tracked files in the existing GitHub repository with the extracted project contents. Add the new `lib/` folder, `test/` folder, migration SQL, and root documentation files.
4. Do not upload `.env`, `node_modules`, local `data/*.json`, temporary files, or private credentials. The provided `.env.example` contains placeholders only.
5. Commit the replacement files to the existing deployment branch after confirming the repository is still private.

## Add download history to Supabase

This build adds one separate table. Run this before the new app version attempts to write download history.

1. Open the **existing** Supabase project used by ClassPing.
2. Open **SQL Editor** and create a new query.
3. Open `config/supabase-download-history.sql` from the extracted project, copy the complete SQL, and run it.
4. Confirm `public.classping_download_history` appears in the table list.

The migration is additive: it creates the download-history table and a timestamp index, enables Row Level Security, revokes direct access from `anon` and `authenticated`, and grants the server role access. It does not modify `public.classping_state` or any existing attendance record. Production startup also refuses to seed an absent state row from the ZIP's default roster; check the existing database and Render's `SUPABASE_URL` before restarting if startup reports that no row exists.

Do **not** run `config/supabase-setup.sql` against the existing live project as part of this update. That file is only for a completely new Supabase setup.

## Check Render environment variables

In the existing Render web service, confirm these variables are set and unchanged:

- `NODE_ENV` = `production`
- `SESSION_SECRET` = an existing long random secret (keep the current value)
- `MONITOR_PASSWORD` = the existing Administrator password
- `VIEWER_PASSWORD` = the existing Viewer password
- `SUPABASE_URL` = the existing Supabase project URL
- `SUPABASE_SECRET_KEY` = the existing server-side Supabase Secret key

Do not paste any secret into GitHub or into a chat. The code still recognizes the legacy `SUPABASE_SERVICE_ROLE_KEY` variable if that is what an older service already uses, but the included Blueprint lists `SUPABASE_SECRET_KEY`.

## Deploy through Render

1. Open the existing Render service connected to the GitHub repository.
2. Confirm the build command is `npm install` and the start command is `npm start` (the included Blueprint keeps these settings).
3. Trigger a deploy of the updated branch/commit.
4. Watch the Render deploy logs. The service should install the listed dependencies and start without a missing-environment-variable or database error.
5. Open the service's `/health` URL. It should return `{ "ok": true }`.

## Verify the updated app

1. Sign in as Administrator. Check Overview, Take attendance, Attendance sheet, Daily records, Downloads, and Class setup.
2. Sign out. Sign in as Viewer. The only navigation destinations should be Attendance sheet and Downloads.
3. As Viewer, confirm the sheet loads and XLSX, CSV, PDF, and the existing period PDFs can be downloaded.
4. As Viewer, verify that attempts to save attendance, finalize/reopen a day, update setup, view JSON backup, and view download history are rejected (write/admin endpoints should return HTTP 403 after successful Viewer authentication).
5. As Administrator, download each format and refresh Download history. New entries should appear with the role and timestamp.
6. Confirm old attendance records still appear. Do not create test marks on real dates unless authorized.
7. Check the application on a phone: mobile navigation, attendance controls, sheet horizontal scrolling, sticky student column, and download buttons.

## Rollback

If the updated application has a problem, redeploy the previous GitHub commit or backup branch. Leave `classping_state` untouched. The new download-history table can safely remain in Supabase; it will not erase or change existing attendance data. Do not drop the new table unless you intentionally want to erase the download log.

## Important limitations

The delivered build was not connected to the live Supabase or Render accounts. Local tests covered syntax, data mapping, CSV/XLSX output, XLSX ZIP/XML integrity, static role-route checks, and migration safety. PDFKit runtime generation and end-to-end login/API tests still need to be verified by the deploy checklist above.
