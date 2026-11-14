'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { buildMatrix, makeCsv, makeXlsx, buildHistoryPdf } = require('./lib/export-utils');

// Load a local .env file when developing on a laptop; Render supplies env vars itself.
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch (err) { console.warn('Could not read local .env file:', err.message); }

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'classping-data.json');
const DOWNLOAD_HISTORY_FILE = path.join(DATA_DIR, 'classping-download-history.json');
const DEFAULT_FILE = path.join(__dirname, 'config', 'default-data.json');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''; // Legacy fallback only.
const SUPABASE_API_KEY = SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_TABLE = 'classping_state';
const DOWNLOAD_HISTORY_TABLE = 'classping_download_history';
const USE_SUPABASE = Boolean(SUPABASE_URL || SUPABASE_API_KEY);
const SESSION_SECRET = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-development-secret-change-this');
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE_NAME = 'classping_session';
const SESSION_SECONDS = 60 * 60 * 24 * 7;

if (IS_PROD && (!SESSION_SECRET || !process.env.MONITOR_PASSWORD || !process.env.VIEWER_PASSWORD)) {
  console.error('Missing SESSION_SECRET, MONITOR_PASSWORD, or VIEWER_PASSWORD environment variable.');
  process.exit(1);
}
if (IS_PROD && (!SUPABASE_URL || !SUPABASE_API_KEY)) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY. Configure Supabase before deploying the production service.');
  process.exit(1);
}
if (USE_SUPABASE && (!SUPABASE_URL || !SUPABASE_API_KEY)) {
  console.error('Supabase storage requires both SUPABASE_URL and SUPABASE_SECRET_KEY.');
  process.exit(1);
}
if (IS_PROD && !SUPABASE_URL.startsWith('https://')) {
  console.error('SUPABASE_URL must use HTTPS in production.');
  process.exit(1);
}

app.disable('x-powered-by');
// Render terminates TLS at its proxy; trust only the single proxy hop.
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'");
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  setHeaders(res, filePath) {
    // Always revalidate frontend files so a deployment cannot leave a stale
    // login script or stylesheet cached in a classmate's browser.
    if (/\.(?:html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

let data;
let writeQueue = Promise.resolve();
let downloadWriteQueue = Promise.resolve();
let localDownloadHistory = [];

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
function safeString(value, max = 160) { return String(value ?? '').trim().slice(0, max); }
const RESERVED_OBJECT_KEYS = new Set([
  '__proto__', 'prototype', 'constructor', 'tostring', 'tolocalestring',
  'valueof', 'hasownproperty', 'isprototypeof', 'propertyisenumerable'
]);
function safeObjectKey(value) {
  const key = safeString(value, 70);
  return key && !RESERVED_OBJECT_KEYS.has(key.toLowerCase()) && !/[\u0000-\u001f]/.test(key);
}
function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';').map(value => value.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try { cookies[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1)); }
    catch { /* Ignore malformed cookie values rather than failing the request. */ }
  }
  return cookies;
}
function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}
function createSession(role) {
  const payload = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, nonce: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function getSession(req) {
  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (session.exp < Math.floor(Date.now() / 1000) || !['monitor', 'viewer'].includes(session.role)) return null;
    return session;
  } catch { return null; }
}
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Please sign in to continue.' });
  req.session = session;
  next();
}
function requireMonitor(req, res, next) {
  if (req.session?.role !== 'monitor') return res.status(403).json({ error: 'Only an administrator can make changes.' });
  next();
}
function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
function weekdayName(date) { return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Manila' }).format(new Date(`${date}T12:00:00+08:00`)); }
function dateLabel(date, options = {}) {
  return new Intl.DateTimeFormat('en-US', { month: options.short ? 'short' : 'long', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' }).format(new Date(`${date}T12:00:00+08:00`));
}
function monthLabel(year, month) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'Asia/Manila' }).format(new Date(Date.UTC(year, month - 1, 15)));
}
function mondayOf(dateString) {
  const d = new Date(`${dateString}T12:00:00+08:00`);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function datePlus(dateString, days) {
  const d = new Date(`${dateString}T12:00:00+08:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function weekOfMonth(dateString) {
  const d = new Date(`${dateString}T12:00:00+08:00`);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  return Math.floor((d.getDate() + offset - 1) / 7) + 1;
}
function getDatesForWeek(weekStart, monthFilter = null) {
  const out = [];
  for (let i = 0; i < 5; i++) {
    const date = datePlus(weekStart, i);
    if (!monthFilter || date.slice(0, 7) === monthFilter) out.push(date);
  }
  return out;
}

function supabaseHeaders(extra = {}) {
  const headers = {
    apikey: SUPABASE_API_KEY,
    'Content-Type': 'application/json',
    ...extra
  };
  // New sb_secret keys are not JWTs and must not be sent as Bearer tokens.
  if (!SUPABASE_SECRET_KEY && SUPABASE_SERVICE_ROLE_KEY) {
    headers.Authorization = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  }
  return headers;
}

async function supabaseRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: supabaseHeaders(options.headers || {}) });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Supabase storage request failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response;
}

async function readSupabaseState() {
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?id=eq.main&select=state`;
  const response = await supabaseRequest(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0].state : null;
}

async function writeSupabaseState(snapshot) {
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?on_conflict=id`;
  await supabaseRequest(url, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 'main', state: JSON.parse(snapshot), updated_at: new Date().toISOString() })
  });
}

async function initData() {
  if (USE_SUPABASE) {
    data = await readSupabaseState();
    if (!data) {
      // Never seed a production Supabase project from the ZIP's starter roster.
      // A missing row should stop deployment until the existing database is checked.
      if (IS_PROD) {
        throw new Error('No existing classping_state row was found. Refusing to initialize production Supabase from default-data.json. Verify SUPABASE_URL and the existing database before restarting.');
      }
      data = JSON.parse(await fs.promises.readFile(DEFAULT_FILE, 'utf8'));
      await persist();
    }
  } else {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    try {
      const raw = await fs.promises.readFile(DATA_FILE, 'utf8');
      data = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      data = JSON.parse(await fs.promises.readFile(DEFAULT_FILE, 'utf8'));
      await persist();
    }
  }
  if (!data.attendance) data.attendance = {};
  if (!data.auditLog) data.auditLog = [];
  if (!Array.isArray(data.formerRoster)) data.formerRoster = [];
  if (!USE_SUPABASE) {
    try {
      const rawHistory = await fs.promises.readFile(DOWNLOAD_HISTORY_FILE, 'utf8');
      const parsedHistory = JSON.parse(rawHistory);
      localDownloadHistory = Array.isArray(parsedHistory) ? parsedHistory : [];
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      localDownloadHistory = [];
    }
  }
}
function persist() {
  const snapshot = JSON.stringify(data, null, 2);
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    if (USE_SUPABASE) {
      await writeSupabaseState(snapshot);
      return;
    }
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const temp = `${DATA_FILE}.tmp`;
    await fs.promises.writeFile(temp, snapshot, 'utf8');
    await fs.promises.rename(temp, DATA_FILE);
  });
  return writeQueue;
}
function addAudit(actor, action, date, detail = '') {
  data.auditLog.unshift({ at: new Date().toISOString(), actor, action, date, detail });
  data.auditLog = data.auditLog.slice(0, 500);
}
function getAttendanceRoster() {
  const active = data.roster || [];
  const activeIds = new Set(active.map(student => student.id));
  const former = (data.formerRoster || [])
    .filter(student => student && student.id && !activeIds.has(student.id))
    .map(student => ({ ...student, isFormer: true }));
  return [...active.map(student => ({ ...student, isFormer: false })), ...former];
}
function getSubjectsForDate(date) {
  const day = weekdayName(date);
  return data.subjectsByDay?.[day] || [];
}
function getOrCreateRecord(date) {
  if (!data.attendance[date]) {
    const subjects = {};
    for (const subject of getSubjectsForDate(date)) subjects[subject] = {};
    data.attendance[date] = { date, state: 'draft', subjects, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }
  const record = data.attendance[date];
  for (const subject of getSubjectsForDate(date)) if (!record.subjects[subject]) record.subjects[subject] = {};
  return record;
}
function checkPassword(input, expected) {
  if (!expected || typeof input !== 'string' || input.length > 256) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function persistDownloadHistory(entry) {
  if (USE_SUPABASE) {
    const url = `${SUPABASE_URL}/rest/v1/${DOWNLOAD_HISTORY_TABLE}`;
    await supabaseRequest(url, {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(entry)
    });
    return;
  }
  downloadWriteQueue = downloadWriteQueue.catch(() => {}).then(async () => {
    localDownloadHistory.unshift(entry);
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const temporary = `${DOWNLOAD_HISTORY_FILE}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(localDownloadHistory, null, 2), 'utf8');
    await fs.promises.rename(temporary, DOWNLOAD_HISTORY_FILE);
  });
  return downloadWriteQueue;
}

function logDownloadAfterResponse(req, res, details) {
  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const entry = {
      downloaded_at: new Date().toISOString(),
      role: req.session.role,
      format: details.format,
      scope: details.scope,
      filename: details.filename,
      record_count: Number(details.recordCount || 0),
      details: details.details || {}
    };
    persistDownloadHistory(entry).catch(err => console.error('Could not save download history:', err.message));
  });
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/me', (req, res) => {
  const session = getSession(req);
  res.json({ authenticated: !!session, role: session?.role || null });
});
const loginAttempts = new Map();
function cleanupLoginAttempts() {
  const now = Date.now();
  for (const [ip, attempt] of loginAttempts) {
    if (attempt.until <= now && now - attempt.lastAttempt > 10 * 60 * 1000) loginAttempts.delete(ip);
  }
  while (loginAttempts.size > 10000) loginAttempts.delete(loginAttempts.keys().next().value);
}
const loginCleanupTimer = setInterval(cleanupLoginAttempts, 5 * 60 * 1000);
loginCleanupTimer.unref?.();
app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const attempt = loginAttempts.get(ip) || { count: 0, until: 0, lastAttempt: Date.now() };
  if (attempt.until > Date.now()) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in a few minutes.' });
  const { role, password } = req.body || {};
  if (!['monitor', 'viewer'].includes(role) || typeof password !== 'string' || password.length > 256) return res.status(400).json({ error: 'Choose an account type and enter its password.' });
  const expected = role === 'monitor' ? (process.env.MONITOR_PASSWORD || 'monitor1234') : (process.env.VIEWER_PASSWORD || 'class1234');
  if (!checkPassword(password, expected)) {
    attempt.count += 1;
    attempt.lastAttempt = Date.now();
    if (attempt.count >= 8) { attempt.until = Date.now() + 5 * 60 * 1000; attempt.count = 0; }
    loginAttempts.set(ip, attempt);
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  loginAttempts.delete(ip);
  const token = createSession(role);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${IS_PROD ? '; Secure' : ''}`);
  res.json({ ok: true, role });
});
app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${IS_PROD ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.get('/api/bootstrap', requireAuth, (req, res) => {
  const summaries = Object.values(data.attendance)
    .filter(record => record && validDate(record.date))
    .map(record => ({
      date: record.date,
      state: record.state,
      subjectCount: Object.keys(record.subjects || {}).length,
      updatedAt: record.updatedAt
    })).sort((a, b) => b.date.localeCompare(a.date));
  const isAdministrator = req.session.role === 'monitor';
  res.json({
    role: req.session.role,
    // Viewers only need the class label for the shell. The actual roster and
    // attendance are provided separately by /api/sheet when they open it.
    classInfo: isAdministrator ? data.classInfo : { gradeSection: data.classInfo.gradeSection },
    roster: isAdministrator ? data.roster : [],
    formerRoster: isAdministrator ? data.formerRoster : [],
    subjectsByDay: isAdministrator ? data.subjectsByDay : {},
    records: isAdministrator ? summaries : [],
    studentCount: data.roster.length
  });
});

app.get('/api/attendance/:date', requireAuth, requireMonitor, (req, res) => {
  const date = req.params.date;
  if (!validDate(date)) return res.status(400).json({ error: 'Invalid date.' });
  const existing = data.attendance[date] || null;
  res.json({ date, day: weekdayName(date), subjects: existing ? Object.keys(existing.subjects || {}) : getSubjectsForDate(date), record: existing });
});

app.put('/api/attendance/:date', requireAuth, requireMonitor, asyncHandler(async (req, res) => {
  const date = req.params.date;
  if (!validDate(date)) return res.status(400).json({ error: 'Invalid date.' });
  const previous = data.attendance[date];
  if (previous?.state === 'finalized') return res.status(409).json({ error: 'This date is finalized. Reopen it before making corrections.' });
  const expectedSubjects = previous ? Object.keys(previous.subjects || {}) : getSubjectsForDate(date);
  const incoming = req.body?.subjects;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return res.status(400).json({ error: 'Attendance data is missing.' });
  const nextSubjects = {};
  for (const subject of expectedSubjects) {
    const raw = incoming[subject] || {};
    const clean = {};
    for (const student of data.roster) {
      const value = raw[student.id];
      if (value === 'P' || value === 'A' || value === 'L' || value === 'E') clean[student.id] = value;
    }
    nextSubjects[subject] = clean;
  }
  data.attendance[date] = {
    date,
    state: previous?.state === 'finalized' ? 'draft' : 'draft',
    subjects: nextSubjects,
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  addAudit('monitor', 'saved draft', date);
  await persist();
  res.json({ ok: true, record: data.attendance[date] });
}));

app.post('/api/attendance/:date/finalize', requireAuth, requireMonitor, asyncHandler(async (req, res) => {
  const date = req.params.date;
  if (!validDate(date)) return res.status(400).json({ error: 'Invalid date.' });
  const record = data.attendance[date];
  if (!record) return res.status(400).json({ error: 'Record attendance before finalizing.' });
  const missing = [];
  for (const subject of Object.keys(record.subjects || {})) {
    const marks = record.subjects?.[subject] || {};
    for (const student of data.roster) if (!['P', 'A', 'L', 'E'].includes(marks[student.id])) missing.push({ subject, student: student.name });
  }
  if (missing.length) return res.status(400).json({ error: `${missing.length} attendance cell(s) are still unmarked.`, missingCount: missing.length });
  record.state = 'finalized';
  record.finalizedAt = new Date().toISOString();
  record.updatedAt = new Date().toISOString();
  addAudit('monitor', 'finalized', date);
  await persist();
  res.json({ ok: true, record });
}));

app.post('/api/attendance/:date/reopen', requireAuth, requireMonitor, asyncHandler(async (req, res) => {
  const date = req.params.date;
  if (!validDate(date) || !data.attendance[date]) return res.status(404).json({ error: 'Attendance record not found.' });
  data.attendance[date].state = 'draft';
  data.attendance[date].updatedAt = new Date().toISOString();
  addAudit('monitor', 'reopened', date);
  await persist();
  res.json({ ok: true, record: data.attendance[date] });
}));

app.put('/api/setup', requireAuth, requireMonitor, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const classInfo = body.classInfo || {};
  const roster = Array.isArray(body.roster) ? body.roster : null;
  const subjectsByDay = body.subjectsByDay || null;
  if (!roster || roster.length < 1 || roster.length > 80) return res.status(400).json({ error: 'Roster must contain between 1 and 80 students.' });
  const ids = new Set();
  const cleanRoster = [];
  for (const [index, item] of roster.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return res.status(400).json({ error: 'Each roster entry must contain a student name.' });
    }
    const id = safeString(item.id, 24) || `s${index + 1}`;
    const name = safeString(item.name, 90);
    const gender = item.gender === 'Girls' ? 'Girls' : 'Boys';
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id) || RESERVED_OBJECT_KEYS.has(id.toLowerCase()) || !name || ids.has(id)) {
      return res.status(400).json({ error: 'Every student needs a valid, unique ID and name.' });
    }
    ids.add(id);
    cleanRoster.push({ id, name, gender });
  }
  const cleanSubjects = {};
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    const list = Array.isArray(subjectsByDay?.[day]) ? subjectsByDay[day] : data.subjectsByDay[day] || [];
    const safeSubjects = list.filter(x => typeof x === 'string').map(x => safeString(x, 70)).filter(safeObjectKey);
    cleanSubjects[day] = [...new Set(safeSubjects)].slice(0, 15);
  }
  data.classInfo = {
    schoolName: safeString(classInfo.schoolName, 120) || data.classInfo.schoolName,
    schoolAddress: safeString(classInfo.schoolAddress, 120),
    gradeSection: safeString(classInfo.gradeSection, 80) || data.classInfo.gradeSection,
    adviser: safeString(classInfo.adviser, 90),
    classMonitor: safeString(classInfo.classMonitor, 90),
    presentMark: safeString(classInfo.presentMark, 3) || '/',
    absentMark: safeString(classInfo.absentMark, 3) || 'A',
    lateMark: safeString(classInfo.lateMark, 3) || 'L',
    excusedMark: safeString(classInfo.excusedMark, 3) || 'E'
  };
  const archived = new Map((Array.isArray(data.formerRoster) ? data.formerRoster : []).map(student => [student.id, student]));
  const archivedAt = new Date().toISOString();
  for (const student of data.roster || []) {
    if (!ids.has(student.id) && !archived.has(student.id)) {
      archived.set(student.id, { id: student.id, name: student.name, gender: student.gender, archivedAt });
    }
  }
  data.formerRoster = [...archived.values()].filter(student => !ids.has(student.id));
  data.roster = cleanRoster;
  data.subjectsByDay = cleanSubjects;
  // Attendance marks are retained for archived students; never erase history
  // just because a student is removed from the current roster.
  addAudit('monitor', 'updated class setup', null, 'Roster or weekday subjects changed');
  await persist();
  res.json({ ok: true });
}));

app.get('/api/records', requireAuth, requireMonitor, (req, res) => {
  const month = safeString(req.query.month, 7);
  const records = Object.values(data.attendance).filter(record => record && validDate(record.date) && (!month || record.date.startsWith(month))).sort((a, b) => b.date.localeCompare(a.date));
  res.json({ records });
});

app.get('/api/sheet', requireAuth, (req, res) => {
  const roster = getAttendanceRoster().map(student => ({
    id: student.id, name: student.name, gender: student.gender, isFormer: student.isFormer
  }));
  const records = Object.values(data.attendance || {})
    .filter(record => record && validDate(record.date))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(record => {
      const subjects = Object.create(null);
      for (const subject of Object.keys(record.subjects || {})) {
        if (!safeObjectKey(subject)) continue;
        const sourceMarks = record.subjects[subject] || {};
        const marks = Object.create(null);
        for (const student of roster) {
          const code = sourceMarks[student.id];
          if (['P', 'A', 'L', 'E'].includes(code)) marks[student.id] = code;
        }
        subjects[subject] = marks;
      }
      return { date: record.date, subjects };
    });
  res.json({
    classInfo: {
      gradeSection: safeString(data.classInfo.gradeSection, 80),
      presentMark: safeString(data.classInfo.presentMark, 3) || '/',
      absentMark: safeString(data.classInfo.absentMark, 3) || 'A',
      lateMark: safeString(data.classInfo.lateMark, 3) || 'L',
      excusedMark: safeString(data.classInfo.excusedMark, 3) || 'E'
    },
    roster,
    records
  });
});

app.get('/api/download-history', requireAuth, requireMonitor, asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 50));
  const requestedOffset = Number.parseInt(req.query.offset, 10);
  const offset = Number.isSafeInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
  if (USE_SUPABASE) {
    const url = `${SUPABASE_URL}/rest/v1/${DOWNLOAD_HISTORY_TABLE}?select=id,downloaded_at,role,format,scope,filename,record_count,details&order=downloaded_at.desc,id.desc&limit=${limit}&offset=${offset}`;
    const response = await supabaseRequest(url, { method: 'GET', headers: { Accept: 'application/json', Prefer: 'count=exact' } });
    const contentRange = response.headers.get('content-range') || '';
    const totalMatch = contentRange.match(/\/(\d+)$/);
    const entries = await response.json();
    return res.json({ entries, total: totalMatch ? Number(totalMatch[1]) : null, limit, offset });
  }
  const entries = localDownloadHistory.slice(offset, offset + limit);
  res.json({ entries, total: localDownloadHistory.length, limit, offset });
}));

function makeDateColumn(date) {
  const saved = data.attendance[date];
  return { date, day: weekdayName(date), subjects: saved ? Object.keys(saved.subjects || {}) : getSubjectsForDate(date) };
}
function drawCell(doc, x, y, w, h, text, opts = {}) {
  doc.save();
  doc.lineWidth(opts.lineWidth ?? 0.35).strokeColor(opts.stroke || '#444444').rect(x, y, w, h).stroke();
  if (text !== undefined && text !== null && text !== '') {
    doc.fillColor(opts.color || '#111111').font(opts.font || 'Helvetica').fontSize(opts.fontSize || 6).text(String(text), x + (opts.padX ?? 2), y + (opts.padY ?? 2), {
      width: Math.max(1, w - 2 * (opts.padX ?? 2)),
      height: Math.max(1, h - 2),
      align: opts.align || 'left',
      valign: 'center',
      lineBreak: false,
      ellipsis: true
    });
  }
  doc.restore();
}
function drawAttendancePage(doc, dateColumns, pageInfo = {}) {
  const W = doc.page.width;
  const H = doc.page.height;
  const margin = 20;
  const tableX = margin;
  const tableW = W - margin * 2;
  const nameW = 148;
  const subjectCount = dateColumns.reduce((n, d) => n + d.subjects.length, 0);
  const rightW = tableW - nameW;
  const cellW = subjectCount ? rightW / subjectCount : rightW;
  const headerY = 104;
  const dateH = 18;
  const subjectH = 82;
  const groupH = 14;
  const attendanceRoster = getAttendanceRoster();
  const rowH = Math.min(15.2, Math.max(12.8, (H - headerY - dateH - subjectH - groupH * 3 - 30) / Math.max(1, attendanceRoster.length)));
  const tableTop = headerY;

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#111111').text(data.classInfo.schoolName.toUpperCase(), margin, 20, { width: tableW, align: 'center' });
  doc.font('Helvetica').fontSize(7).text(data.classInfo.schoolAddress || ' ', margin, 32, { width: tableW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(10).text(`Attendance Sheet of ${data.classInfo.gradeSection}`, margin, 48, { width: tableW, align: 'center' });
  const dateForMonth = dateColumns[0]?.date || pageInfo.monthDate || new Date().toISOString().slice(0, 10);
  const [year, month] = dateForMonth.split('-').map(Number);
  doc.font('Helvetica').fontSize(8).text(`Month: ${monthLabel(year, month).toUpperCase()}`, margin, 62, { width: tableW, align: 'center' });
  doc.moveTo(margin, 76).lineTo(W - margin, 76).lineWidth(0.6).strokeColor('#333333').stroke();
  doc.font('Helvetica').fontSize(7).text(`Week No.: ${pageInfo.weekNo ?? weekOfMonth(dateForMonth)}`, margin, 84, { width: 115 });
  doc.text(`Adviser: ${data.classInfo.adviser || '____________________________'}`, margin + 135, 84, { width: 220 });
  doc.text(`Class: ${data.classInfo.gradeSection}`, W - margin - 120, 84, { width: 120, align: 'right' });

  // Date group header and student-name header.
  drawCell(doc, tableX, tableTop, nameW, dateH + subjectH, 'STUDENT NAME', { align: 'center', font: 'Helvetica-Bold', fontSize: 7, padX: 2, padY: 2, lineWidth: 0.55 });
  let colIndex = 0;
  for (const day of dateColumns) {
    const span = day.subjects.length * cellW;
    drawCell(doc, tableX + nameW + colIndex * cellW, tableTop, span, dateH, `Date: ${dateLabel(day.date, { short: true }).toUpperCase()}`, { align: 'center', font: 'Helvetica-Bold', fontSize: 6.5, padX: 1, lineWidth: 0.55 });
    for (const subject of day.subjects) {
      const x = tableX + nameW + colIndex * cellW;
      doc.save();
      doc.lineWidth(0.35).strokeColor('#444444').rect(x, tableTop + dateH, cellW, subjectH).stroke();
      doc.translate(x + cellW / 2, tableTop + dateH + subjectH - 4);
      doc.rotate(-90);
      doc.font('Helvetica').fontSize(Math.min(6.2, Math.max(4.8, cellW * 0.48))).fillColor('#111111')
        .text(subject, -subjectH + 8, -2, { width: subjectH - 12, height: cellW, lineBreak: false, ellipsis: true, align: 'left' });
      doc.restore();
      colIndex++;
    }
  }

  let y = tableTop + dateH + subjectH;
  const groups = [
    { label: 'Boys', match: s => !s.isFormer && s.gender === 'Boys' },
    { label: 'Girls', match: s => !s.isFormer && s.gender === 'Girls' },
    { label: 'Former students', match: s => s.isFormer }
  ];
  for (const group of groups) {
    const students = attendanceRoster.filter(group.match);
    if (!students.length) continue;
    drawCell(doc, tableX, y, nameW, groupH, group.label, { font: 'Helvetica-Bold', fontSize: 7, padX: 4, padY: 2, lineWidth: 0.5, stroke: '#333333' });
    for (let i = 0; i < subjectCount; i++) drawCell(doc, tableX + nameW + i * cellW, y, cellW, groupH, '', { lineWidth: 0.35 });
    y += groupH;
    students.forEach((student, index) => {
      drawCell(doc, tableX, y, nameW, rowH, `${index + 1}.  ${student.name}`, { font: 'Helvetica', fontSize: 6.4, padX: 3, padY: 2, lineWidth: 0.35 });
      let c = 0;
      for (const day of dateColumns) {
        const record = data.attendance[day.date];
        for (const subject of day.subjects) {
          const status = record?.subjects?.[subject]?.[student.id];
          const mark = status === 'P' ? data.classInfo.presentMark : status === 'A' ? data.classInfo.absentMark : status === 'L' ? data.classInfo.lateMark : status === 'E' ? data.classInfo.excusedMark : '';
          drawCell(doc, tableX + nameW + c * cellW, y, cellW, rowH, mark, { align: 'center', font: 'Helvetica-Bold', fontSize: 7, padX: 0, padY: 3, lineWidth: 0.3 });
          c++;
        }
      }
      y += rowH;
    });
  }
  const monitorY = Math.min(H - 27, y + 15);
  doc.font('Helvetica').fontSize(7).fillColor('#111111').text(`Administrator: ${data.classInfo.classMonitor || '________________________________'}`, margin, monitorY, { width: tableW * 0.62 });
  doc.moveTo(margin + 190, monitorY + 10).lineTo(margin + 355, monitorY + 10).lineWidth(0.45).strokeColor('#333333').stroke();
  doc.font('Helvetica').fontSize(6).text('Signature', margin + 360, monitorY + 4, { width: 65 });
  const hasDraft = dateColumns.some(d => data.attendance[d.date]?.state !== 'finalized');
  if (hasDraft) {
    doc.save();
    doc.fillColor('#a33a30').font('Helvetica-Bold').fontSize(8).text('DRAFT - FOR REVIEW', W - margin - 130, H - 22, { width: 130, align: 'right' });
    doc.restore();
  }
  doc.font('Helvetica').fontSize(5.5).fillColor('#666666').text('Generated from ClassPing Attendance. Verify against the signed official record before submission.', margin, H - 20, { width: tableW - 140 });
}

function buildPdf(pages) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margins: { top: 18, right: 20, bottom: 18, left: 20 }, compress: true, autoFirstPage: false });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    pages.forEach((page, i) => {
      doc.addPage();
      drawAttendancePage(doc, page.columns, page.info);
    });
    doc.end();
  });
}

app.get('/api/backup', requireAuth, requireMonitor, (_req, res) => {
  const backup = {
    app: 'ClassPing Attendance',
    backupVersion: 1,
    exportedAt: new Date().toISOString(),
    classInfo: data.classInfo,
    roster: data.roster,
    formerRoster: data.formerRoster || [],
    subjectsByDay: data.subjectsByDay,
    attendance: data.attendance,
    auditLog: data.auditLog
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename=classping-backup-${new Date().toISOString().slice(0, 10)}.json`);
  res.send(JSON.stringify(backup, null, 2));
});

app.get('/api/export', requireAuth, async (req, res, next) => {
  try {
    const format = safeString(req.query.format, 8).toLowerCase();
    if (['csv', 'xlsx', 'pdf'].includes(format)) {
      const matrix = buildMatrix(data);
      const dateStamp = new Date().toISOString().slice(0, 10);
      const filename = `classping-attendance-history-${dateStamp}.${format}`;
      let output;
      let contentType;
      if (format === 'csv') {
        output = makeCsv(matrix);
        contentType = 'text/csv; charset=utf-8';
      } else if (format === 'xlsx') {
        output = makeXlsx(matrix);
        contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else {
        output = await buildHistoryPdf(matrix);
        contentType = 'application/pdf';
      }
      logDownloadAfterResponse(req, res, {
        format, scope: 'all-history', filename, recordCount: matrix.records.length,
        details: { students: matrix.rows.length, subjectColumns: matrix.columns.length }
      });
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename=\"${filename}\"`);
      res.setHeader('Content-Length', Buffer.isBuffer(output) ? output.length : Buffer.byteLength(output));
      return res.send(output);
    }

    const type = safeString(req.query.type, 12);
    const pages = [];
    let filename = 'attendance.pdf';
    if (type === 'daily') {
      const date = safeString(req.query.date, 10);
      if (!validDate(date)) return res.status(400).json({ error: 'Choose a valid date.' });
      pages.push({ columns: [makeDateColumn(date)], info: { weekNo: weekOfMonth(date), monthDate: date } });
      filename = `attendance-${date}.pdf`;
    } else if (type === 'weekly') {
      const date = safeString(req.query.date, 10);
      if (!validDate(date)) return res.status(400).json({ error: 'Choose a valid date.' });
      const start = mondayOf(date);
      const columns = getDatesForWeek(start).map(makeDateColumn);
      pages.push({ columns, info: { weekNo: weekOfMonth(date), monthDate: date } });
      filename = `attendance-week-${start}.pdf`;
    } else if (type === 'monthly') {
      const month = safeString(req.query.month, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'Choose a valid month.' });
      const [year, monthNumber] = month.split('-').map(Number);
      const first = `${month}-01`;
      const daysInMonth = new Date(year, monthNumber, 0).getDate();
      const last = `${month}-${String(daysInMonth).padStart(2, '0')}`;
      let start = mondayOf(first);
      while (start <= last) {
        const columns = getDatesForWeek(start, month).map(makeDateColumn);
        if (columns.length) pages.push({ columns, info: { weekNo: weekOfMonth(columns[0].date), monthDate: columns[0].date } });
        start = datePlus(start, 7);
      }
      filename = `attendance-${month}.pdf`;
    } else {
      return res.status(400).json({ error: 'Choose daily, weekly, or monthly export.' });
    }
    const pdf = await buildPdf(pages);
    const exportedDates = [...new Set(pages.flatMap(page => page.columns.map(column => column.date)))];
    logDownloadAfterResponse(req, res, {
      format: 'pdf', scope: type, filename, recordCount: exportedDates.length,
      details: { date: req.query.date || null, month: req.query.month || null, days: exportedDates.length }
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (err) { next(err); }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => err && next(err));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

initData().then(() => {
  app.listen(PORT, () => console.log(`ClassPing Attendance listening on port ${PORT}; storage: ${USE_SUPABASE ? 'Supabase' : DATA_FILE}`));
}).catch(err => {
  console.error('Unable to initialize ClassPing data:', err);
  process.exit(1);
});
