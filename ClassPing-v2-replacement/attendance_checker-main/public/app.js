'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const STATUS = { P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' };
let appData = null;
let role = null;
let authFlowVersion = 0;
let selectedDate = localDate();
let dayData = null;
let workingSubjects = {};
let currentSubject = null;
let showReview = false;
let saveTimer = null;
let isSaving = false;
let saveQueue = Promise.resolve();
let toastTimer = null;
let sheetData = null;
let historyOffset = 0;
let historyTotal = 0;

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}
async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const type = response.headers.get('content-type') || '';
  if (!response.ok) {
    const payload = type.includes('application/json') ? await response.json().catch(() => ({})) : {};
    throw new Error(payload.error || `Request failed (${response.status}).`);
  }
  const disposition = response.headers.get('content-disposition') || '';
  if (type.includes('application/pdf') || type.includes('spreadsheetml') || type.includes('text/csv') || disposition.toLowerCase().includes('attachment')) {
    let filename = '';
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
    try { filename = decodeURIComponent(utf8Match?.[1] || plainMatch?.[1] || ''); } catch { filename = plainMatch?.[1] || ''; }
    return { blob: await response.blob(), filename };
  }
  return response.json();
}
function setLoginVisible(visible) {
  const loginScreen = $('#login-screen');
  const appShell = $('#app-shell');

  // Set both the hidden attribute and inline display. The inline fallback
  // prevents an old cached stylesheet from keeping the login screen visible.
  loginScreen.hidden = !visible;
  appShell.hidden = visible;
  loginScreen.style.display = visible ? 'grid' : 'none';
  appShell.style.display = visible ? 'none' : 'block';
  loginScreen.setAttribute('aria-hidden', String(!visible));
  appShell.setAttribute('aria-hidden', String(visible));
}
function showView(name) {
  const administratorViews = ['home', 'attendance', 'sheet', 'records', 'downloads', 'settings'];
  const allowedViews = role === 'viewer' ? ['sheet', 'downloads'] : administratorViews;
  if (!allowedViews.includes(name)) name = role === 'viewer' ? 'sheet' : 'home';
  $$('.view').forEach(el => el.classList.toggle('active-view', el.id === `view-${name}`));
  $$('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === name));
  if (name === 'records') renderRecords();
  if (name === 'settings') renderSetup();
  if (name === 'sheet') loadSheet().catch(err => showToast(err.message));
  if (name === 'downloads' && role === 'monitor') loadDownloadHistory(false).catch(err => showToast(err.message));
}
function applyRole() {
  $('#role-pill').textContent = role === 'monitor' ? 'Administrator' : 'Viewer';
  $$('.monitor-only').forEach(el => el.hidden = role !== 'monitor');
}
async function startApp() {
  const flowVersionAtStart = authFlowVersion;
  try {
    const me = await api('/api/me');
    // Do not let a late startup check undo a login the user just completed.
    if (flowVersionAtStart !== authFlowVersion) return;
    if (!me.authenticated) return setLoginVisible(true);
    role = me.role;
    appData = await api('/api/bootstrap');
    if (flowVersionAtStart !== authFlowVersion) return;
    setLoginVisible(false);
    applyRole();
    renderAll();
    showView(role === 'viewer' ? 'sheet' : 'home');
  } catch {
    if (flowVersionAtStart === authFlowVersion) setLoginVisible(true);
  }
}
function renderAll() {
  $('#sidebar-section').textContent = appData.classInfo.gradeSection;
  $('#sidebar-students').textContent = `${appData.studentCount} students`;
  $('#stat-students').textContent = appData.studentCount;
  const finalized = appData.records.filter(r => r.state === 'finalized').length;
  $('#stat-finalized').textContent = finalized;
  $('#stat-drafts').textContent = appData.records.length - finalized;
  if (role === 'monitor') {
    renderRecentRecords();
    renderWeekdayPreview();
  }
  $('#attendance-date').value = selectedDate;
  $('#export-daily-date').value = selectedDate;
  $('#export-week-date').value = selectedDate;
  $('#export-month').value = selectedDate.slice(0, 7);
  $('#records-month').value = selectedDate.slice(0, 7);
}
function renderRecentRecords() {
  const list = appData.records.slice(0, 5);
  $('#recent-records').innerHTML = list.length ? list.map(record => {
    const state = record.state === 'finalized' ? 'finalized' : 'draft';
    const label = state === 'finalized' ? 'Finalized' : 'Draft';
    return `<div class="record-item"><div><div class="record-date">${escapeHtml(formatDate(record.date))}</div><div class="record-meta">${Number(record.subjectCount || 0)} subject columns · Updated ${escapeHtml(formatTime(record.updatedAt))}</div></div><div class="record-action"><span class="state-badge ${state}">${label}</span> <button class="text-button" data-open-date="${escapeHtml(record.date)}">Open</button></div></div>`;
  }).join('') : '<div class="empty-state">No attendance has been recorded yet.</div>';
  $$('[data-open-date]').forEach(button => button.addEventListener('click', () => openDate(button.dataset.openDate)));
}
function renderWeekdayPreview() {
  $('#weekday-preview').innerHTML = DAYS.map(day => `<div class="weekday-row"><div class="weekday-name">${day}</div><div class="weekday-subjects">${(appData.subjectsByDay[day] || []).map(escapeHtml).join(' · ') || 'No subjects configured'}</div></div>`).join('');
}
function formatDate(date) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' }).format(new Date(`${date}T12:00:00+08:00`));
}
function formatTime(value) {
  if (!value) return 'just now';
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' }).format(new Date(value));
}
function selectedDayName() {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'Asia/Manila' }).format(new Date(`${selectedDate}T12:00:00+08:00`));
}
async function openDate(date) {
  selectedDate = date;
  $('#attendance-date').value = date;
  showView('attendance');
  try {
    dayData = await api(`/api/attendance/${date}`);
    workingSubjects = {};
    for (const subject of dayData.subjects) workingSubjects[subject] = { ...(dayData.record?.subjects?.[subject] || {}) };
    currentSubject = null;
    showReview = false;
    renderAttendanceScreen();
  } catch (err) { showToast(err.message); }
}
function currentRecordFinalized() { return dayData?.record?.state === 'finalized'; }
function completeCount(subject) {
  const marks = workingSubjects[subject] || {};
  return appData.roster.filter(student => STATUS[marks[student.id]]).length;
}
function renderAttendanceScreen() {
  $('#selected-day-label').textContent = selectedDayName();
  const finalized = currentRecordFinalized();
  $('#attendance-subjects-wrap').hidden = finalized || !!currentSubject || showReview;
  $('#marking-wrap').hidden = finalized || !currentSubject;
  $('#review-wrap').hidden = finalized || !!currentSubject || !showReview;
  $('#day-finalized-wrap').hidden = !finalized;
  if (finalized) {
    $('#stepper').style.opacity = '.5';
    return;
  }
  $('#stepper').style.opacity = '1';
  renderSubjectList();
  if (currentSubject) renderMarking();
  if (showReview) renderReview();
  updateStepper(currentSubject ? 2 : (showReview ? 3 : 1));
}
function renderSubjectList() {
  const subjects = dayData.subjects || [];
  const completed = subjects.filter(subject => completeCount(subject) === appData.roster.length).length;
  $('#subject-progress').textContent = `${completed} / ${subjects.length} completed`;
  $('#subject-list').innerHTML = subjects.length ? subjects.map(subject => {
    const count = completeCount(subject);
    const full = count === appData.roster.length;
    return `<button class="subject-card ${full ? 'subject-marked' : ''}" data-subject="${escapeHtml(subject)}"><span><strong>${escapeHtml(subject)}</strong><small>${count} / ${appData.roster.length} students marked</small></span><span class="subject-arrow">${full ? '✓' : '›'}</span></button>`;
  }).join('') + (role === 'monitor' ? '<button id="go-review" class="button button-primary button-full" style="grid-column:1/-1;margin-top:6px">Review & finalize day →</button>' : '') : '<div class="empty-state">No subjects are configured for this weekday. Ask an administrator to update the class setup.</div>';
  $$('[data-subject]').forEach(button => button.addEventListener('click', () => {
    currentSubject = button.dataset.subject;
    showReview = false;
    renderAttendanceScreen();
  }));
  $('#go-review')?.addEventListener('click', () => { currentSubject = null; showReview = true; renderAttendanceScreen(); updateStepper(3); });
}
function renderMarking() {
  $('#current-subject-title').textContent = currentSubject;
  const marks = workingSubjects[currentSubject] || {};
  const count = appData.roster.filter(student => STATUS[marks[student.id]]).length;
  $('#subject-marking-progress').textContent = `${count} / ${appData.roster.length} marked`;
  $('#everyone-present').disabled = role !== 'monitor' || currentRecordFinalized();
  $('#save-next-subject').disabled = role !== 'monitor';
  $('#save-next-subject').textContent = role === 'monitor' ? 'Save & next subject →' : 'View only';
  $('#student-mark-list').innerHTML = ['Boys', 'Girls'].map(group => {
    const groupStudents = appData.roster.filter(s => s.gender === group);
    if (!groupStudents.length) return '';
    return `<div class="group-divider">${group}</div>` + groupStudents.map(student => {
      const status = marks[student.id] || '';
      return `<div class="student-mark-row"><div><div class="student-name">${escapeHtml(student.name)}</div><div class="student-group">${group}</div></div><div class="mark-options">${Object.entries(STATUS).map(([key, label]) => `<button class="mark-option ${status === key ? `selected` : ''}" data-mark="${key}" data-student="${escapeHtml(student.id)}" aria-label="${label}" title="${label}" ${role !== 'monitor' ? 'disabled' : ''}>${key}</button>`).join('')}</div></div>`;
    }).join('');
  }).join('');
  $$('[data-mark]').forEach(button => button.addEventListener('click', () => {
    if (role !== 'monitor') return;
    const marksForSubject = workingSubjects[currentSubject] || (workingSubjects[currentSubject] = {});
    marksForSubject[button.dataset.student] = button.dataset.mark;
    renderMarking();
    scheduleSave();
  }));
}
function renderReview() {
  if (!dayData) return;
  const subjects = dayData.subjects || [];
  let total = 0, present = 0, absent = 0, late = 0, excused = 0, missing = 0;
  const rows = subjects.map(subject => {
    const marks = workingSubjects[subject] || {};
    let done = 0;
    for (const student of appData.roster) {
      const status = marks[student.id];
      if (status) done++;
      total++;
      if (status === 'P') present++; else if (status === 'A') absent++; else if (status === 'L') late++; else if (status === 'E') excused++; else missing++;
    }
    const full = done === appData.roster.length;
    return `<div class="review-subject-row"><span>${escapeHtml(subject)}</span><span class="${full ? 'complete' : 'incomplete'}">${done}/${appData.roster.length} ${full ? 'Complete' : 'Needs marks'}</span></div>`;
  }).join('');
  $('#review-summary').innerHTML = `<div class="review-summary"><div class="review-stat"><b>${present}</b><span>Present marks</span></div><div class="review-stat"><b>${absent}</b><span>Absent marks</span></div><div class="review-stat"><b>${late}</b><span>Late marks</span></div><div class="review-stat"><b>${missing}</b><span>Unmarked cells</span></div></div>${rows || '<div class="empty-state">No subject columns for this date.</div>'}`;
  $('#finalize-day').disabled = role !== 'monitor' || missing > 0 || subjects.length === 0;
  $('#finalize-note').textContent = missing ? `${missing} cell(s) still need an attendance mark before finalization.` : 'All attendance cells are marked. Finalized records become read-only; an administrator can reopen them if a correction is needed.';
  updateStepper(3);
}
function updateStepper(active) {
  $$('.step').forEach(step => {
    const n = Number(step.dataset.step);
    step.classList.toggle('active', n === active);
    step.classList.toggle('done', n < active);
  });
}
function scheduleSave() {
  if (role !== 'monitor') return;
  $('#autosave-indicator').textContent = '● Saving soon';
  $('#autosave-indicator').className = 'save-indicator saving';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDraft().catch(err => showToast(err.message)), 500);
}
function saveDraft() {
  if (role !== 'monitor' || !dayData || currentRecordFinalized()) return Promise.resolve();
  clearTimeout(saveTimer);
  const saveDate = selectedDate;
  const payload = JSON.stringify({ subjects: workingSubjects });
  const task = saveQueue.catch(() => {}).then(async () => {
    isSaving = true;
    $('#autosave-indicator').textContent = '● Saving';
    $('#autosave-indicator').className = 'save-indicator saving';
    try {
      const result = await api(`/api/attendance/${saveDate}`, { method: 'PUT', body: payload });
      if (selectedDate === saveDate && dayData) {
        dayData.record = result.record;
        $('#autosave-indicator').textContent = '● Saved';
        $('#autosave-indicator').className = 'save-indicator saved';
      }
    } finally { isSaving = false; }
  });
  saveQueue = task.catch(() => {});
  return task;
}
async function nextSubject() {
  await saveDraft();
  const index = dayData.subjects.indexOf(currentSubject);
  if (index < dayData.subjects.length - 1) currentSubject = dayData.subjects[index + 1];
  else { currentSubject = null; showReview = true; }
  renderAttendanceScreen();
  if (showReview) updateStepper(3);
}
async function finalizeDay() {
  try {
    await saveDraft();
    const result = await api(`/api/attendance/${selectedDate}/finalize`, { method: 'POST', body: '{}' });
    dayData.record = result.record;
    const fresh = await api('/api/bootstrap');
    appData.records = fresh.records;
    $('#stat-finalized').textContent = appData.records.filter(r => r.state === 'finalized').length;
    $('#stat-drafts').textContent = appData.records.filter(r => r.state !== 'finalized').length;
    renderAttendanceScreen();
    showToast('Attendance finalized successfully.');
  } catch (err) { showToast(err.message); }
}
async function reopenDay() {
  try {
    const result = await api(`/api/attendance/${selectedDate}/reopen`, { method: 'POST', body: '{}' });
    dayData.record = result.record;
    currentSubject = null;
    showReview = false;
    renderAttendanceScreen();
    showToast('Record reopened for corrections.');
  } catch (err) { showToast(err.message); }
}
function statusSymbol(code, info) {
  if (code === 'P') return info.presentMark || '/';
  if (code === 'A') return info.absentMark || 'A';
  if (code === 'L') return info.lateMark || 'L';
  if (code === 'E') return info.excusedMark || 'E';
  return '';
}
function loadSheet() {
  return api('/api/sheet').then(result => {
    sheetData = result;
    const months = [...new Set((result.records || []).map(record => record.date.slice(0, 7)))].sort().reverse();
    const monthSelect = $('#sheet-month');
    const current = monthSelect.value;
    monthSelect.innerHTML = '<option value="">All history</option>' + months.map(month => {
      const [year, number] = month.split('-').map(Number);
      const label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'Asia/Manila' }).format(new Date(Date.UTC(year, number - 1, 15)));
      return `<option value="${escapeHtml(month)}">${escapeHtml(label)}</option>`;
    }).join('');
    if (months.includes(current)) monthSelect.value = current;
    $('#sheet-title').textContent = result.classInfo?.gradeSection ? `${result.classInfo.gradeSection} attendance` : 'Attendance sheet';
    const info = result.classInfo || {};
    $('#sheet-legend').innerHTML = [
      [info.presentMark || '/', 'Present'],
      [info.absentMark || 'A', 'Absent'],
      [info.lateMark || 'L', 'Late'],
      [info.excusedMark || 'E', 'Excused'],
      ['—', 'No saved mark']
    ].map(([symbol, label]) => `<span><b>${escapeHtml(symbol)}</b> ${label}</span>`).join('');
    renderSheet();
  });
}
function renderSheet() {
  if (!sheetData) return;
  const selectedMonth = $('#sheet-month').value;
  const records = (sheetData.records || []).filter(record => !selectedMonth || record.date.startsWith(selectedMonth)).sort((a, b) => a.date.localeCompare(b.date));
  const columns = [];
  for (const record of records) {
    for (const subject of Object.keys(record.subjects || {})) columns.push({ date: record.date, subject, record });
  }
  const monthLabel = selectedMonth ? selectedMonth : 'all saved dates';
  $('#sheet-count').textContent = `${records.length} saved day${records.length === 1 ? '' : 's'} · ${columns.length} subject columns · ${monthLabel}`;
  if (!sheetData.roster?.length) {
    $('#attendance-sheet').innerHTML = '<div class="empty-state">No students are configured.</div>';
    return;
  }
  if (!columns.length) {
    $('#attendance-sheet').innerHTML = '<div class="empty-state">No attendance has been saved for this period yet.</div>';
    return;
  }
  const groups = [];
  for (const column of columns) {
    const last = groups[groups.length - 1];
    if (last && last.date === column.date) last.columns.push(column);
    else groups.push({ date: column.date, columns: [column] });
  }
  const firstHeader = `<tr><th class="student-sticky student-header" rowspan="2">Student</th>${groups.map(group => `<th class="date-group" colspan="${group.columns.length}">${escapeHtml(formatDate(group.date))}</th>`).join('')}</tr>`;
  const secondHeader = `<tr>${columns.map(column => `<th class="subject-header" title="${escapeHtml(column.subject)}">${escapeHtml(column.subject)}</th>`).join('')}</tr>`;
  const body = sheetData.roster.map(student => {
    const marks = columns.map(column => {
      const rawCode = column.record.subjects?.[column.subject]?.[student.id];
      const code = ['P', 'A', 'L', 'E'].includes(rawCode) ? rawCode : '';
      const symbol = statusSymbol(code, sheetData.classInfo || {});
      const label = ({ P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' })[code] || 'No mark';
      return `<td class="mark-cell ${code ? `mark-${code.toLowerCase()}` : 'mark-empty'}" title="${label}">${symbol ? escapeHtml(symbol) : '—'}</td>`;
    }).join('');
    const studentLabel = student.isFormer ? 'Former student' : (student.gender || '');
    return `<tr><th scope="row" class="student-sticky student-cell"><span>${escapeHtml(student.name)}</span><small>${escapeHtml(studentLabel)}</small></th>${marks}</tr>`;
  }).join('');
  $('#attendance-sheet').innerHTML = `<table class="attendance-matrix" aria-label="Unified attendance history"><thead>${firstHeader}${secondHeader}</thead><tbody>${body}</tbody></table>`;
}
async function loadDownloadHistory(append = false) {
  if (role !== 'monitor') return;
  if (!append) historyOffset = 0;
  const result = await api(`/api/download-history?limit=50&offset=${historyOffset}`);
  historyTotal = Number(result.total ?? 0);
  const entries = result.entries || [];
  const container = $('#download-history-list');
  const html = entries.length ? entries.map(entry => {
    const timestamp = entry.downloaded_at ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }).format(new Date(entry.downloaded_at)) : 'Unknown date';
    const format = String(entry.format || '').toUpperCase();
    const detail = entry.scope === 'all-history' ? 'Complete attendance history' : `${entry.scope || 'Attendance export'} sheet`;
    return `<div class="history-row"><div><strong>${escapeHtml(entry.filename || `${format} export`)}</strong><small>${escapeHtml(detail)} · ${Number(entry.record_count || 0)} date(s)</small></div><div class="history-meta"><b>${escapeHtml(format)}</b><small>${escapeHtml(timestamp)}</small><small>${entry.role === 'monitor' ? 'Administrator' : 'Viewer'}</small></div></div>`;
  }).join('') : '<div class="empty-state">No successful attendance downloads have been logged yet.</div>';
  if (append) container.insertAdjacentHTML('beforeend', html);
  else container.innerHTML = html;
  historyOffset += entries.length;
  $('#load-more-history').hidden = historyOffset >= historyTotal || entries.length === 0;
}
function renderRecords() {
  if (!appData || role !== 'monitor') return;
  const month = $('#records-month').value;
  const records = appData.records.filter(r => !month || r.date.startsWith(month));
  $('#all-records').innerHTML = records.length ? records.map(record => {
    const state = record.state === 'finalized' ? 'finalized' : 'draft';
    const label = state === 'finalized' ? 'Finalized' : 'Draft';
    return `<div class="record-item"><div><div class="record-date">${escapeHtml(formatDate(record.date))}</div><div class="record-meta">${Number(record.subjectCount || 0)} subject columns · Updated ${escapeHtml(formatTime(record.updatedAt))}</div></div><div><span class="state-badge ${state}">${label}</span> <button class="text-button" data-record-date="${escapeHtml(record.date)}">Open</button></div></div>`;
  }).join('') : '<div class="empty-state">No saved records for this month.</div>';
  $$('[data-record-date]').forEach(button => button.addEventListener('click', () => openDate(button.dataset.recordDate)));
}
function rosterToText(roster) { return roster.map(student => `${student.gender.toUpperCase()} | ${student.name}`).join('\n'); }
function parseRoster(text) {
  const existing = new Map([
    ...(appData?.formerRoster || []).map(s => [s.name.trim().toLowerCase(), s.id]),
    ...(appData?.roster || []).map(s => [s.name.trim().toLowerCase(), s.id])
  ]);
  return text.split('\n').map(line => line.trim()).filter(Boolean).map((line, i) => {
    const split = line.indexOf('|');
    const genderText = split >= 0 ? line.slice(0, split).trim().toLowerCase() : 'boys';
    const name = (split >= 0 ? line.slice(split + 1) : line).trim();
    const id = existing.get(name.toLowerCase()) || `new-${Date.now()}-${i + 1}`;
    return { id, gender: genderText.startsWith('g') ? 'Girls' : 'Boys', name };
  });
}
function renderSetup() {
  if (!appData || role !== 'monitor') return;
  const info = appData.classInfo;
  $('#setup-school').value = info.schoolName || '';
  $('#setup-address').value = info.schoolAddress || '';
  $('#setup-section').value = info.gradeSection || '';
  $('#setup-adviser').value = info.adviser || '';
  $('#setup-monitor').value = info.classMonitor || '';
  $('#setup-roster').value = rosterToText(appData.roster);
  $('#roster-count').textContent = `${appData.roster.length} students`;
  $('#weekday-editors').innerHTML = DAYS.map(day => `<div class="weekday-editor"><label for="subjects-${day}">${day}</label><textarea id="subjects-${day}" class="control" data-day-subjects="${day}">${(appData.subjectsByDay[day] || []).map(escapeHtml).join(', ')}</textarea></div>`).join('');
  $('#mark-present').value = info.presentMark || '/';
  $('#mark-absent').value = info.absentMark || 'A';
  $('#mark-late').value = info.lateMark || 'L';
  $('#mark-excused').value = info.excusedMark || 'E';
}
async function saveSetup(event) {
  event.preventDefault();
  const roster = parseRoster($('#setup-roster').value);
  const subjectsByDay = {};
  for (const day of DAYS) subjectsByDay[day] = $(`#subjects-${day}`).value.split(',').map(x => x.trim()).filter(Boolean);
  if (!roster.length || roster.some(s => !s.name)) return showToast('Please enter at least one student name.');
  try {
    await api('/api/setup', { method: 'PUT', body: JSON.stringify({
      classInfo: {
        schoolName: $('#setup-school').value,
        schoolAddress: $('#setup-address').value,
        gradeSection: $('#setup-section').value,
        adviser: $('#setup-adviser').value,
        classMonitor: $('#setup-monitor').value,
        presentMark: $('#mark-present').value,
        absentMark: $('#mark-absent').value,
        lateMark: $('#mark-late').value,
        excusedMark: $('#mark-excused').value
      }, roster, subjectsByDay
    }) });
    appData = await api('/api/bootstrap');
    renderAll(); renderSetup();
    showToast('Class setup saved.');
  } catch (err) { showToast(err.message); }
}
async function downloadBackup() {
  try {
    const snapshot = await api('/api/backup');
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `classping-backup-${localDate()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast('Full data backup downloaded. Keep it private.');
  } catch (err) { showToast(err.message); }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function downloadPdf(type, params) {
  try {
    const query = new URLSearchParams({ type, ...params });
    const file = await api(`/api/export?${query.toString()}`);
    saveBlob(file.blob, file.filename || `classping-attendance-${type}.pdf`);
    showToast('PDF downloaded.');
  } catch (err) { showToast(err.message); }
}
async function downloadHistoryExport(format) {
  try {
    const file = await api(`/api/export?format=${encodeURIComponent(format)}`);
    const extension = format.toLowerCase();
    saveBlob(file.blob, file.filename || `classping-attendance-history.${extension}`);
    showToast(`${extension.toUpperCase()} history downloaded.`);
    if (role === 'monitor') setTimeout(() => loadDownloadHistory(false).catch(() => {}), 700);
  } catch (err) { showToast(err.message); }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#login-error');
  const submitButton = $('#login-form button[type=submit]');
  const originalButtonText = submitButton.innerHTML;
  const thisLoginAttempt = ++authFlowVersion;
  error.hidden = true;
  submitButton.disabled = true;
  submitButton.textContent = 'Signing in…';
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ role: $('#login-role').value, password: $('#login-password').value }) });
    if (!result?.ok || !['monitor', 'viewer'].includes(result.role)) {
      throw new Error('The server returned an incomplete sign-in response. Please try again.');
    }
    role = result.role;
    appData = await api('/api/bootstrap');
    if (thisLoginAttempt !== authFlowVersion) return;
    if (!appData || !appData.classInfo || !Array.isArray(appData.roster) || !Array.isArray(appData.records) || !appData.subjectsByDay) {
      throw new Error('Class data could not be loaded completely. Please refresh and try again.');
    }
    applyRole();
    renderAll();
    setLoginVisible(false);
    showView(role === 'viewer' ? 'sheet' : 'home');
    $('#login-password').value = '';
  } catch (err) {
    if (thisLoginAttempt === authFlowVersion) {
      role = null;
      appData = null;
      setLoginVisible(true);
      error.textContent = err.message || 'Sign-in failed. Please try again.';
      error.hidden = false;
    }
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = originalButtonText;
  }
});
$('#logout-button').addEventListener('click', async () => {
  ++authFlowVersion;
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  role = null; appData = null; sheetData = null; historyOffset = 0; setLoginVisible(true); showToast('Signed out.');
});
$$('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$$('[data-go]').forEach(button => button.addEventListener('click', () => showView(button.dataset.go)));
$('#home-take-attendance').addEventListener('click', () => openDate(localDate()));
$('#attendance-date').addEventListener('change', event => openDate(event.target.value));
$('#back-to-subjects').addEventListener('click', async () => { await saveDraft().catch(err => showToast(err.message)); currentSubject = null; showReview = false; renderAttendanceScreen(); });
$('#everyone-present').addEventListener('click', () => {
  if (role !== 'monitor' || !currentSubject) return;
  const marks = workingSubjects[currentSubject] || (workingSubjects[currentSubject] = {});
  appData.roster.forEach(student => marks[student.id] = 'P');
  renderMarking(); scheduleSave();
});
$('#save-next-subject').addEventListener('click', () => nextSubject().catch(err => showToast(err.message)));
$('#back-to-subjects-review').addEventListener('click', () => { currentSubject = null; showReview = false; renderAttendanceScreen(); });
$('#finalize-day').addEventListener('click', finalizeDay);
$('#reopen-day').addEventListener('click', reopenDay);
$('#download-final-day').addEventListener('click', () => downloadPdf('daily', { date: selectedDate }));
$('#records-month').addEventListener('change', renderRecords);
$('#sheet-month').addEventListener('change', renderSheet);
$('#export-history-xlsx').addEventListener('click', () => downloadHistoryExport('xlsx'));
$('#export-history-csv').addEventListener('click', () => downloadHistoryExport('csv'));
$('#export-history-pdf').addEventListener('click', () => downloadHistoryExport('pdf'));
$('#refresh-download-history').addEventListener('click', () => loadDownloadHistory(false).catch(err => showToast(err.message)));
$('#load-more-history').addEventListener('click', () => loadDownloadHistory(true).catch(err => showToast(err.message)));
$('#setup-form').addEventListener('submit', saveSetup);
$('#export-daily').addEventListener('click', () => downloadPdf('daily', { date: $('#export-daily-date').value }));
$('#export-weekly').addEventListener('click', () => downloadPdf('weekly', { date: $('#export-week-date').value }));
$('#export-monthly').addEventListener('click', () => downloadPdf('monthly', { month: $('#export-month').value }));
$('#download-backup').addEventListener('click', downloadBackup);

// Start in the login screen, then restore an existing signed-in session when available.
startApp();
