'use strict';

const zlib = require('zlib');

const STATUS_MARKS = {
  P: info => info.presentMark || '/',
  A: info => info.absentMark || 'A',
  L: info => info.lateMark || 'L',
  E: info => info.excusedMark || 'E'
};

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function csvEscape(value) {
  let text = String(value ?? '');
  // Prevent spreadsheet formula execution, including values with leading whitespace.
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function dateLabel(date) {
  const parsed = new Date(`${date}T12:00:00+08:00`);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila'
  }).format(parsed);
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function buildMatrix(data) {
  const records = Object.values(data.attendance || {})
    .filter(record => record && isValidDate(record.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  const columns = [];
  for (const record of records) {
    const subjects = Object.keys(record.subjects || {});
    for (const subject of subjects) columns.push({
      date: record.date,
      label: dateLabel(record.date),
      subject,
      key: `${record.date}\u0000${subject}`
    });
  }

  const activeRoster = data.roster || [];
  const activeIds = new Set(activeRoster.map(student => student.id));
  const formerRoster = (data.formerRoster || [])
    .filter(student => student && student.id && !activeIds.has(student.id))
    .map(student => ({ ...student, isFormer: true }));
  const exportRoster = [
    ...activeRoster.map(student => ({ ...student, isFormer: false })),
    ...formerRoster
  ];
  const rows = exportRoster.map(student => {
    const marks = columns.map(column => {
      const code = data.attendance?.[column.date]?.subjects?.[column.subject]?.[student.id];
      return Object.hasOwn(STATUS_MARKS, code) ? STATUS_MARKS[code](data.classInfo || {}) : '';
    });
    return {
      id: student.id,
      name: student.name,
      gender: student.isFormer ? `Former (${student.gender || 'student'})` : student.gender,
      isFormer: !!student.isFormer,
      marks
    };
  });

  return { columns, rows, records, classInfo: data.classInfo || {} };
}

function makeCsv(matrix) {
  const headers = ['Student ID', 'Student Name', 'Group', ...matrix.columns.map(c => `${c.label} - ${c.subject}`)];
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of matrix.rows) {
    lines.push([row.id, row.name, row.gender, ...row.marks].map(csvEscape).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function columnName(number) {
  let result = '';
  let n = number;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function worksheetXml(matrix) {
  const headers = ['Student ID', 'Student Name', 'Group', ...matrix.columns.map(c => `${c.label}\n${c.subject}`)];
  const maxColumn = Math.max(1, headers.length);
  const maxRow = matrix.rows.length + 1;
  const rowXml = [];

  const makeCell = (rowIndex, columnIndex, value, style) => {
    const reference = `${columnName(columnIndex)}${rowIndex}`;
    const text = xmlEscape(value);
    return `<c r="${reference}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${text}</t></is></c>`;
  };

  rowXml.push(`<row r="1" ht="34" customHeight="1">${headers.map((value, i) => makeCell(1, i + 1, value, 1)).join('')}</row>`);
  matrix.rows.forEach((row, index) => {
    const values = [row.id, row.name, row.gender, ...row.marks];
    rowXml.push(`<row r="${index + 2}">${values.map((value, i) => makeCell(index + 2, i + 1, value, i >= 3 ? 2 : 0)).join('')}</row>`);
  });

  const cols = headers.map((_, index) => {
    const width = index === 0 ? 14 : index === 1 ? 32 : index === 2 ? 12 : 18;
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:${columnName(maxColumn)}${maxRow}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane xSplit="3" ySplit="1" topLeftCell="D2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="18"/><cols>${cols}</cols><sheetData>${rowXml.join('')}</sheetData>` +
    `<autoFilter ref="A1:${columnName(maxColumn)}${maxRow}"/>` +
    `<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>` +
    `</worksheet>`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipFiles(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const [fileName, contents] of Object.entries(files)) {
    const name = Buffer.from(fileName, 'utf8');
    const source = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
    const compressed = zlib.deflateRawSync(source, { level: 6 });
    const crc = crc32(source);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function makeXlsx(matrix) {
  // Excel permits at most 16,384 columns per worksheet. The first three
  // columns identify the student; split exceptionally long histories across
  // sheets in the same workbook rather than silently dropping dates.
  const maxAttendanceColumns = 16384 - 3;
  const sheetCount = Math.max(1, Math.ceil(matrix.columns.length / maxAttendanceColumns));
  const sheets = [];
  const files = {};

  for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex++) {
    const start = sheetIndex * maxAttendanceColumns;
    const end = Math.min(matrix.columns.length, start + maxAttendanceColumns);
    const part = {
      columns: matrix.columns.slice(start, end),
      rows: matrix.rows.map(row => ({ ...row, marks: row.marks.slice(start, end) }))
    };
    const sheetName = sheetCount === 1 ? 'Attendance' : `Attendance ${sheetIndex + 1}`;
    const relationId = `rId${sheetIndex + 1}`;
    const fileName = `xl/worksheets/sheet${sheetIndex + 1}.xml`;
    sheets.push(`<sheet name="${sheetName}" sheetId="${sheetIndex + 1}" r:id="${relationId}"/>`);
    files[fileName] = worksheetXml(part);
  }

  const worksheetOverrides = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('');
  const worksheetRelationships = Array.from({ length: sheetCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join('');

  files['[Content_Types].xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${worksheetOverrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  files['_rels/.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  files['xl/workbook.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${worksheetRelationships}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  files['xl/styles.xml'] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><color rgb="FFFFF4E6"/><sz val="10"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF33271C"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF9A7955"/></left><right style="thin"><color rgb="FF9A7955"/></right><top style="thin"><color rgb="FF9A7955"/></top><bottom style="thin"><color rgb="FF9A7955"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" horizontal="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" horizontal="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return zipFiles(files);
}

function buildHistoryPdf(matrix) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 18, right: 22, bottom: 18, left: 22 }, compress: true, autoFirstPage: false });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = 841.89;
    const pageHeight = 595.28;
    const left = 22;
    const usableWidth = pageWidth - 44;
    const nameWidth = 150;
    const maxSubjectColumns = 22;
    const maxStudentsPerPage = 25;
    const columnGroups = [];
    if (!matrix.columns.length) columnGroups.push([]);
    else for (let i = 0; i < matrix.columns.length; i += maxSubjectColumns) {
      columnGroups.push(matrix.columns.slice(i, i + maxSubjectColumns).map((column, index) => ({
        ...column, matrixIndex: i + index
      })));
    }
    const rowGroups = [];
    if (!matrix.rows.length) rowGroups.push([]);
    else for (let i = 0; i < matrix.rows.length; i += maxStudentsPerPage) rowGroups.push(matrix.rows.slice(i, i + maxStudentsPerPage));

    for (let cg = 0; cg < columnGroups.length; cg++) {
      for (let rg = 0; rg < rowGroups.length; rg++) {
        doc.addPage({ size: 'A4', layout: 'landscape', margins: 0 });
        const columns = columnGroups[cg];
        const students = rowGroups[rg];
        const columnWidth = columns.length ? (usableWidth - nameWidth) / columns.length : 0;
        const info = matrix.classInfo;
        doc.fillColor('#211a15').font('Helvetica-Bold').fontSize(12).text(info.schoolName || 'ClassPing Attendance', left, 18, { width: usableWidth, align: 'center' });
        doc.fillColor('#4b4035').font('Helvetica').fontSize(8).text(`Unified attendance history · ${info.gradeSection || 'Class'}`, left, 34, { width: usableWidth, align: 'center' });
        doc.fillColor('#5b4a39').fontSize(7).text(`Page group ${cg + 1}/${columnGroups.length} · Student group ${rg + 1}/${rowGroups.length} · Generated ${new Date().toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}`, left, 48, { width: usableWidth, align: 'center' });

        const headerY = 68;
        const headerHeight = 48;
        const rowHeight = 17;
        drawPdfCell(doc, left, headerY, nameWidth, headerHeight, 'STUDENT NAME', true, 8);
        columns.forEach((column, index) => {
          const x = left + nameWidth + index * columnWidth;
          drawPdfCell(doc, x, headerY, columnWidth, headerHeight, `${column.date}\n${column.subject}`, true, Math.max(4.4, Math.min(6.2, columnWidth / 4.5)));
        });
        let y = headerY + headerHeight;
        students.forEach(student => {
          drawPdfCell(doc, left, y, nameWidth, rowHeight, student.isFormer ? `${student.name} (Former)` : student.name, false, 6.5, 'left');
          columns.forEach((column, columnIndex) => {
            drawPdfCell(doc, left + nameWidth + columnIndex * columnWidth, y, columnWidth, rowHeight, student.marks[column.matrixIndex] || '', false, 7, 'center');
          });
          y += rowHeight;
        });
        doc.fillColor('#766553').font('Helvetica').fontSize(6).text('Attendance codes follow the class symbol settings. Blank cells mean no mark was saved.', left, pageHeight - 18, { width: usableWidth });
      }
    }
    doc.end();
  });
}

function drawPdfCell(doc, x, y, width, height, value, header, fontSize, align = 'center') {
  doc.save();
  doc.lineWidth(0.35).strokeColor(header ? '#9A7955' : '#b9aa98').fillColor(header ? '#33271c' : '#ffffff').rect(x, y, width, height).fillAndStroke();
  doc.fillColor(header ? '#fff4e6' : '#211a15').font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).text(String(value ?? ''), x + 2, y + 2, {
    width: Math.max(2, width - 4), height: height - 4, align, valign: 'center', lineBreak: true, ellipsis: true
  });
  doc.restore();
}

module.exports = { buildMatrix, makeCsv, makeXlsx, buildHistoryPdf };
