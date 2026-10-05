'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBatchBookingHandler } = require('./booking');
const { key } = require('./treatment');

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function scheduleDate(doseNumber) {
  return new Date(Date.UTC(2026, 8, 24 + (doseNumber - 1) * 3)).toISOString().slice(0, 10);
}

function fixture({ appointments = [], recommendations, completedDose = 1 } = {}) {
  const rows = new Map();
  let sequence = 0;
  let queue = Promise.resolve();
  const ref = (name, id) => ({ name, id, path: `${name}/${id}` });
  const collection = name => ({
    doc: id => ref(name, id || `new-${++sequence}`),
    where: (field, operator, value) => ({
      name,
      filters: [[field, value]],
      where(nextField, nextOperator, nextValue) {
        this.filters.push([nextField, nextValue]);
        return this;
      }
    })
  });
  const db = {
    collection,
    runTransaction: callback => {
      const result = queue.then(async () => {
        const writes = [];
        let writing = false;
        const transaction = {
          get: async target => {
            assert.equal(writing, false, 'all reads must precede writes');
            if (target.filters) {
              const docs = [...rows.entries()]
                .filter(([path, value]) => path.startsWith(`${target.name}/`)
                  && target.filters.every(([field, expected]) => value[field] === expected))
                .map(([path, value]) => ({ id: path.split('/')[1], ref: ref(target.name, path.split('/')[1]), data: () => structuredClone(value) }));
              return { docs, empty: !docs.length };
            }
            return { data: () => rows.has(target.path) ? structuredClone(rows.get(target.path)) : undefined };
          },
          set: (target, value) => { writing = true; writes.push([target.path, structuredClone(value)]); },
          update: (target, value) => {
            writing = true;
            writes.push([target.path, { ...rows.get(target.path), ...structuredClone(value) }]);
          }
        };
        const output = await callback(transaction);
        writes.forEach(([path, value]) => rows.set(path, value));
        return output;
      });
      queue = result.catch(() => {});
      return result;
    }
  };

  const doses = Array.from({ length: 5 }, (_, index) => ({
    dose_number: index + 1,
    recommended_date: recommendations?.[index] || scheduleDate(index + 1),
    actual_administration_date: index + 1 <= completedDose ? `2026-09-${18 + index}` : null
  }));
  rows.set('inventory/batch',{clinic_id:'clinic-a',type:'Vaccine',quantity:20,expiry:'2099-01-01'});
  rows.set('users/resident', { role: 'resident', is_active: true, full_name: 'Resident' });
  rows.set('clinics/clinic-a', { name: 'Clinic A', hours: '24 hours', address: 'City', staff_uid: 'staff' });
  rows.set(`treatments/${key('resident', 'course')}`, {
    resident_uid: 'resident', vaccination_session_id: 'course', doses
  });
  if (completedDose) rows.set('vaccination_records/dose-1', {
    resident_uid: 'resident', vaccination_session_id: 'course', dose_number: 1,
    date_given: '2026-09-18'
  });
  appointments.forEach((item, index) => rows.set(`appointments/existing-${index}`, item));
  const auth = {
    uid: 'resident',
    token: { secure_login: true, email_verified: true, email: 'resident@example.test', firebase: { sign_in_provider: 'custom' } }
  };
  const handler = createBatchBookingHandler({
    db, HttpsError, timestamp: () => 'server-time', now: () => new Date('2026-09-21T04:00:00Z')
  });
  const book = appointmentsList => handler({
    auth,
    data: { clinic_id: 'clinic-a', vaccination_session_id: 'course', appointments: appointmentsList }
  });
  return { book, rows };
}

function datesFor(doseNumbers = [2, 3, 4, 5]) {
  return doseNumbers.map(dose => ({
    dose_number: dose,
    preferred_date: scheduleDate(dose),
    preferred_time: '09:00 AM'
  }));
}

test('batch books every pending dose and updates the treatment in one transaction', async () => {
  const f = fixture();
  const result = await f.book(datesFor());
  assert.equal(result.appointments.length, 4);
  assert.equal([...f.rows.keys()].filter(path => path.startsWith('appointments/new-')).length, 4);
  const treatment = f.rows.get(`treatments/${key('resident', 'course')}`);
  assert.equal(treatment.doses[1].appointment_date, '2026-09-27');
  assert.ok(treatment.doses[4].appointment_id);
});

test('batch rejects missing doses, dates before recommendation, and duplicate time slots atomically', async () => {
  const missing = fixture();
  await assert.rejects(missing.book(datesFor().slice(1)), { code: 'failed-precondition' });
  assert.equal([...missing.rows.keys()].filter(path => path.startsWith('appointments/new-')).length, 0);

  const tooEarly = fixture();
  const early = datesFor();
  early[0].preferred_date = '2026-09-23';
  await assert.rejects(tooEarly.book(early), { code: 'failed-precondition' });
  assert.equal([...tooEarly.rows.keys()].filter(path => path.startsWith('appointments/new-')).length, 0);

  const duplicate = fixture();
  const sameSlot = datesFor();
  sameSlot[0].preferred_date = sameSlot[1].preferred_date;
  sameSlot[1].preferred_time = sameSlot[0].preferred_time;
  await assert.rejects(duplicate.book(sameSlot), { code: 'invalid-argument' });
  assert.equal([...duplicate.rows.keys()].filter(path => path.startsWith('appointments/new-')).length, 0);
});

test('batch skips the dose already in progress and updates an existing pending dose', async () => {
  const f = fixture({
    appointments: [
      { resident_uid: 'resident', vaccination_session_id: 'course', dose_number: 2, status: 'in_progress', preferred_date: '2026-09-22', preferred_time: '09:00 AM', created_at: 'a' },
      { resident_uid: 'resident', vaccination_session_id: 'course', dose_number: 3, status: 'pending', preferred_date: '2026-09-25', preferred_time: '09:00 AM', clinic_id: 'clinic-a', created_at: 'b' }
    ]
  });
  const result = await f.book(datesFor([3, 4, 5]));
  assert.equal(result.appointments.length, 3);
  assert.equal(f.rows.get('appointments/existing-0').status, 'in_progress');
  assert.equal(f.rows.get('appointments/existing-1').preferred_date, '2026-09-30');
  assert.equal(f.rows.get('appointments/existing-1').reschedule_requested, true);
  const notifications = [...f.rows.entries()].filter(([path]) => path.startsWith('notifications/')).map(([, item]) => item);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].clinic_id, 'clinic-a');
  assert.equal(notifications[0].audience, 'clinic_staff');
  assert.equal(notifications[0].action, 'rescheduled');
});

test('a full slot rejects the entire batch without partial appointments', async () => {
  const occupied = Array.from({ length: 5 }, (_, index) => ({
    resident_uid: `another-resident-${index}`,
    clinic_id: 'clinic-a',
    preferred_date: '2026-09-30',
    preferred_time: '09:00 AM',
    status: 'confirmed'
  }));
  const f = fixture({ appointments: occupied });
  await assert.rejects(f.book(datesFor()), { code: 'resource-exhausted' });
  assert.equal([...f.rows.keys()].filter(path => path.startsWith('appointments/new-')).length, 0);
});

test('batch does not bypass confirmed-appointment rescheduling restrictions', async () => {
  const f = fixture({
    appointments: [
      { resident_uid: 'resident', vaccination_session_id: 'course', dose_number: 2, status: 'confirmed', preferred_date: '2026-09-27', preferred_time: '09:00 AM', clinic_id: 'clinic-a', created_at: 'a' }
    ]
  });
  const selection = datesFor();
  selection[0].preferred_time = '09:30 AM';
  await assert.rejects(f.book(selection), { code: 'failed-precondition' });
  assert.equal(f.rows.get('appointments/existing-0').preferred_time, '09:00 AM');
  assert.equal([...f.rows.keys()].filter(path => path.startsWith('appointments/new-')).length, 0);
});

test('batch rejects a clinic with no usable stock', async () => {
  const f = fixture();
  f.rows.get('clinics/clinic-a').status = 'out';
  f.rows.get('inventory/batch').quantity = 0;
  await assert.rejects(f.book(datesFor()), { code: 'failed-precondition' });
  assert.equal([...f.rows.keys()].filter(path => path.startsWith('appointments/new-')).length, 0);
});

test('batch bookings reject low stock even when clinic summary says available',async()=>{
 const f=fixture();f.rows.get('inventory/batch').quantity=15;
 f.rows.get('clinics/clinic-a').stock_status='available';
 await assert.rejects(f.book(datesFor()),{code:'failed-precondition'});
 assert.equal([...f.rows.keys()].filter(path=>path.startsWith('appointments/new-')).length,0);
});
