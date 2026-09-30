const test = require('node:test');
const assert = require('node:assert/strict');
const { createBookingHandler, activeBooking } = require('./booking');
class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
function fixture(initial = [], clinic = { name: 'Clinic', hours: '24 hours' }) {
 const appointments = initial.map((data, i) => ({ id: String(i), data: () => data }));
 let sequence = 0, queue = Promise.resolve();
 const profiles = { resident: { role: 'resident', is_active: true, full_name: 'Resident' } };
 const db = {
  collection: name => ({
   doc: id => ({ name, id: id || 'new-' + (++sequence) }),
   where: (key, op, value) => { const q = { filters: [[key,value]], where: (k,o,v) => { q.filters.push([k,v]); return q; } }; return q; }
  }),
  runTransaction: fn => { const p = queue.then(() => fn({
   get: async ref => ref.filters ? { docs: appointments.filter(d => ref.filters.every(([k,v]) => d.data()[k] === v)) } : { data: () => ref.name === 'users' ? profiles[ref.id] : ref.name === 'clinics' ? clinic : undefined },
   set: (ref, data) => { if (ref.name === 'appointments') appointments.push({ id: ref.id, data: () => data }); }
  })); queue = p.catch(() => {}); return p; }
 };
 const handler = createBookingHandler({ db, HttpsError, timestamp: () => 'server-time', now: () => new Date('2026-09-21T04:00:00Z') });
 const auth = { uid: 'resident', token: { secure_login: true, email_verified: true, firebase: { sign_in_provider: 'custom' } } };
 return { appointments, book: (data = {}, identity = auth) => handler({ auth: identity, data: { clinic_id: 'clinic-a', preferred_date: '2026-09-22', preferred_time: '09:00', ...data } }) };
}
test('pending and accepted statuses block only the same resident and clinic', async () => {
 for (const status of ['pending', 'confirmed', 'accepted', 'approved', 'in_progress']) {
  const f = fixture([{ resident_uid: 'resident', clinic_id: 'clinic-a', status }]);
  await assert.rejects(f.book(), { code: 'already-exists' });
  await f.book({ clinic_id: 'clinic-b' });
 }
});
test('completed, cancelled, declined and expired bookings allow another appointment', async () => {
 for (const status of ['completed', 'cancelled', 'declined', 'expired']) await fixture([{ resident_uid: 'resident', clinic_id: 'clinic-a', status }]).book();
 await fixture([{ resident_uid: 'other', clinic_id: 'clinic-a', status: 'pending' }]).book();
 await fixture([{ resident_uid: 'resident', clinic_id: 'clinic-a', status: 'confirmed', reservation_end_date: '2026-09-20' }]).book();
});
test('serialized concurrent submissions create exactly one appointment', async () => {
 const f = fixture();
 const results = await Promise.allSettled([f.book(), f.book(), f.book()]);
 assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
 assert.equal(f.appointments.length, 1);
});
test('server controls ownership, status and reservation window', async () => {
 const f = fixture();
 await f.book({ resident_uid: 'other', status: 'confirmed', created_at: 'fake', reservation_end_date: '2000-01-01' });
 const saved = f.appointments[0].data();
 assert.equal(saved.resident_uid, 'resident');
 assert.equal(saved.status, 'pending');
 assert.equal(saved.created_at, 'server-time');
 assert.equal(saved.reservation_end_date, undefined);
 assert.equal(saved.scheduled_at_ms, Date.parse('2026-09-22T01:00:00Z'));
});
test('unauthenticated requests, past appointments and future bites are rejected', async () => {
 const f = fixture();
 await assert.rejects(f.book({}, null), { code: 'unauthenticated' });
 await assert.rejects(f.book({ preferred_date: '2026-09-20' }), { code: 'invalid-argument' });
 await assert.rejects(f.book({ bite_date: '2026-09-22' }), { code: 'invalid-argument' });
 assert.equal(f.appointments.length, 0);
});
test('UI status selection matches backend and prioritizes acceptance over pending', async () => {
 const fs = require('node:fs');
 const path = require('node:path');
 const source = fs.readFileSync(path.join(__dirname, '../scripts/booking-status.js'), 'utf8');
 const { clinicBooking } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
 for (const status of ['pending', 'confirmed', 'accepted', 'approved', 'in_progress', 'cancelled', 'completed', 'declined', 'expired']) {
  const row = { clinic_id: 'a', status };
  assert.equal(Boolean(clinicBooking([row], 'a', '2026-09-21')), activeBooking(row, '2026-09-21'));
  assert.equal(clinicBooking([row], 'b', '2026-09-21'), null);
 }
 assert.equal(clinicBooking([{ clinic_id: 'a', status: 'pending' }, { clinic_id: 'a', status: 'confirmed' }], 'a', '2026-09-21').status, 'confirmed');
});

test('popup renders default, disabled pending, and accepted schedule without a button', async () => {
 const fs = require('node:fs');
 const path = require('node:path');
 const vm = require('node:vm');
 const source = fs.readFileSync(path.join(__dirname, '../scripts/residents-map.js'), 'utf8');
 const helper = fs.readFileSync(path.join(__dirname, '../scripts/booking-status.js'), 'utf8').replaceAll('export function', 'function');
 const renderer = source.slice(source.indexOf('function mountBookingWidget('), source.indexOf('let CLINICS ='));
 const makeElement = tag => ({ tag, style: {}, children: [], isConnected: true, append(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute() {}, addEventListener() {} });
 const context = { Intl, Date, bookingRows: [], bookingState: 'ready', bookingWidgets: new Set(), document: { createElement: makeElement }, window: {} };
 vm.createContext(context);
 vm.runInContext(helper + '\n' + renderer, context);
 const host = makeElement('div');
 const clinic = { id: 'a', status: 'available' };
 context.mountBookingWidget(host, clinic, 'googleMapOverview');
 assert.equal(host.children[0].textContent, 'Book Appointment');
 assert.equal(host.children[0].disabled, false);
 context.bookingRows = [{ clinic_id: 'a', status: 'pending' }];
 context.mountBookingWidget(host, clinic, 'googleMapOverview');
 assert.equal(host.children[0].textContent, 'Pending');
 assert.equal(host.children[0].disabled, true);
 context.bookingRows = [{ clinic_id: 'a', status: 'confirmed', preferred_date: '2099-09-22', preferred_time: '09:00' }];
 context.mountBookingWidget(host, clinic, 'googleMapOverview');
 assert.equal(host.children.some(child => child.tag === 'button'), false);
 assert.match(host.children[0].textContent, /2099-09-22 at 09:00/);
});

test('minimal booking ignores client medical, ID, arrival and permanent-record fields', async () => {
 const f = fixture();
 await f.book({ valid_id_url: 'untrusted', patient_age: 20, animal_type: 'Dog', arrived_at: 'fake', intake_completed_at: 'fake', patient_record_id: 'fake' });
 const saved = f.appointments[0].data();
 for (const key of ['valid_id_url','patient_age','animal_type','arrived_at','intake_completed_at','patient_record_id']) assert.equal(saved[key], undefined);
});

test('server rejects out-of-hours and non-slot bookings using saved clinic hours', async () => {
 for (const time of ['4:30 AM','5:00 PM','9:10 AM']) {
  await assert.rejects(fixture([], {name:'Clinic', hours:'5 AM - 5 PM'}).book({preferred_time:time}), {code:'invalid-argument'});
 }
 await fixture([], {name:'Clinic', hours:'5 AM - 5 PM'}).book({preferred_time:'5:00 AM'});
 await assert.rejects(fixture([], {name:'Clinic', hours:'Closed'}).book(), {code:'invalid-argument'});
});
