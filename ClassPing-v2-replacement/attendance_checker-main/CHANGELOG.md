# ClassPing v2 — Changelog

## Updated project build — November 14, 2026

### Added
- Unified historical attendance sheet: students are rows; saved date/subject combinations are columns.
- Month filter, horizontal scrolling, and a sticky student-name column for smaller screens.
- All-history CSV and XLSX exports for both signed-in roles.
- All-history landscape PDF export, split across pages as needed.
- XLSX worksheet splitting when a history exceeds Excel's 16,384-column worksheet limit.
- Persistent download log with role, time, format, scope, filename, date count, and basic details.
- Additive Supabase migration for `classping_download_history`.
- Former-student archive so removing a student from the active roster no longer deletes their historical attendance marks.
- `.env.example`, deployment notes, and automated tests.

### Changed
- Replaced the blue-and-white interface with a restrained charcoal, dark-brown, and muted-bronze palette.
- Updated the user-facing role label from “Class Monitor” to “Administrator” while retaining the internal `monitor` role and `MONITOR_PASSWORD` environment variable.
- Restricted Viewer navigation to Attendance sheet and Downloads.
- Restricted Viewer access to the unified sheet and authenticated exports; administrator-only routes remain protected on the server.
- Added basic security response headers and production HSTS.
- Strengthened roster ID and subject-key validation and CSV spreadsheet-formula protection.
- Minimized Viewer bootstrap and sheet responses to only the roster, marks, and class-symbol fields needed to view attendance.
- Production startup now refuses to seed a missing Supabase state row from the ZIP starter data.
- Moved the project README to the repository root.

### Preserved
- Existing Supabase `classping_state` JSONB storage and current attendance structure.
- Existing login flow and authentication-race guard.
- Daily attendance workflow, draft autosave, review, finalization, reopening, and class setup.
- Existing daily, weekly, and monthly official-layout PDF exports.
- Administrator JSON backup.
- Render Blueprint, start command, health check, and existing environment variable names.

### Database impact
- No changes are made to `classping_state` by the new migration.
- The new download-history table is created only when the owner manually runs `config/supabase-download-history.sql`.
- No live Supabase database or Render deployment was accessed or changed during this local build.
