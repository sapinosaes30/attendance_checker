# ClassPing v2 — Local Test Report

**Test date:** November 14, 2026  
**Workspace:** Uploaded project ZIP, separate working copy  
**Runtime:** Node.js v22.16.0

## Results

| Check | Result | Notes |
|---|---|---|
| `node --check server.js` | PASS | Backend syntax check |
| `node --check public/app.js` | PASS | Frontend syntax check |
| `node --check lib/export-utils.js` | PASS | Export utility syntax check |
| `node --check test/export-utils.test.js` | PASS | Test-file syntax check |
| `npm test` | 10 passed, 0 failed, 1 skipped | PDFKit-specific test skipped because dependencies could not be installed in this offline workspace |
| CSV generation | PASS | Quoting, UTF-8 BOM, and spreadsheet-formula prefix protection covered by automated test; sample CSV read-back also passed |
| XLSX package | PASS | ZIP structure, worksheet content, frozen columns, filters, and wide-history worksheet splitting covered by automated tests |
| XLSX XML validation | PASS | Generated sample workbook passed ZIP integrity and XML parsing checks |
| SQL migration review | PASS | Test confirms migration creates a new table, enables RLS, revokes browser-role access, and does not drop/truncate or alter `classping_state` |
| Role route review | PASS (static) | Source-level checks confirm administrator middleware is applied to write and admin-only endpoints; this is not a live HTTP authorization test |
| Security headers | PASS (static) | Source includes CSP, no-sniff, same-origin referrer/resource policy, frame denial, and production HSTS |
| Production data fail-safe | PASS (static) | Source check confirms production refuses to seed a missing Supabase state row from ZIP defaults |
| History pagination | PASS (static) | Source check confirms offsets are not capped at one million entries |
| Viewer navigation review | PASS (static) | Source-level checks confirm the non-Viewer sections are marked Administrator-only |
| Project/config parse and file review | PASS | JSON configuration parsed; all 18 project files are present; 79 HTML IDs are unique; referenced frontend assets exist |
| Former-student preservation | PASS | Matrix and setup logic retain former students and their historical marks |

## Not run / not verified

- `npm install` and `npm start`: not run because this execution environment had no installed `express` or `pdfkit`, and the npm registry could not be reached (`EAI_AGAIN`).
- PDF generation: the automated PDFKit test is included but skipped because PDFKit is unavailable in this workspace.
- Live login, logout, cookie persistence, and session expiration: not verified against a running Express server.
- Actual HTTP 401/403 behavior: route protection was checked in source, but no server-level integration test ran.
- Live Supabase read/write, RLS, and download-history insertion: not tested; no Supabase credentials were supplied or used.
- Render build, deployment, and phone-browser rendering: not tested.

## Interpretation

The checks establish JavaScript syntax correctness and exercise the pure attendance-matrix, archived-student export, CSV, XLSX, wide-workbook, migration-review, production fail-safe, source-level permission, and Viewer data-minimization checks. They do **not** establish that the application has passed end-to-end runtime testing. Complete the post-deployment checklist in `DEPLOYMENT.md` after backing up the existing repository and before relying on the updated app for official attendance.
