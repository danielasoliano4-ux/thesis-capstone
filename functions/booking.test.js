const test = require('node:test');
const assert = require('node:assert/strict');
const { createBookingHandler, activeBooking } = require('./booking');
class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
function fixture(initial = [], clinic = { name: 'Clinic', hours: '24 hours' }, inventory = {quantity:20}) {
 const appointments = initial.map((data, i) => ({ id: String(i), data: () => data }));
 let sequence = 0, queue = Promise.resolve();
 const profiles = { resident: { role: 'resident', is_active: true, full_name: 'Resident' } };
 const db = {
  collection: name => ({
   doc: id => ({ name, id: id || 'new-' + (++sequence) }),
   where: (key, op, value) => { const q = { name, filters: [[key,value]], where: (k,o,v) => { q.filters.push([k,v]); return q; } }; return q; }
  }),
  runTransaction: fn => { const p = queue.then(() => fn({
   get: async ref => ref.filters ? { docs: ref.name === 'inventory' ? [{id:'batch',data:()=>({clinic_id:'clinic-a',type:'Vaccine',expiry:'2099-01-01',...inventory})}] : appointments.filter(d => ref.filters.every(([k,v]) => d.data()[k] === v)) } : { data: () => ref.name === 'users' ? (profiles[ref.id] || profiles.resident) : ref.name === 'clinics' ? clinic : undefined },
   set: (ref, data) => { if (ref.name === 'appointments') appointments.push({ id: ref.id, data: () => data }); }
  })); queue = p.catch(() => {}); return p; }
 };
 const handler = createBookingHandler({ db, HttpsError, timestamp: () => 'server-time', now: () => new Date('2026-09-21T04:00:00Z') });
 const auth = { uid: 'resident', token: { secure_login: true, email_verified: true, firebase: { sign_in_provider: 'custom' } } };
 return { appointments, book: (data = {}, identity = auth) => handler({ auth: identity, data: { clinic_id: 'clinic-a', preferred_date: '2026-09-22', preferred_time: '09:00', ...data } }) };
}
test('single bookings allow 1 through 15 available doses despite stale clinic summaries', async () => {
 for (const quantity of [1,3,15,16]) {
  const f = fixture([], {name:'Clinic',hours:'24 hours',stock_total:0,stock_status:'out'}, {quantity});
  await f.book();
  assert.equal(f.appointments.length,1);
  assert.equal(f.appointments[0].data().status,'pending');
  assert.equal(f.appointments[0].data().stock_reservation,undefined);
 }
});

test('single bookings reject empty, fully reserved or expired stock without creating appointments', async () => {
 for (const inventory of [{quantity:0},{quantity:15,reserved_count:15,quantity_mode:'on_hand'},{quantity:15,expiry:'2026-09-20'}]) {
  const f = fixture([], {name:'Clinic',hours:'24 hours',stock_total:50,stock_status:'available'}, inventory);
  await assert.rejects(f.book(), {code:'failed-precondition',message:'This clinic is out of vaccine stock. Choose another clinic.'});
  assert.equal(f.appointments.length,0);
 }
});

test('active appointments block duplicate doses across clinics', async () => {
 for (const status of ['pending', 'confirmed', 'accepted', 'approved', 'in_progress']) {
  const f = fixture([{ resident_uid: 'resident', clinic_id: 'clinic-a', status }]);
  await assert.rejects(f.book(), { code: 'already-exists' });
  await assert.rejects(f.book({ clinic_id: 'clinic-b' }), { code: 'already-exists' });
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

test('popup shows booking actions for pending and confirmed appointments, with no actions after arrival', async () => {
 const fs = require('node:fs');
 const path = require('node:path');
 const vm = require('node:vm');
 const source = fs.readFileSync(path.join(__dirname, '../scripts/residents-map.js'), 'utf8');
 const helper = fs.readFileSync(path.join(__dirname, '../scripts/booking-status.js'), 'utf8').replaceAll('export function', 'function');
 const renderer = source.slice(source.indexOf('function mountBookingWidget('), source.indexOf('let CLINICS ='));
 const makeElement = tag => ({ tag, classList:{add(){}}, style: {}, children: [], isConnected: true, append(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute() {}, addEventListener(event, callback) { this[event] = callback; } });
 const actions = [];
 const context = { Intl, Date, bookingRows: [], bookingState: 'ready', bookingWidgets: new Set(), document: { createElement: makeElement }, window: { openRescheduleModal: appointment => actions.push(['reschedule', appointment.id]), openCancelModal: appointment => actions.push(['cancel', appointment.id]) } };
 vm.createContext(context);
 vm.runInContext(helper + '\n' + renderer, context);
 const host = makeElement('div');
 const clinic = { id: 'a', status: 'available' };
 context.mountBookingWidget(host, clinic, 'googleMapOverview');
 assert.equal(host.children[0].textContent, 'Book Appointment');
 assert.equal(host.children[0].disabled, false);
 context.bookingRows = [{ id: 'pending', clinic_id: 'a', status: 'pending' }];
 context.mountBookingWidget(host, clinic, 'googleMapOverview');
 assert.match(host.children[0].textContent, /Awaiting clinic confirmation/);
 assert.deepEqual(host.children[1].children.map(button => button.textContent), ['Reschedule', 'Cancel']);
 host.children[1].children[0].click({ preventDefault() {}, stopPropagation() {} });
 host.children[1].children[1].click({ preventDefault() {}, stopPropagation() {} });
 assert.deepEqual(actions, [['reschedule', 'pending'], ['cancel', 'pending']]);
 context.bookingRows = [{ clinic_id: 'a', status: 'confirmed', preferred_date: '2099-09-22', preferred_time: '09:00' }];
 context.mountBookingWidget(host, clinic, 'googleMapOverview');
 assert.equal(host.children.some(child => child.tag === 'button'), false);
 assert.match(host.children[0].textContent, /2099-09-22 at 09:00/);
 assert.equal(host.children[1].children.length, 2);
 context.bookingRows = [{ clinic_id: 'a', status: 'in_progress', arrived_at: 'server' }];
 context.mountBookingWidget(host, clinic, 'googleMapOverview');
 assert.equal(host.children.length, 1);
 context.bookingRows = [];
 context.auth = {currentUser:null};
 let guestContinued = 0;
 context.window.checkAuthAndBook = () => guestContinued++;
 context.confirmDialog = async () => false;
 context.mountBookingWidget(host, {id:'a',name:'Low Clinic',status:'low',stock_total:3}, 'googleMap');
 assert.equal(host.children[0].disabled,false);
 assert.equal(host.children[0].textContent,'Book Appointment');
 await host.children[0].click();
 assert.equal(guestContinued,0);
 context.confirmDialog = async () => true;
 await host.children[0].click();
 assert.equal(guestContinued,1);
 for (const status of ['out','unknown']) {
   context.STATUS_LABEL = {out:'Out of Stock',unknown:'Stock unavailable'};
   context.mountBookingWidget(host, {id:'a',status}, 'googleMap');
   assert.equal(host.children[0].disabled,true);
 }
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

test('five residents can book a slot concurrently; sixth must select another time',async()=>{
 const f=fixture();
 const identity=uid=>({uid,token:{secure_login:true,email_verified:true,firebase:{sign_in_provider:'custom'}}});
 const results=await Promise.allSettled(Array.from({length:6},(_,i)=>f.book({},identity('resident-'+i))));
 assert.equal(results.filter(item=>item.status==='fulfilled').length,5);
 assert.equal(results.find(item=>item.status==='rejected').reason.code,'resource-exhausted');
 await f.book({preferred_time:'09:30'},identity('resident-6'));
 assert.equal(f.appointments.length,6);
});
test('equivalent time labels share capacity; cancelled requests release slots',async()=>{
 const rows=Array.from({length:5},(_,i)=>({resident_uid:'other-'+i,clinic_id:'clinic-a',preferred_date:'2026-09-22',preferred_time:'9:00 AM',status:'confirmed'}));
 await assert.rejects(fixture(rows).book(),{code:'resource-exhausted'});
 rows[0].status='cancelled';await fixture(rows).book();
 await fixture(rows).book({clinic_id:'clinic-b'});
});
