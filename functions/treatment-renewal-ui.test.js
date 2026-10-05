const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/residents.js'), 'utf8');
const completed = Array.from({ length: 5 }, (_, index) => ({
  vaccination_session_id: 'old-course', dose_number: index + 1,
  date_given: '2026-09-01', clinic_id: 'clinic', clinic_name: 'Clinic'
}));

test('a completed resident can open booking for a separate treatment starting at Dose 1', () => {
  const elements = { modalClinic: { value: 'clinic' }, bookingClinicName: {}, modalDate: {},
    bookingMsg: { style: {} }, confirmBookingBtn: {}, bookingModal: { classList: { add() {} } } };
  const messages = [];
  const context = { residentVaccinationRecords: completed, selectedClinic: null, selectedDose: '',
    document: { getElementById: id => elements[id] },
    window: { clinicDirectory: [{ id: 'clinic', name: 'Clinic' }] },
    getPrimaryClinicId: () => 'clinic', notifyDialog: text => messages.push(text),
    doseDayOffsets: [0,3,7,14,28], manilaToday: () => '2026-10-05', refreshTimeSlots() {},
    earliestBookingDate() { throw new Error('Old course schedule must not control the new treatment'); }
  };
  vm.runInNewContext(source.slice(source.indexOf('function openBookingModal('), source.indexOf('function closeBookingModal(')), context);
  context.openBookingModal('Clinic', 'clinic');
  assert.equal(context.selectedDose, 'Dose 1 (Day 0)');
  assert.equal(elements.modalDate.min, '2026-10-05');
  assert.equal(elements.confirmBookingBtn.disabled, false);
  assert.deepEqual(messages, []);
});

test('refresh selects a new course from appointments before any new dose exists', () => {
  const context = { currentVaccinationSessionId: '', residentAppointments: [
    { vaccination_session_id: 'old-course', created_at: { toMillis: () => 1 }, status: 'completed' },
    { vaccination_session_id: 'new-course', created_at: { toMillis: () => 2 }, status: 'pending' }
  ] };
  vm.runInNewContext(source.slice(source.indexOf('function setCurrentVaccinationSession('), source.indexOf('function renderPreviousVaccinationRecords(')), context);
  assert.equal(context.setCurrentVaccinationSession(completed).length, 0);
  assert.equal(context.currentVaccinationSessionId, 'new-course');
  const dose = { vaccination_session_id: 'new-course', dose_number: 1, date_given: '2026-10-05' };
  assert.deepEqual(context.setCurrentVaccinationSession([...completed, dose]), [dose]);
});

test('a booking response retains its new course while the appointments listener catches up', () => {
  const context = { currentVaccinationSessionId: 'new-course', residentAppointments: [
    { vaccination_session_id: 'old-course', status: 'completed' }
  ] };
  vm.runInNewContext(source.slice(source.indexOf('function setCurrentVaccinationSession('), source.indexOf('function renderPreviousVaccinationRecords(')), context);
  assert.equal(context.setCurrentVaccinationSession(completed).length, 0);
  assert.equal(context.currentVaccinationSessionId, 'new-course');
  assert.equal(context.setCurrentVaccinationSession([]).length, 0);
  assert.equal(context.currentVaccinationSessionId, 'new-course');
});

test('completed records appear under Previous History after a new course starts', () => {
  const container = { innerHTML: '', querySelectorAll: () => [] };
  const context = { currentVaccinationSessionId: 'new-course', allResidentVaccinationDocuments: [],
    document: { getElementById: () => container }, escapeHtml: value => String(value || ''),
    formatRecordDate: value => value
  };
  vm.runInNewContext(source.slice(source.indexOf('function renderPreviousVaccinationRecords('), source.indexOf('function renderDocumentPreview(')), context);
  context.renderPreviousVaccinationRecords(completed);
  assert.match(container.innerHTML, /Previous History/);
  assert.match(container.innerHTML, /100% Complete/);
  for (let dose = 1; dose <= 5; dose++) assert.match(container.innerHTML, new RegExp('Dose ' + dose + ':'));
});
