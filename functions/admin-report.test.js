const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/admin-analytics.js'), 'utf8');
function fixture() {
  const elements = {
    reportStartDate: { value: '' }, reportEndDate: { value: '' },
    reportBarangaySort: { value: 'original' }, reportBarangaySortControl: { hidden: true },
    reportComparisonMonths: { value: '6' }, reportComparisonControl: { hidden: true },
    reportPreviewDocument: {}, reportPreviewTitle: {},
    reportPreviewModal: { hidden: true, setAttribute() {} }
  };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    appointments: [], vaccinations: [], inventory: [], clinics: [], activeReportKind: null,
    barangayFor: item => item.fallbackBarangay || 'Unknown',
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
    notifyDialog(message) { throw new Error(message); }
  });
  vm.runInContext(source.slice(source.indexOf('function dateValue('), source.indexOf('function inSelectedAnalyticsYear(')), context);
  vm.runInContext(source.slice(source.indexOf('function formatReportDate('), source.indexOf('let bploZoom')), context);
  return { context, elements };
}

test('report dates use long month names and range boundaries include the selected day', () => {
  const { context: c, elements: e } = fixture();
  assert.equal(c.formatReportDate('2026-09-13'), 'September 13, 2026');
  assert.equal(c.formatReportDate(null), 'No date');
  assert.equal(c.formatReportDate('invalid'), 'No date');
  assert.equal(c.formatReportDate({ toDate: () => vm.runInContext("new Date(2026, 8, 13)", c) }), 'September 13, 2026');
  e.reportStartDate.value = e.reportEndDate.value = '2026-09-13';
  const range = c.reportRange();
  assert.equal(range.label, 'September 13, 2026 to September 13, 2026');
  assert.equal(c.inReportRange({ preferred_date: '2026-09-13' }, range), true);
  assert.equal(c.inReportRange({ preferred_date: '2026-09-12' }, range), false);
});

test('case preview sorts Barangays in both directions and uses consistent status totals', () => {
  const { context: c, elements: e } = fixture();
  c.appointments = [
    { preferred_date: '2026-09-13', barangay: 'Marinig', status: 'completed' },
    { preferred_date: '2026-09-13', fallbackBarangay: 'Bigaa', status: 'confirmed' },
    { barangay: 'banlic', status: 'expired' },
    { barangay: 'Bigaa', status: 'in_progress' },
    { barangay: 'Sala' },
    { barangay: 'Excluded', status: 'declined' }
  ];
  e.reportBarangaySort.value = 'asc';
  let report = c.reportDefinition('cases', c.reportRange());
  assert.deepEqual(Array.from(report.rows, row => row[2]), ['banlic', 'Bigaa', 'Bigaa', 'Marinig', 'Sala']);
  assert.deepEqual(Array.from(report.rows, row => row[4]), ['Pending', 'Ongoing', 'Ongoing', 'Resolved', 'Pending']);
  assert.deepEqual(Array.from(report.totals, row => Array.from(row)), [['Reported cases', 5], ['Pending', 2], ['Ongoing', 2], ['Resolved', 1]]);
  assert.equal(c.appointments[0].barangay, 'Marinig');
  e.reportBarangaySort.value = 'desc';
  report = c.reportDefinition('cases', c.reportRange());
  assert.deepEqual(Array.from(report.rows, row => row[2]), ['Sala', 'Marinig', 'Bigaa', 'Bigaa', 'banlic']);
  c.openReportPreview('cases');
  assert.equal(e.reportBarangaySortControl.hidden, false);
  assert.equal(e.reportComparisonControl.hidden, false);
  assert.match(e.reportPreviewDocument.innerHTML, /September 13, 2026/);
  assert.ok(e.reportPreviewDocument.innerHTML.indexOf('<td>Sala</td>') < e.reportPreviewDocument.innerHTML.indexOf('<td>Marinig</td>'));
  assert.doesNotMatch(e.reportPreviewDocument.innerHTML, /<td>(completed|confirmed|expired)<\/td>/);
  c.openReportPreview('vaccinations');
  assert.equal(e.reportBarangaySortControl.hidden, true);
  assert.equal(e.reportComparisonControl.hidden, true);
  e.reportBarangaySort.value = 'original';
  assert.equal(c.reportDefinition('cases', c.reportRange()).rows[0][2], 'Marinig');
});

test('animal-source totals count treatment courses once and retain other and missing sources', () => {
  const { context: c, elements: e } = fixture();
  c.appointments = [
    { id: 'a1', vaccination_session_id: 's1', resident_uid: 'r1', preferred_date: '2026-09-15', status: 'completed', course_intake_data: { bite_date: '2026-08-31', animal_type: 'dog' } },
    { id: 'a2', vaccination_session_id: 's1', resident_uid: 'r1', preferred_date: '2026-09-22', status: 'confirmed' },
    { id: 'a3', vaccination_session_id: 's2', resident_uid: 'r1', preferred_date: '2026-09-18', animal_type: 'Cat' },
    { id: 'a4', preferred_date: '2026-09-19', animal_type: 'Other', animal_other: 'Monkey' },
    { id: 'a5', preferred_date: '2026-09-20' },
    { id: 'a6', preferred_date: '2026-09-20', status: 'cancelled', animal_type: 'Dog' },
    { id: 'a7', preferred_date: '2026-09-20', status: 'declined', animal_type: 'Dog' }
  ];
  c.vaccinations = [{ vaccination_session_id: 's2', animal_type: 'Cat', date_given: '2026-10-01' }];
  const report = c.reportDefinition('cases', c.reportRange());
  assert.equal(report.rows.length, 4);
  assert.equal(report.rows[0][0], 'August 31, 2026');
  assert.equal(report.rows[0][4], 'Ongoing');
  assert.deepEqual(Array.from(report.sections[1].rows, row => Array.from(row)), [
    ['Cat', 1, '25.0%'], ['Dog', 1, '25.0%'], ['Monkey', 1, '25.0%'], ['Not recorded', 1, '25.0%']
  ]);
  e.reportStartDate.value = '2026-09-01';
  e.reportEndDate.value = '2026-09-30';
  const filtered = c.reportDefinition('cases', c.reportRange());
  assert.equal(filtered.rows.length, 3);
  assert.equal(filtered.sections[1].rows.some(row => row[0] === 'Dog'), false);
  c.openReportPreview('cases');
  assert.match(e.reportPreviewDocument.innerHTML, /Monthly comparative report/);
  assert.match(e.reportPreviewDocument.innerHTML, /Source of rabies report/);
  assert.match(e.reportPreviewDocument.innerHTML, /Animal source/);
  assert.match(e.reportPreviewDocument.innerHTML, /Monkey/);
});

test('monthly comparison spans year boundaries, includes empty months, and handles zero baselines', () => {
  const { context: c, elements: e } = fixture();
  e.reportComparisonMonths.value = '3';
  const rows = ['2025-12-03', '2025-12-17', '2026-02-01', '2026-03-01'].map(date => ({ case_date: c.dateValue(date) }));
  const section = c.monthlyCaseComparison(rows, { end: '2026-02-28' });
  assert.deepEqual(Array.from(section.rows, row => Array.from(row)), [
    ['December 2025', 2, '—', '—'],
    ['January 2026', 0, '-2', '-100.0%'],
    ['February 2026', 1, '+1', 'N/A (previous month: 0)']
  ]);
  e.reportComparisonMonths.value = '12';
  assert.equal(c.monthlyCaseComparison([], { end: '2026-02-28' }).rows.length, 12);
  e.reportComparisonMonths.value = '6';
  const now = vm.runInContext('new Date(2026, 1, 7)', c);
  const current = c.monthlyCaseComparison([{ case_date: c.dateValue('2026-02-08') }], {}, now);
  assert.equal(current.rows.length, 6);
  assert.equal(current.rows[5][1], 0);
  assert.equal(current.rows[1][3], '0.0%');
  assert.match(current.note, /through February 7, 2026/);
});

test('PDF download includes the same animal-source and monthly comparison sections as the preview', () => {
  const { context: c } = fixture();
  const written = [];
  let saved = '';
  c.window = { jspdf: { jsPDF: class {
    setFontSize() {}
    text(value) { written.push(String(value)); }
    splitTextToSize(value) { return [value]; }
    addPage() {}
    save(filename) { saved = filename; }
  } } };
  c.appointments = [{ id: 'a1', preferred_date: '2026-09-13', animal_type: 'Dog', status: 'completed' }];
  c.legacyDownloadReport('cases');
  assert.match(written.join('\n'), /Monthly comparative report/);
  assert.match(written.join('\n'), /Source of rabies report/);
  assert.match(written.join('\n'), /Dog \| 1 \| 100.0%/);
  assert.match(saved, /^cases-report-.*\.pdf$/);
});
