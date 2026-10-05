const test = require('node:test');
const assert = require('node:assert/strict');
const { cancelBookingHandler, rescheduleBookingHandler } = require('./booking');
const { lifecycleHandler } = require('./appointment-lifecycle');
const { key } = require('./treatment');

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const identity = uid => ({ uid, token: { secure_login: true, email_verified: true, firebase: { sign_in_provider: 'custom' } } });

function fixture(status = 'confirmed') {
  let sequence = 0;
  let queue = Promise.resolve();
  let rejectNotification = false;
  const rows = new Map([
    ['users/resident', { role: 'resident', is_active: true, full_name: 'Patient One' }],
    ['users/staff', { role: 'clinic_staff', is_active: true, clinic_id: 'clinic' }],
    ['clinics/clinic', { name: 'Clinic One', hours: '24 hours', staff_uid: 'staff' }],
    ['inventory/batch', { clinic_id: 'clinic', type: 'Vaccine', quantity: 20, reserved_count: status === 'confirmed' ? 1 : 0, quantity_mode: 'on_hand', expiry: '2099-01-01' }],
    ['appointments/a', {
      resident_uid: 'resident', resident_name: 'Old Name', clinic_id: 'clinic', clinic_name: 'Clinic One', clinic_staff_uid: 'staff',
      vaccination_session_id: 'course', dose_number: 1, dose_label: 'Dose 1', status,
      preferred_date: '2026-10-05', preferred_time: '9:00 AM',
      scheduled_at_ms: Date.parse('2026-10-05T01:00:00Z'),
      confirmed_at: status === 'confirmed' ? 'old-confirmation' : null,
      arrival_deadline_ms: status === 'confirmed' ? Date.parse('2026-10-05T02:30:00Z') : null,
      ...(status === 'confirmed' ? { stock_reservation: { status: 'reserved', inventory_id: 'batch', quantity: 1 } } : {})
    }],
    [`treatments/${key('resident', 'course')}`, {
      resident_uid: 'resident', vaccination_session_id: 'course',
      doses: [{ dose_number: 1, recommended_date: '2026-10-05', appointment_id: 'a', appointment_date: '2026-10-05' }]
    }]
  ]);
  const reference = (name, id) => ({ name, id, path: `${name}/${id}` });
  const db = {
    collection: name => ({
      doc: id => reference(name, id || `new-${++sequence}`),
      where: (field, operator, value) => ({ name, field, value })
    }),
    runTransaction: callback => {
      const result = queue.then(async () => {
        const writes = [];
        let writing = false;
        const tx = {
          get: async target => {
            assert.equal(writing, false, 'transaction reads must precede writes');
            if (target.field) return {
              docs: [...rows.entries()].filter(([path, item]) => path.startsWith(`${target.name}/`) && item[target.field] === target.value)
                .map(([path, item]) => ({ id: path.split('/')[1], data: () => structuredClone(item) }))
            };
            return { exists: rows.has(target.path), data: () => rows.has(target.path) ? structuredClone(rows.get(target.path)) : undefined };
          },
          set: (target, value, options) => {
            writing = true;
            if (target.name === 'notifications' && rejectNotification) throw new Error('Notification write failed');
            const data = structuredClone(value);
            writes.push(() => rows.set(target.path, options?.merge ? { ...rows.get(target.path), ...data } : data));
          },
          update: (target, value) => {
            writing = true;
            const data = structuredClone(value);
            writes.push(() => rows.set(target.path, { ...rows.get(target.path), ...data }));
          }
        };
        const value = await callback(tx);
        writes.forEach(write => write());
        return value;
      });
      queue = result.catch(() => {});
      return result;
    }
  };
  const deps = { db, HttpsError, timestamp: () => 'server-time', now: () => new Date('2026-10-05T00:00:00Z') };
  const cancel = cancelBookingHandler(deps);
  const reschedule = rescheduleBookingHandler(deps);
  const manage = lifecycleHandler(deps);
  return {
    rows,
    notifications: () => [...rows.entries()].filter(([path]) => path.startsWith('notifications/')).map(([, item]) => item),
    failNotifications: () => { rejectNotification = true; },
    cancel: (uid = 'resident', reason = 'Cannot attend') => cancel({ auth: identity(uid), data: { appointment_id: 'a', reason } }),
    reschedule: (uid = 'resident', time = '10:00 AM') => reschedule({ auth: identity(uid), data: { appointment_id: 'a', preferred_date: '2026-10-05', preferred_time: time } }),
    manage: (action, uid = 'staff') => manage({ auth: identity(uid), data: { appointment_id: 'a', action } })
  };
}

test('cancelling pending and confirmed appointments notifies the clinic with the reason', async () => {
  for (const status of ['pending', 'confirmed']) {
    const f = fixture(status);
    await f.cancel();
    assert.equal(f.rows.get('appointments/a').status, 'cancelled');
    const [notification] = f.notifications();
    assert.equal(notification.clinic_id, 'clinic');
    assert.equal(notification.recipient_uid, 'staff');
    assert.equal(notification.audience, 'clinic_staff');
    assert.equal(notification.appointment_id, 'a');
    assert.equal(notification.action, 'cancelled');
    assert.equal(notification.read, false);
    assert.match(notification.message, /Patient One.*Dose 1.*Cannot attend/);
    assert.equal(f.rows.get('inventory/batch').reserved_count, 0);
    assert.equal(f.rows.get('inventory/batch').quantity, 20);
  }
});

test('simultaneous cancellation retries send one alert and release stock only once', async () => {
  const f = fixture();
  await Promise.all([f.cancel(), f.cancel()]);
  assert.equal(f.notifications().length, 1);
  assert.equal(f.rows.get('inventory/batch').reserved_count, 0);
  assert.equal(f.rows.get('clinics/clinic').stock_total, 20);
});

test('clinic-wide notification works when no staff UID is stored on the booking', async () => {
  const f = fixture('pending');
  delete f.rows.get('appointments/a').clinic_staff_uid;
  delete f.rows.get('clinics/clinic').staff_uid;
  await f.cancel();
  assert.equal(f.notifications()[0].clinic_id, 'clinic');
  assert.equal(f.notifications()[0].audience, 'clinic_staff');
  assert.equal(f.notifications()[0].recipient_uid, 'clinic');
});

test('pending and confirmed reschedules notify staff and require confirmation again', async () => {
  for (const status of ['pending', 'confirmed']) {
    const f = fixture(status);
    await f.reschedule();
    const appointment = f.rows.get('appointments/a');
    assert.equal(appointment.status, 'pending');
    assert.equal(appointment.confirmed_at, null);
    assert.equal(appointment.arrival_deadline_ms, null);
    assert.equal(appointment.reschedule_requested, true);
    assert.equal(appointment.previous_preferred_time, '9:00 AM');
    assert.equal(appointment.preferred_time, '10:00 AM');
    assert.equal(f.rows.get('inventory/batch').reserved_count, 0);
    assert.equal(f.notifications().length, 1);
    assert.equal(f.notifications()[0].action, 'rescheduled');
    assert.match(f.notifications()[0].message, /9:00 AM.*10:00 AM.*confirmation is required again/);
    await assert.rejects(f.manage('arrive'), { code: 'failed-precondition' });
    await f.manage('confirm');
    assert.equal(f.rows.get('appointments/a').status, 'confirmed');
    assert.equal(f.rows.get('appointments/a').reschedule_requested, false);
    assert.equal(f.rows.get('inventory/batch').reserved_count, 1);
    assert.equal(f.rows.get('appointments/a').arrival_deadline_ms, Date.parse('2026-10-05T03:30:00Z'));
  }
});

test('retrying the same reschedule with equivalent time text creates no duplicate alert', async () => {
  const f = fixture();
  await f.reschedule();
  await f.reschedule('resident', '10:00');
  assert.equal(f.notifications().length, 1);
  assert.equal(f.rows.get('inventory/batch').reserved_count, 0);
});

test('failed notification writes roll back the appointment and inventory change', async () => {
  for (const action of ['cancel', 'reschedule']) {
    const f = fixture();
    f.failNotifications();
    await assert.rejects(f[action](), /Notification write failed/);
    assert.equal(f.rows.get('appointments/a').status, 'confirmed');
    assert.equal(f.rows.get('appointments/a').preferred_time, '9:00 AM');
    assert.equal(f.rows.get('inventory/batch').reserved_count, 1);
    assert.equal(f.notifications().length, 0);
  }
});

test('other residents and arrived or completed appointments cannot use these actions', async () => {
  for (const action of ['cancel', 'reschedule']) {
    const f = fixture();
    f.rows.set('users/other', { role: 'resident', is_active: true });
    await assert.rejects(f[action]('other'), { code: 'permission-denied' });
    for (const status of ['in_progress', 'completed', 'expired']) {
      const closed = fixture(status);
      await assert.rejects(closed[action](), { code: 'failed-precondition' });
      assert.equal(closed.notifications().length, 0);
    }
    f.rows.get('appointments/a').arrived_at = 'server-time';
    await assert.rejects(f[action](), { code: 'failed-precondition' });
    assert.equal(f.notifications().length, 0);
  }
});
