'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { buildMatrix, makeCsv, makeXlsx, buildHistoryPdf } = require('../lib/export-utils');

function fixture() {
  return {
    classInfo: { presentMark: '/', absentMark: 'A', lateMark: 'L', excusedMark: 'E' },
    roster: [
      { id: 's1', name: 'Dela Cruz, Ana', gender: 'Girls' },
      { id: 's2', name: 'Santos, Ben', gender: 'Boys' }
    ],
    attendance: {
      '2026-11-04': {
        date: '2026-11-04', state: 'finalized', subjects: {
          Mathematics: { s1: 'P', s2: 'A' },
          English: { s1: 'L', s2: 'E' }
        }
      },
      '2026-11-03': {
        date: '2026-11-03', state: 'draft', subjects: {
          Biology: { s1: 'E' }
        }
      }
    }
  };
}

function readZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034B50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    entries.set(name, content.toString('utf8'));
    offset = dataStart + compressedSize;
  }
  return entries;
}

test('buildMatrix sorts historical dates and maps saved attendance codes', () => {
  const matrix = buildMatrix(fixture());
  assert.deepEqual(matrix.columns.map(column => `${column.date}:${column.subject}`), [
    '2026-11-03:Biology',
    '2026-11-04:Mathematics',
    '2026-11-04:English'
  ]);
  assert.deepEqual(matrix.rows[0].marks, ['E', '/', 'L']);
  assert.deepEqual(matrix.rows[1].marks, ['', 'A', 'E']);
  assert.equal(matrix.records.length, 2);
});

test('buildMatrix ignores invalid dates and unrecognized inherited attendance status keys', () => {
  const data = fixture();
  data.attendance['2026-99-99'] = { date: '2026-99-99', subjects: { Biology: { s1: 'P' } } };
  data.attendance['2026-11-05'] = { date: '2026-11-05', subjects: { Biology: { s1: 'constructor' } } };
  const matrix = buildMatrix(data);
  assert.equal(matrix.records.length, 3);
  const invalidStatusColumn = matrix.columns.findIndex(column => column.date === '2026-11-05');
  assert.equal(matrix.rows[0].marks[invalidStatusColumn], '');
  assert.equal(matrix.columns.some(column => column.date === '2026-99-99'), false);
});

test('buildMatrix includes archived students and preserves their historical marks', () => {
  const data = fixture();
  data.formerRoster = [{ id: 'old1', name: 'Former Student', gender: 'Boys' }];
  data.attendance['2026-11-03'].subjects.Biology.old1 = 'A';
  const matrix = buildMatrix(data);
  const former = matrix.rows.find(row => row.id === 'old1');
  assert.ok(former);
  assert.equal(former.name, 'Former Student');
  assert.equal(former.gender, 'Former (Boys)');
  assert.equal(former.isFormer, true);
  assert.deepEqual(former.marks, ['A', '', '']);
});

test('makeCsv quotes values and guards against spreadsheet formula injection', () => {
  const data = fixture();
  data.roster[0].name = '  =HYPERLINK("https://example.invalid")';
  const csv = makeCsv(buildMatrix(data));
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"Nov 3, 2026 - Biology"'));
  assert.ok(csv.includes('"\'  =HYPERLINK(""https://example.invalid"")"'));
  assert.ok(csv.includes('"/"'));
});

test('makeXlsx produces a valid OOXML zip with a frozen, filtered attendance matrix', () => {
  const workbook = makeXlsx(buildMatrix(fixture()));
  assert.equal(workbook.readUInt32LE(0), 0x04034B50);
  const entries = readZipEntries(workbook);
  assert.ok(entries.has('[Content_Types].xml'));
  assert.ok(entries.has('xl/workbook.xml'));
  assert.ok(entries.has('xl/worksheets/sheet1.xml'));
  const sheet = entries.get('xl/worksheets/sheet1.xml');
  assert.ok(sheet.includes('state="frozen"'));
  assert.ok(sheet.includes('<autoFilter'));
  assert.ok(sheet.includes('Mathematics'));
  assert.ok(sheet.includes('Nov 4, 2026'));
  assert.ok(sheet.includes('Dela Cruz, Ana'));
});

test('download-history SQL is additive and does not alter the live attendance table', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'config', 'supabase-download-history.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.classping_download_history/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on table public\.classping_download_history from anon, authenticated/i);
  assert.doesNotMatch(sql, /\b(drop|truncate)\b/i);
  assert.doesNotMatch(sql, /alter table public\.classping_state/i);
});

test('makeXlsx splits an exceptionally wide history across worksheets without dropping columns', () => {
  const columnCount = 16382;
  const matrix = {
    columns: Array.from({ length: columnCount }, (_, i) => ({ date: '2026-11-14', label: 'Nov 14, 2026', subject: `Subject ${i + 1}`, key: `k${i}` })),
    rows: [{ id: 's1', name: 'Student', gender: 'Girls', marks: Array.from({ length: columnCount }, (_, i) => String(i % 4)) }]
  };
  const entries = readZipEntries(makeXlsx(matrix));
  assert.ok(entries.has('xl/worksheets/sheet1.xml'));
  assert.ok(entries.has('xl/worksheets/sheet2.xml'));
  assert.ok(entries.get('xl/workbook.xml').includes('Attendance 2'));
  assert.ok(entries.get('xl/worksheets/sheet2.xml').includes('Subject 16382'));
});

test('server protects modification and administrative endpoints on the backend', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const route of [
    "app.get('/api/attendance/:date', requireAuth, requireMonitor",
    "app.put('/api/attendance/:date', requireAuth, requireMonitor",
    "app.post('/api/attendance/:date/finalize', requireAuth, requireMonitor",
    "app.post('/api/attendance/:date/reopen', requireAuth, requireMonitor",
    "app.put('/api/setup', requireAuth, requireMonitor",
    "app.get('/api/records', requireAuth, requireMonitor",
    "app.get('/api/backup', requireAuth, requireMonitor",
    "app.get('/api/download-history', requireAuth, requireMonitor"
  ]) assert.ok(server.includes(route), `Missing server-side permission check: ${route}`);
  assert.ok(server.includes("app.get('/api/sheet', requireAuth"), 'Viewer sheet must require authentication');
  assert.match(server, /classInfo: isAdministrator \? data\.classInfo : \{ gradeSection: data\.classInfo\.gradeSection \}/);
  assert.match(server, /roster: isAdministrator \? data\.roster : \[\]/);
  assert.ok(server.includes("app.get('/api/export', requireAuth"), 'Both roles must be able to export after authentication');
  assert.ok(server.includes('archived.set(student.id'), 'Removed students must be archived');
  assert.ok(server.includes('Attendance marks are retained'), 'Roster updates must preserve historical marks');
  assert.doesNotMatch(server, /for \(const id of Object\.keys\(marks\)\) if \(!ids\.has\(id\)\) delete marks\[id\]/);
  assert.ok(server.includes('Content-Security-Policy'), 'Security headers must include a restrictive content policy');
});

test('production startup refuses to seed Supabase from the ZIP starter data', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /if \(IS_PROD\) \{\s*throw new Error\('No existing classping_state row was found[\s\S]*?Refusing to initialize production Supabase from default-data\.json/i);
  assert.match(server, /const requestedOffset = Number\.parseInt\(req\.query\.offset, 10\);[\s\S]*?Number\.isSafeInteger\(requestedOffset\)/);
});

test('frontend provides only sheet and downloads as Viewer navigation targets', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /data-view="sheet"/);
  assert.match(html, /data-view="downloads"/);
  assert.match(html, /class="[^"]*monitor-only[^"]*" data-view="home"/);
  assert.match(html, /class="[^"]*monitor-only[^"]*" data-view="attendance"/);
  assert.match(html, /class="[^"]*monitor-only[^"]*" data-view="records"/);
  assert.match(html, /class="[^"]*monitor-only[^"]*" data-view="settings"/);
});

test('buildHistoryPdf emits a PDF when PDFKit is installed', { skip: (() => { try { require.resolve('pdfkit'); return false; } catch { return 'PDFKit is installed by npm install; skipped in this offline workspace.'; } })() }, async () => {
  const pdf = await buildHistoryPdf(buildMatrix(fixture()));
  assert.ok(pdf.subarray(0, 5).toString('ascii') === '%PDF-');
});
