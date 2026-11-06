# ClassPing Attendance

A phone-first classroom attendance recorder for Grade 9 - NEON. The class monitor records and finalizes attendance; classmates can sign in read-only and view/export records. The app generates daily, weekly, and monthly PDFs using the photographed official-sheet structure: boys/girls roster, date groups, rotated subject headings, student marks, adviser line, and class-monitor signature line.

## Cost: $0/month architecture

- **Render Free Web Service:** hosts the Node.js app and API.
- **Supabase Free:** stores the app's shared attendance state in Postgres.
- **GitHub Free:** stores the source in a private repository.
- No Render persistent disk, paid Render database, paid Supabase project, custom domain, paid add-on, or paid library is required.

The Render filesystem is temporary, so production data is stored in Supabase instead of a local JSON file. The Supabase Secret key is used only on the server and must never be committed to GitHub or placed in browser code.

Free plans have operating limits; see **Free-plan limitations** below. Do not upgrade either service or add paid products if you need to keep the project at $0.

## Before official use

- The roster and weekday subject lists are prefilled from the photos you supplied. The roster contains 18 boys and 12 girls. **Verify every name and subject spelling in Class setup before using the PDFs for official submission.** A few characters in the photographed sheet and timetable are soft/blurry.
- The PDF recreates the visible structure of the photographed form. Since the source is an angled photo rather than a clean blank template or original document, it cannot guarantee pixel-for-pixel reproduction of the original stationery, logos, fonts, or exact print margins.
- Default attendance statuses are Present (`/`), Absent (`A`), Late (`L`), and Excused (`E`). The printed symbols can be edited in Class setup.
- Draft PDF pages are labeled **DRAFT - FOR REVIEW**. Finalize each date after checking it before submitting an official copy.

## Deploy using free services

### Part A — Create the free Supabase database

1. Create a Supabase account and create a project on the **Free** plan. Do not select Pro or add paid compute/storage.
2. Open the project's **SQL Editor**.
3. Open `config/supabase-setup.sql` from this project, copy its entire contents, paste it into the SQL Editor, and run it. This creates the `classping_state` table and blocks direct table access from browser roles.
4. In Supabase, open **Integrations → Data API** and copy the Project URL. It looks like `https://YOUR-PROJECT-REF.supabase.co`.
5. Open **Settings → API Keys**. Create/copy a **Secret key** beginning with `sb_secret_`. Use the new Secret key, not the Publishable key. The Secret key gives full database access and must stay on the server.
6. Keep the Supabase dashboard open; you will paste the Project URL and Secret key into Render in Part C.

### Part B — Put the project in a private GitHub repository

1. Extract this ZIP on your computer.
2. Create a **Private** GitHub repository named `classping-attendance`. Do not make it public; it contains classmates' names.
3. Upload the **contents** of this project folder to the repository root. `package.json`, `server.js`, `render.yaml`, `config/`, and `public/` should be directly at the root.
4. Confirm that `.env` is not uploaded. It is ignored by `.gitignore`.

### Part C — Deploy the free Render service

1. Create/sign in to Render.
2. Select **New + → Blueprint** and connect the private GitHub repository.
3. Render reads `render.yaml`. The service is configured with `plan: free` and has **no persistent disk**.
4. When Render asks for environment values, enter:
   - `MONITOR_PASSWORD`: a strong password only the class monitor knows.
   - `VIEWER_PASSWORD`: a different password to share with classmates for read-only access.
   - `SUPABASE_URL`: the Project URL copied in Part A.
   - `SUPABASE_SECRET_KEY`: the `sb_secret_...` key copied in Part A.
   - `SESSION_SECRET` is generated automatically by the Blueprint; leave it as generated.
   - `NODE_ENV` is set to `production` by the Blueprint.
5. Apply the Blueprint and wait for the first deploy to finish. Open the generated `onrender.com` URL.
6. On first launch, the server creates the initial class data in Supabase. Later deploys and restarts load saved data from Supabase.

**Important:** Do not put `SUPABASE_SECRET_KEY` in GitHub, `.env` files that you upload, `public/`, browser JavaScript, screenshots, or a class group chat. It belongs only in Render's private environment-variable settings. If it is ever exposed, revoke it in Supabase and create a replacement.

### Part D — First-time setup

1. Sign in as **Class monitor**.
2. Open **Class setup**.
3. Verify the school header, adviser, class monitor name, all 30 student names, and Monday–Friday subject lists.
4. Save the setup.
5. Open **Take attendance**, select a school date, and work through the listed subjects.
6. For each subject, tap **Everyone present**, then change only the exceptions (Absent, Late, or Excused).
7. Review the day and finalize it. Finalized records are read-only until the monitor reopens them.
8. Use **PDF downloads** for daily, weekly, or monthly exports.

## Free-plan limitations to know

- **Render Free sleeps:** after 15 minutes without inbound traffic, the web service spins down. The next visit wakes it, which can take about a minute. This does not erase Supabase attendance data.
- **Render Free has a temporary filesystem:** any data saved only to the Render app's local disk can disappear on restarts, deploys, or spin-down. This app uses Supabase for production storage instead.
- **Supabase Free can pause inactive projects:** if the database has too little activity over a week, Supabase may pause the project. Its data remains saved; restore the project from the Supabase dashboard. A few genuine app requests each day are usually enough to avoid a pause, but it is not guaranteed.
- **Free quotas apply:** Supabase Free currently includes 500 MB database storage and 5 GB egress. This class attendance dataset should be small, but usage can change as the app grows.
- **No automatic Supabase backups on Free:** the class monitor should download the **Full data backup** JSON from the Downloads screen regularly and keep it somewhere private. Also download monthly PDFs for paper records.
- Free services can be restarted, paused, or limited by their providers. This is a $0 hobby-project setup, not a guaranteed-uptime production service.

As long as you stay on the Render Free and Supabase Free plans and do not add paid products, this architecture has no required monthly subscription. Free-plan limits may temporarily affect availability; they do not make the app upgrade itself to a paid plan.

## Security and permissions

- Class monitor: can record, edit, reopen, finalize, change the roster/subjects, and download full JSON backups.
- Classmates: can view records and download daily, weekly, and monthly PDFs. They cannot edit attendance.
- The backend signs a session cookie and checks the monitor role on every write endpoint.
- Supabase's Secret key is stored only in Render environment variables. The database table has RLS enabled and direct access revoked for `anon` and `authenticated` roles.
- Keep the GitHub repo private. Share only the class website URL and viewer password with classmates.

## Attendance workflow

- Attendance is saved as a draft while the monitor marks students.
- `P`, `A`, `L`, and `E` are stored as statuses; the configured symbols are used when printing the PDF.
- A day cannot be finalized while any student/subject cell is unmarked.
- Only the monitor account can edit, reopen, or finalize attendance.
- Viewers can browse saved records and download PDFs.
- Monthly PDFs contain one page for each school week intersecting the selected month. This keeps the official wide attendance grid readable.
- The monitor can download a complete JSON backup from **Downloads → Full data backup**. Treat this file as confidential because it contains student names and attendance records.

## Run locally (optional)

1. Install Node.js 20 or newer.
2. Open PowerShell inside the project folder.
3. Copy `.env.example` to `.env`. For local testing you can leave the Supabase fields blank; the app then uses a local `./data` JSON file. To test against Supabase locally, fill in `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env`.
4. Set different passwords and a long random `SESSION_SECRET` in `.env`.
5. Run:

```powershell
npm install
npm start
```

6. Open `http://localhost:3000`.

Local default credentials (only when no `.env` is present):

- Class monitor: `monitor1234`
- Classmate view-only: `class1234`

Change these before sharing a local or deployed version.
