const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/admin-analytics.js'), 'utf8');
function fixture() {
  const elements = {
    reportStartDate: { value: '' }, reportEndDate: { value: '' },
    reportBarangayFilter: { value: '' }, reportStatusFilter: { value: '' },
    reportBarangaySort: { value: 'original' }, reportBarangaySortControl: { hidden: true },
    reportDateSort: { value: 'original' }, reportDateSortControl: { hidden: true },
    reportStatusSort: { value: 'original' }, reportStatusSortControl: { hidden: true },
    reportComparisonMonths: { value: '6' }, reportComparisonControl: { hidden: true },
    reportPreviewDocument: {}, reportPreviewTitle: {},
    reportPreviewModal: { hidden: true, setAttribute() {} }
  };
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    appointments: [], vaccinations: [], inventory: [], clinics: [], activeReportKind: null,
    barangayFor: item => item.barangay || item.fallbackBarangay || 'Unknown',
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
    notifyDialog(message) { throw new Error(message); }
  });
  vm.runInContext(source.slice(source.indexOf('function dateValue('), source.indexOf('function inSelectedAnalyticsYear(')), context);
  vm.runInContext(source.slice(source.indexOf('function formatReportDate('), source.indexOf('let bploZoom')), context);
  return { context, elements };
}

function completeCourse(context, appointmentId) {
  context.vaccinations.push(...[1, 2, 3, 4, 5].map(dose_number => ({ appointment_id: appointmentId, dose_number })));
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
    { id: 'complete', preferred_date: '2026-09-13', barangay: 'Marinig', status: 'completed' },
    { preferred_date: '2026-09-13', fallbackBarangay: 'Bigaa', status: 'confirmed' },
    { barangay: 'banlic', status: 'expired' },
    { barangay: 'Bigaa', status: 'in_progress' },
    { barangay: 'Sala' },
    { barangay: 'Excluded', status: 'declined' }
  ];
  completeCourse(c, 'complete');
  e.reportBarangaySort.value = 'asc';
  let report = c.reportDefinition('cases', c.reportRange());
  assert.deepEqual(Array.from(report.rows, row => row[2]), ['Bigaa', 'Bigaa', 'Marinig']);
  assert.deepEqual(Array.from(report.rows, row => row[4]), ['Incomplete', 'Incomplete', 'Completed']);
  assert.deepEqual(Array.from(report.totals, row => Array.from(row)), [['Reported cases', 3], ['Completed', 1], ['Incomplete', 2]]);
  assert.equal(c.appointments[0].barangay, 'Marinig');
  e.reportBarangaySort.value = 'desc';
  report = c.reportDefinition('cases', c.reportRange());
  assert.deepEqual(Array.from(report.rows, row => row[2]), ['Marinig', 'Bigaa', 'Bigaa']);
  c.openReportPreview('cases');
  assert.equal(e.reportBarangaySortControl.hidden, false);
  assert.equal(e.reportComparisonControl.hidden, true);
  assert.match(e.reportPreviewDocument.innerHTML, /September 13, 2026/);
  assert.ok(e.reportPreviewDocument.innerHTML.indexOf('<td>Marinig</td>') < e.reportPreviewDocument.innerHTML.indexOf('<td>Bigaa</td>'));
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
    { id: 'a3', vaccination_session_id: 's2', resident_uid: 'r1', preferred_date: '2026-09-18', status: 'in_progress', animal_type: 'Cat' },
    { id: 'a4', preferred_date: '2026-09-19', status: 'in_progress', animal_type: 'Other', animal_other: 'Monkey' },
    { id: 'a5', preferred_date: '2026-09-20', status: 'confirmed' },
    { id: 'a6', preferred_date: '2026-09-20', status: 'cancelled', animal_type: 'Dog' },
    { id: 'a7', preferred_date: '2026-09-20', status: 'declined', animal_type: 'Dog' }
  ];
  c.vaccinations = [{ vaccination_session_id: 's2', animal_type: 'Cat', date_given: '2026-10-01' }];
  const report = c.reportDefinition('cases', c.reportRange());
  assert.equal(report.rows.length, 4);
  assert.equal(report.rows[0][0], 'August 31, 2026');
  assert.equal(report.rows[0][4], 'Incomplete');
  const exposure = c.reportDefinition('exposure', c.reportRange());
  assert.deepEqual(Array.from(exposure.rows, row => Array.from(row)), [
    ['Cat', 1, '25.0%'], ['Dog', 1, '25.0%'], ['Monkey', 1, '25.0%'], ['Not recorded', 1, '25.0%']
  ]);
  e.reportStartDate.value = '2026-09-01';
  e.reportEndDate.value = '2026-09-30';
  const filtered = c.reportDefinition('cases', c.reportRange());
  assert.equal(filtered.rows.length, 3);
  assert.equal(c.reportDefinition('exposure', c.reportRange()).rows.some(row => row[0] === 'Dog'), false);
  c.openReportPreview('cases');
  assert.match(e.reportPreviewDocument.innerHTML, /Monthly Rabies Cases Report/);
  assert.doesNotMatch(e.reportPreviewDocument.innerHTML, /Change in cases|Change \(%\)/);
  assert.doesNotMatch(e.reportPreviewDocument.innerHTML, /Animal Exposure Source Report|Share of cases/);
  c.openReportPreview('exposure');
  assert.equal(e.reportPreviewTitle.textContent, 'Animal Exposure Source Report');
  assert.equal(e.reportBarangaySortControl.hidden, true);
  assert.equal(e.reportComparisonControl.hidden, true);
  assert.doesNotMatch(e.reportPreviewDocument.innerHTML, /Monthly comparative report|Change in cases/);
  assert.match(e.reportPreviewDocument.innerHTML, /Animal source/);
  assert.match(e.reportPreviewDocument.innerHTML, /Monkey/);
});

test('date, barangay and status filters combine across case reports and printed coverage', () => {
  const { context: c, elements: e } = fixture();
  c.appointments = [
    { id: 'a', preferred_date: '2026-09-13', barangay: 'Sala', status: 'completed', animal_type: 'Dog' },
    { id: 'b', preferred_date: '2026-09-14', barangay: 'Sala', status: 'confirmed', animal_type: 'Cat' },
    { id: 'c', preferred_date: '2026-09-15', barangay: 'Bigaa', status: 'completed', animal_type: 'Cat' },
    { id: 'd', preferred_date: '2026-08-13', barangay: 'Sala', status: 'completed', animal_type: 'Cat' }
  ];
  completeCourse(c, 'a');
  completeCourse(c, 'c');
  completeCourse(c, 'd');
  e.reportStartDate.value = '2026-09-01';
  e.reportEndDate.value = '2026-09-30';
  e.reportBarangayFilter.value = 'Sala';
  e.reportStatusFilter.value = 'Completed';
  const range = c.reportRange();
  const monthly = c.reportDefinition('cases', range);
  assert.equal(monthly.rows.length, 1);
  assert.equal(monthly.totals[0][1], 1);
  assert.equal(c.reportDefinition('comparison', range).rows.at(-1)[1], 1);
  assert.deepEqual(Array.from(c.reportDefinition('exposure', range).rows[0]), ['Dog', 1, '100.0%']);
  assert.deepEqual(Array.from(c.reportDefinition('risk', range).rows[0]), ['Sala', 1, 'High']);
  c.openReportPreview('exposure');
  assert.match(e.reportPreviewDocument.innerHTML, /Barangay: Sala; Status: Completed/);
  e.reportStatusFilter.value = 'Pending';
  c.openReportPreview('exposure');
  assert.match(e.reportPreviewDocument.innerHTML, /No records match/);
});

test('case details sort by date or normalized status without changing the source and keep missing dates last', () => {
  const { context: c, elements: e } = fixture();
  c.appointments = [
    { id: 'a', preferred_date: '2026-09-13', status: 'completed' },
    { id: 'b', preferred_date: '2026-09-15', status: 'confirmed' },
    { id: 'c', status: 'in_progress' }
  ];
  completeCourse(c, 'a');
  e.reportDateSort.value = 'desc';
  let rows = c.reportDefinition('cases', c.reportRange()).rows;
  assert.deepEqual(Array.from(rows, row => row[0]), ['September 15, 2026', 'September 13, 2026', 'No date']);
  e.reportDateSort.value = 'asc';
  rows = c.reportDefinition('cases', c.reportRange()).rows;
  assert.deepEqual(Array.from(rows, row => row[0]), ['September 13, 2026', 'September 15, 2026', 'No date']);
  e.reportDateSort.value = 'original';
  e.reportStatusSort.value = 'asc';
  assert.deepEqual(Array.from(c.reportDefinition('cases', c.reportRange()).rows, row => row[4]), ['Completed', 'Incomplete', 'Incomplete']);
  e.reportStatusSort.value = 'desc';
  assert.deepEqual(Array.from(c.reportDefinition('cases', c.reportRange()).rows, row => row[4]), ['Incomplete', 'Incomplete', 'Completed']);
  assert.equal(c.appointments[0].id, 'a');
});

test('barangay, date and status sorts combine in priority order and remain selected across previews', () => {
  const { context: c, elements: e } = fixture();
  c.appointments = [
    { id: 'sala', barangay: 'Sala', preferred_date: '2026-09-01', status: 'completed' },
    { id: 'newer', barangay: 'Bigaa', preferred_date: '2026-09-15', status: 'completed' },
    { id: 'ongoing', barangay: 'Bigaa', preferred_date: '2026-09-13', status: 'confirmed' },
    { id: 'pending', barangay: 'Bigaa', preferred_date: '2026-09-13', status: 'pending' },
    { id: 'resolved', barangay: 'Bigaa', preferred_date: '2026-09-13', status: 'completed' }
  ];
  completeCourse(c, 'resolved');
  e.reportBarangaySort.value = 'asc';
  e.reportDateSort.value = 'asc';
  e.reportStatusSort.value = 'desc';
  const sorted = c.sortReportCases(c.reportCaseRecords());
  assert.deepEqual(Array.from(sorted, row => row.id), ['ongoing', 'resolved', 'newer', 'sala']);
  c.openReportPreview('cases');
  assert.equal(e.reportDateSortControl.hidden, false);
  assert.equal(e.reportStatusSortControl.hidden, false);
  c.openReportPreview('exposure');
  assert.equal(e.reportDateSortControl.hidden, true);
  assert.equal(e.reportStatusSortControl.hidden, true);
  c.openReportPreview('cases');
  assert.equal(e.reportDateSort.value, 'asc');
  assert.equal(e.reportStatusSort.value, 'desc');
  assert.equal(c.appointments[0].id, 'sala');
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

test('case, comparison and animal exposure PDF downloads stay separate', () => {
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
  assert.match(written.join('\n'), /Monthly Rabies Cases Report/);
  assert.doesNotMatch(written.join('\n'), /Change in cases|Animal Exposure Source Report|Share of cases/);
  assert.match(saved, /^cases-report-.*\.pdf$/);
  written.length = 0;
  c.legacyDownloadReport('comparison');
  assert.match(written.join('\n'), /Monthly Comparative Report/);
  assert.match(written.join('\n'), /Change in cases/);
  assert.doesNotMatch(written.join('\n'), /Resident|Animal source/);
  assert.match(saved, /^comparison-report-.*\.pdf$/);
  written.length = 0;
  c.legacyDownloadReport('exposure');
  assert.match(written.join('\n'), /Animal Exposure Source Report/);
  assert.doesNotMatch(written.join('\n'), /Monthly comparative report|Change in cases/);
  assert.match(written.join('\n'), /Dog \| 1 \| 100.0%/);
  assert.match(saved, /^exposure-report-.*\.pdf$/);
});

test('comparative preview contains monthly aggregates and its own month control', () => {
  const { context: c, elements: e } = fixture();
  c.appointments = [
    { id: 'a', preferred_date: '2026-08-13', status: 'completed' },
    { id: 'b', preferred_date: '2026-09-13', status: 'confirmed' },
    { id: 'c', preferred_date: '2026-09-14', status: 'in_progress' },
    { id: 'd', preferred_date: '2026-01-14', status: 'pending' }
  ];
  e.reportEndDate.value = '2026-09-30';
  e.reportComparisonMonths.value = '3';
  const report = c.reportDefinition('comparison', c.reportRange());
  assert.equal(report.rows.length, 3);
  assert.equal(report.rows.at(-1)[2], '+1');
  assert.equal(report.rows.at(-1)[3], '+100.0%');
  assert.equal(report.totals[0][1], 3);
  c.openReportPreview('comparison');
  assert.equal(e.reportComparisonControl.hidden, false);
  assert.equal(e.reportBarangaySortControl.hidden, true);
  assert.equal(e.reportDateSortControl.hidden, true);
  assert.equal(e.reportStatusSortControl.hidden, true);
  assert.doesNotMatch(e.reportPreviewDocument.innerHTML, /<th scope="col">Resident/);
  e.reportComparisonMonths.value = '6';
  c.openReportPreview('comparison');
  assert.equal(c.reportDefinition('comparison', c.reportRange()).rows.length, 6);
});

test('trending report aligns monthly, barangay and exposure totals to the same filtered period', () => {
  const { context: c, elements: e } = fixture();
  e.reportStartDate.value = '2026-07-01';
  e.reportEndDate.value = '2026-09-30';
  e.reportComparisonMonths.value = '3';
  c.appointments = [
    { id: 'a', vaccination_session_id: 's1', barangay: 'Sala', preferred_date: '2026-07-10', status: 'completed', animal_type: 'Dog' },
    { id: 'b', vaccination_session_id: 's1', barangay: 'Sala', preferred_date: '2026-07-17', status: 'completed' },
    { id: 'c', barangay: 'Bigaa', preferred_date: '2026-09-01', status: 'in_progress', animal_type: 'Cat' },
    { id: 'd', barangay: 'Sala', preferred_date: '2026-09-02', status: 'completed' },
    { id: 'old', barangay: 'Bigaa', preferred_date: '2026-02-02', animal_type: 'Dog' },
    { id: 'future', barangay: 'Bigaa', preferred_date: '2026-10-01', animal_type: 'Dog' },
    { id: 'undated', barangay: 'Bigaa', animal_type: 'Dog' }
  ];
  completeCourse(c, 'a');
  completeCourse(c, 'd');
  let report = c.reportDefinition('trending', c.reportRange());
  assert.deepEqual(Array.from(report.rows, row => row[1]), [1, 0, 2]);
  assert.equal(report.totals[0][1], 3);
  assert.deepEqual(Array.from(report.sections[0].rows, row => Array.from(row)), [['Sala', 2, '66.7%'], ['Bigaa', 1, '33.3%']]);
  assert.deepEqual(Array.from(report.sections[1].rows, row => Array.from(row)), [['Cat', 1, '33.3%'], ['Dog', 1, '33.3%'], ['Not recorded', 1, '33.3%']]);
  e.reportBarangayFilter.value = 'Sala';
  e.reportStatusFilter.value = 'Completed';
  report = c.reportDefinition('trending', c.reportRange());
  assert.equal(report.totals[0][1], 2);
  c.openReportPreview('trending');
  assert.equal(e.reportComparisonControl.hidden, false);
  assert.equal(e.reportDateSortControl.hidden, true);
  assert.match(e.reportPreviewDocument.innerHTML, /Barangay: Sala; Status: Completed/);
  assert.match(e.reportPreviewDocument.innerHTML, /Cases by barangay/);
  assert.match(e.reportPreviewDocument.innerHTML, /Animal exposure sources/);
  assert.match(e.reportPreviewDocument.innerHTML, /do not establish why cases occur/);
  const header = e.reportPreviewDocument.innerHTML.split('</header>')[0];
  assert.match(header, /July 1, 2026 to September 30, 2026/);
  assert.doesNotMatch(header, /All recorded dates|do not establish|Each treatment course/);
  assert.match(e.reportPreviewDocument.innerHTML, /About this report/);
  assert.ok(e.reportPreviewDocument.innerHTML.indexOf('Monthly case trends') < e.reportPreviewDocument.innerHTML.indexOf('Cases by barangay'));
  e.reportStartDate.value = '';
  e.reportEndDate.value = '';
  const unbounded = c.trendingReport(c.reportCaseRecords(), {}, c.dateValue('2026-09-30'));
  assert.equal(unbounded.totals[0][1], 3);
});

test('empty trending report has zero monthly counts and no invalid percentages', () => {
  const { context: c } = fixture();
  c.openReportPreview('trending');
  const report = c.reportDefinition('trending', c.reportRange());
  assert.equal(report.totals[0][1], 0);
  assert.ok(report.rows.every(row => row[1] === 0));
  assert.equal(report.sections[0].rows.length, 0);
  assert.equal(report.sections[1].rows.length, 0);
});

test('reports use dose completion, exclude pending-only cases, and keep pending follow-ups from overriding treatment progress', () => {
  const { context: c, elements: e } = fixture();
  c.appointments = [
    { id: 'done', vaccination_session_id: 'done', preferred_date: '2026-09-01', status: 'completed' },
    { id: 'followup', vaccination_session_id: 'done', preferred_date: '2026-09-02', status: 'pending' },
    { id: 'partial', vaccination_session_id: 'partial', preferred_date: '2026-09-01', status: 'completed', completed_dose_number: 1 },
    { id: 'waiting', vaccination_session_id: 'partial', preferred_date: '2026-09-03', status: 'pending' },
    { id: 'pending-only', preferred_date: '2026-09-01', status: 'pending' },
    { id: 'expired-only', preferred_date: '2026-09-01', status: 'expired' },
    { id: 'ongoing', preferred_date: '2026-09-01', status: 'in_progress' },
    { id: 'confirmed', preferred_date: '2026-09-01', status: 'confirmed' }
  ];
  c.vaccinations = [1, 2, 3, 4, 5, 5].map(dose_number => ({ vaccination_session_id: 'done', dose_number }));
  c.vaccinations.push(...[1, 1, 1, 1, 1].map(dose_number => ({ vaccination_session_id: 'partial', dose_number })));
  e.reportEndDate.value = '2026-09-30';
  const records = c.reportCaseRecords();
  assert.deepEqual(Array.from(records, row => [row.id, row.status]), [
    ['done', 'Completed'], ['partial', 'Incomplete'], ['ongoing', 'Incomplete'], ['confirmed', 'Incomplete']
  ]);
  const report = c.reportDefinition('cases', c.reportRange());
  assert.deepEqual(Array.from(report.totals, row => Array.from(row)), [['Reported cases', 4], ['Completed', 1], ['Incomplete', 3]]);
  assert.equal(c.reportDefinition('comparison', c.reportRange()).rows.at(-1)[1], 4);
  assert.equal(c.reportDefinition('exposure', c.reportRange()).totals[0][1], 4);
  assert.equal(c.reportDefinition('trending', c.reportRange()).totals[0][1], 4);
  assert.equal(c.reportDefinition('risk', c.reportRange()).totals[2][1], 4);
  e.reportStatusFilter.value = 'Completed';
  assert.equal(c.reportDefinition('cases', c.reportRange()).rows.length, 1);
  e.reportStatusFilter.value = 'Incomplete';
  assert.equal(c.reportDefinition('cases', c.reportRange()).rows.length, 3);
  c.openReportPreview('cases');
  assert.doesNotMatch(e.reportPreviewDocument.innerHTML, />Pending<|>Ongoing<|>Resolved</);
});
