const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { clockMinutes } = require('./clinic-hours');
const source = fs.readFileSync(path.join(__dirname, '../scripts/residents.js'), 'utf8');

function submissionFixture(kind) {
  const ids = kind === 'reschedule'
    ? ['saveRescheduleBtn', 'rescheduleAppointmentId', 'rescheduleDate', 'rescheduleTime', 'rescheduleMsg', 'rescheduleModal']
    : ['saveCancelBtn', 'cancelAppointmentId', 'cancelReason', 'cancelMsg', 'cancelModal'];
  const elements = Object.fromEntries(ids.map(id => [id, { value: '', disabled: false, style: {}, classList: { remove() {} } }]));
  elements[kind === 'reschedule' ? 'rescheduleAppointmentId' : 'cancelAppointmentId'].value = 'a';
  if (kind === 'reschedule') {
    elements.rescheduleDate.value = '2026-10-05';
    elements.rescheduleTime.value = '10:00 AM';
  } else elements.cancelReason.value = 'Cannot attend';
  const calls = [], messages = [];
  let complete;
  const invoke = data => { calls.push({ ...data }); return new Promise(resolve => { complete = resolve; }); };
  const appointments = [{ id: 'a', status: 'pending', preferred_date: '2026-10-05', preferred_time: '9:00 AM' }];
  const context = {
    document: { getElementById: id => elements[id] },
    window: { residentAppointments: appointments },
    residentAppointments: appointments,
    activeRescheduleAppointment: { id: 'a', status: 'pending', preferred_date: '2026-10-05', preferred_time: '9:00 AM' },
    formatInputDate: (date, offset) => new Date(+date + offset * 86400000).toISOString().slice(0, 10),
    clockMinutes, rescheduleBooking: invoke, cancelBooking: invoke,
    notifyDialog: message => messages.push(message),
    addDoc() { assert.fail('Notifications must be committed by the server with the appointment change'); }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function nextRescheduleDate('), source.indexOf('function openRescheduleModal(')), context);
  if (kind === 'reschedule') vm.runInContext(source.slice(source.indexOf('async function saveReschedule()'), source.indexOf('function openCancelModal(')), context);
  else vm.runInContext(source.slice(source.indexOf('async function saveCancellation()'), source.indexOf('function escapeHtml(')), context);
  return { context, elements, calls, messages, complete: () => complete(), submit: () => context[kind === 'reschedule' ? 'saveReschedule' : 'saveCancellation']() };
}

test('reschedule sends one server request and tells the resident confirmation is required', async () => {
  const f = submissionFixture('reschedule');
  const pending = f.submit();
  await f.submit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.elements.saveRescheduleBtn.disabled, true);
  assert.equal(f.calls[0].appointment_id, 'a');
  assert.equal(f.calls[0].preferred_time, '10:00 AM');
  f.complete();
  await pending;
  assert.match(f.messages[0], /staff have been notified.*must confirm/);
  assert.equal(f.elements.saveRescheduleBtn.disabled, false);
});

test('reschedule accepts the following calendar day and rejects dates beyond it', async () => {
  const f = submissionFixture('reschedule');
  f.elements.rescheduleDate.value = '2026-10-07';
  await f.submit();
  assert.equal(f.calls.length, 0);
  assert.match(f.elements.rescheduleMsg.textContent, /2026-10-05 to 2026-10-06/);
  f.elements.rescheduleDate.value = '2026-10-06';
  const pending = f.submit();
  assert.equal(f.calls[0].preferred_date, '2026-10-06');
  f.complete();
  await pending;
  assert.match(f.messages[0], /must confirm your new date and time/);
});

test('cancellation requires a reason and cannot submit twice while saving', async () => {
  const f = submissionFixture('cancel');
  f.elements.cancelReason.value = ' ';
  await f.submit();
  assert.equal(f.calls.length, 0);
  assert.match(f.elements.cancelMsg.textContent, /provide a reason/);
  f.elements.cancelReason.value = 'Cannot attend';
  const pending = f.submit();
  await f.submit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.elements.saveCancelBtn.disabled, true);
  f.complete();
  await pending;
  assert.match(f.messages[0], /cancelled successfully.*staff have been notified/);
  assert.equal(f.elements.saveCancelBtn.disabled, false);
});

test('a failed reschedule preserves the modal and allows a corrected retry', async () => {
  const f = submissionFixture('reschedule');
  f.context.rescheduleBooking = async () => { throw new Error('This time slot is fully booked'); };
  await f.submit();
  assert.match(f.elements.rescheduleMsg.textContent, /fully booked/);
  assert.equal(f.elements.saveRescheduleBtn.disabled, false);
  assert.equal(f.messages.length, 0);
});

test('reschedule slot lookup uses the selected appointment before the resident snapshot loads', () => {
  const calls = [];
  const elements = { rescheduleAppointmentId: { value: 'a' } };
  const context = {
    document: { getElementById: id => elements[id] },
    residentAppointments: [],
    activeRescheduleAppointment: { id: 'a', clinic_id: 'clinic' },
    window: { clinicDirectory: [{ id: 'clinic' }] },
    updateTimeSelect: (...args) => calls.push(args)
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function refreshRescheduleSlots()'), source.indexOf('function updateBatchTimeSelect(')), context);
  context.refreshRescheduleSlots();
  assert.deepEqual(calls, [['rescheduleTime', 'rescheduleDate', { id: 'clinic' }, 'rescheduleTimeHint']]);
});

test('clinic-list appointment actions are available before DOMContentLoaded', () => {
  const readyListener = source.indexOf("document.addEventListener('DOMContentLoaded',");
  const rescheduleAction = source.indexOf('window.openRescheduleModal = openRescheduleModal;');
  const cancelAction = source.indexOf('window.openCancelModal = openCancelModal;');
  assert.ok(rescheduleAction >= 0 && rescheduleAction < readyListener);
  assert.ok(cancelAction >= 0 && cancelAction < readyListener);
});

function clinicWidgetFixture() {
  let clock = Date.parse('2026-10-05T04:00:00+08:00');
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const makeElement = tag => ({
    tag, children: [], style: {}, isConnected: true, value: '', disabled: false,
    classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); }, contains(value) { return this.values.has(value); } },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    setAttribute() {},
    listeners: {},
    focus(options) { this.focusOptions = options; },
    showPicker() { this.pickerShown = true; },
    addEventListener(event, callback) { this.listeners[event] = callback; },
    click() {
      const state = { prevented: false, stopped: false };
      this.listeners.click?.({
        preventDefault() { state.prevented = true; },
        stopPropagation() { state.stopped = true; }
      });
      return state;
    }
  });
  const ids = ['rescheduleAppointmentId', 'rescheduleDate', 'rescheduleTime', 'rescheduleMsg', 'rescheduleModal', 'cancelAppointmentId', 'cancelReason', 'cancelMsg', 'cancelModal'];
  const elements = Object.fromEntries(ids.map(id => [id, makeElement('div')]));
  elements.rescheduleTime.options = [{ value: '8:00 AM' }, { value: '10:00 AM' }];
  const messages = [], timers = [];
  const booking = { id: 'a', clinic_id: 'clinic', status: 'confirmed', preferred_date: '2026-10-05', preferred_time: '8:00 AM' };
  const host = makeElement('div');
  const context = {
    Date: TestDate, window: {}, host, booking,
    clinic: { id: 'clinic', status: 'available' },
    residentAppointments: [], activeRescheduleAppointment: null,
    refreshRescheduleSlots() {}, notifyDialog: message => messages.push(message),
    setInterval: callback => timers.push(callback), STATUS_LABEL: { available: 'Available' },
    document: { getElementById: id => elements[id], createElement: makeElement }
  };
  vm.createContext(context);
  const statusSource = fs.readFileSync(path.join(__dirname, '../scripts/booking-status.js'), 'utf8');
  const mapSource = fs.readFileSync(path.join(__dirname, '../scripts/residents-map.js'), 'utf8');
  vm.runInContext(statusSource.replace(/^export /gm, ''), context);
  vm.runInContext(source.slice(source.indexOf('function manilaToday('), source.indexOf('// Booking and display')), context);
  vm.runInContext(source.slice(source.indexOf('function editableAppointment('), source.indexOf('async function saveCancellation(')), context);
  vm.runInContext(mapSource.slice(mapSource.indexOf('let bookingRows'), mapSource.indexOf('onAuthStateChanged(')), context);
  vm.runInContext(mapSource.slice(mapSource.indexOf('function mountBookingWidget('), mapSource.indexOf('let CLINICS')), context);
  vm.runInContext("bookingRows = [booking]; bookingState = 'ready'; mountBookingWidget(host, clinic, 'googleMapOverview');", context);
  return {
    context, elements, messages, booking,
    buttons: () => host.children.flatMap(element => element.tag === 'button' ? [element] : element.children).filter(element => element.tag === 'button'),
    advance: instant => { clock = Date.parse(instant); timers.forEach(callback => callback()); },
    setClock: instant => { clock = Date.parse(instant); }
  };
}

test('clinic-list buttons open both dialogs before the dashboard appointment snapshot loads', () => {
  const f = clinicWidgetFixture();
  const [reschedule, cancel] = f.buttons();
  const rescheduleClick = reschedule.click();
  assert.equal(f.elements.rescheduleModal.classList.contains('open'), true);
  assert.equal(f.elements.rescheduleAppointmentId.value, 'a');
  assert.equal(f.elements.rescheduleDate.min, '2026-10-05');
  assert.equal(f.elements.rescheduleDate.max, '2026-10-06');
  assert.equal(f.elements.rescheduleDate.focusOptions.preventScroll, true);
  assert.equal(f.elements.rescheduleDate.pickerShown, true);
  assert.deepEqual(rescheduleClick, { prevented: true, stopped: true });
  const cancelClick = cancel.click();
  assert.equal(f.elements.cancelModal.classList.contains('open'), true);
  assert.equal(f.elements.cancelAppointmentId.value, 'a');
  assert.deepEqual(cancelClick, { prevented: true, stopped: true });
});

test('clinic-list buttons disappear when the arrival deadline passes without a snapshot', () => {
  const f = clinicWidgetFixture();
  f.advance('2026-10-05T09:29:59+08:00');
  assert.equal(f.buttons().length, 2);
  f.advance('2026-10-05T09:30:00+08:00');
  assert.equal(f.buttons().length, 1);
  assert.equal(f.buttons()[0].textContent, 'Book Appointment');
  assert.equal(f.buttons()[0].disabled, false);
});

test('clicking an appointment at expiry gives feedback instead of silently returning', () => {
  const f = clinicWidgetFixture();
  const [reschedule, cancel] = f.buttons();
  f.setClock('2026-10-05T09:30:00+08:00');
  reschedule.click();
  cancel.click();
  assert.equal(f.elements.rescheduleModal.classList.contains('open'), false);
  assert.equal(f.elements.cancelModal.classList.contains('open'), false);
  assert.equal(f.messages.length, 2);
  assert.ok(f.messages.every(message => /expired.*book a new appointment/.test(message)));
});

test('clinic-list actions check the latest appointment before opening a dialog', () => {
  const f = clinicWidgetFixture();
  f.context.residentAppointments = [{ ...f.booking, status: 'in_progress', arrived_at: 'server' }];
  const [reschedule, cancel] = f.buttons();
  reschedule.click();
  cancel.click();
  assert.equal(f.elements.rescheduleModal.classList.contains('open'), false);
  assert.equal(f.elements.cancelModal.classList.contains('open'), false);
  assert.equal(f.messages.length, 2);
});

test('dashboard actions target the selected appointment and stay hidden after arrival', () => {
  const containers = new Map();
  function container() {
    let html = '';
    let buttons = new Map();
    return {
      get innerHTML() { return html; },
      set innerHTML(value) { html = value; buttons = new Map(); },
      querySelectorAll(selector) {
        const name = selector.slice(1);
        const pattern = new RegExp(`<button[^>]*class="[^"]*${name}[^>]*data-appointment-id="([^"]+)"`, 'g');
        if (!buttons.has(selector)) buttons.set(selector, [...html.matchAll(pattern)].map(match => ({
          dataset: { appointmentId: match[1] }, listeners: [],
          addEventListener(event, callback) { this.listeners.push(callback); },
          click() { this.listeners.forEach(callback => callback()); }
        })));
        return buttons.get(selector);
      }
    };
  }
  const dashboard = container();
  containers.set('upcomingAppointmentsList', dashboard);
  const opened = [];
  const context = {
    document: { getElementById: id => containers.get(id) },
    appointmentStatus: item => item.status,
    escapeHtml: value => String(value), manilaToday: () => '2026-10-05',
    openRescheduleModal: item => opened.push(['reschedule', item.id]),
    openCancelModal: item => opened.push(['cancel', item.id])
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function appointmentActionMarkup('), source.indexOf('function renderLiveAppointments(')), context);
  const booking = { id: 'a', status: 'pending', preferred_date: '2026-10-05', preferred_time: '10:00 AM', reschedule_requested: true };
  context.renderUpcomingAppointments([booking]);
  assert.match(dashboard.innerHTML, /Reschedule awaiting confirmation/);
  dashboard.querySelectorAll('.reschedule-button')[0].click();
  dashboard.querySelectorAll('.cancel-appointment-button')[0].click();
  assert.deepEqual(opened, [['reschedule', 'a'], ['cancel', 'a']]);
  context.renderUpcomingAppointments([booking]);
  const cancel = dashboard.querySelectorAll('.cancel-appointment-button')[0];
  assert.equal(cancel.listeners.length, 1);
  for (const status of ['in_progress', 'completed', 'cancelled', 'declined']) {
    assert.equal(context.appointmentActionMarkup({ ...booking, status }), '');
  }
  assert.equal(context.appointmentActionMarkup({ ...booking, status: 'confirmed', arrived_at: 'server' }), '');
});

test('staff inbox includes shared clinic updates and legacy alerts once, without resident notices', async () => {
  const clinicSource = fs.readFileSync(path.join(__dirname, '../scripts/clinic-notifications.js'), 'utf8');
  const makeElement = tag => ({
    tag, children: [], disabled: false,
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    addEventListener(event, callback) { this[event] = callback; }
  });
  const list = makeElement('div');
  const status = {}, count = {}, badge = {};
  const shared = { id: 'shared', clinic_id: 'clinic', recipient_uid: 'another-staff', audience: 'clinic_staff', type: 'appointment', action: 'rescheduled', title: 'Reschedule requested', message: '<img src=x onerror=alert(1)>', read: false, created_at: { toMillis: () => 20 } };
  const personal = { id: 'legacy', type: 'appointment', recipient_uid: 'staff', read: true, created_at: { toMillis: () => 10 } };
  const writes = [];
  const context = {
    notificationSources: new Map([['clinic', [shared,
      { id: 'resident', clinic_id: 'clinic', type: 'appointment', recipient_uid: 'resident' },
      { ...shared, id: 'other-clinic', clinic_id: 'other' }]], ['staff', [shared, personal]]]),
    notificationStates: new Map([['clinic', 'ready'], ['staff', 'ready']]),
    clinicId: 'clinic', staffUid: 'staff', appointmentNotifications: [],
    loaded: true, rows: [], today: () => '2026-10-05', expiryReminders: () => [{}],
    auth: { currentUser: { uid: 'staff' } }, db: {},
    doc: (db, collection, id) => ({ collection, id }),
    updateDoc: async (reference, data) => writes.push({ reference, data }),
    document: {
      getElementById: id => ({ clinicAppointmentNotifications: list, clinicAppointmentNotificationStatus: status, clinicAppointmentUnreadCount: count })[id],
      querySelectorAll: () => [badge], createElement: makeElement
    }
  };
  vm.createContext(context);
  vm.runInContext(clinicSource.slice(clinicSource.indexOf('function selectClinicAppointmentNotifications('), clinicSource.indexOf('function listenToClinicAppointmentNotifications(')), context);
  context.renderClinicAppointmentNotifications();
  assert.equal(list.children.length, 2);
  assert.equal(context.appointmentNotifications[0].id, 'shared');
  assert.equal(count.textContent, '1 unread');
  assert.equal(badge.textContent, ' (2)');
  const card = list.children[0];
  assert.equal(card.children[2].textContent, shared.message);
  assert.equal(card.children[3].children[0].href, 'staff.html#resident-appointments');
  const button = card.children[3].children[1];
  await context.markClinicNotificationRead('shared', button);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].reference.id, 'shared');
  assert.equal(writes[0].data.read, true);
  shared.read = true;
  context.renderClinicAppointmentNotifications();
  assert.equal(count.textContent, 'All read');
  assert.equal(badge.textContent, ' (1)');
});
