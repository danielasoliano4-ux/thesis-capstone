'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dueReminders, createReminderHandler } = require('./appointment-reminders');
const appointment = { status: 'confirmed', preferred_date: '2026-10-04', preferred_time: '10:30 AM', resident_uid: 'resident', resident_email: 'resident@example.com' };

test('Manila reminder windows include only the target minute for both offsets', () => {
  for (const [key, date] of [['one_day', '2026-10-03T02:30:00Z'], ['two_hour', '2026-10-04T00:30:00Z']]) {
    const due = Date.parse(date);
    assert.deepEqual(dueReminders(appointment, due - 1), []);
    assert.equal(dueReminders(appointment, due)[0].key, key);
    assert.equal(dueReminders(appointment, due + 59999)[0].key, key);
    assert.deepEqual(dueReminders(appointment, due + 60000), []);
  }
});

test('invalid, cancelled, pending and arrived appointments do not receive reminders', () => {
  const now = Date.parse('2026-10-04T00:30:00Z');
  for (const change of [{ status: 'cancelled' }, { status: 'pending' }, { arrived_at: 1 }, { preferred_time: 'invalid' }, { preferred_date: '2026-02-30' }])
    assert.deepEqual(dueReminders({ ...appointment, ...change }, now), []);
});

function fixture(item = appointment) {
  let data = { ...item };
  const notifications = new Map();
  const ref = { get: async () => ({ data: () => ({ ...data }) }), update: async change => { data = { ...data, ...change }; } };
  const doc = { id: 'a', ref, data: () => ({ ...data }) };
  const db = {
    collection: name => name === 'appointments' ? { where: () => ({ get: async () => ({ docs: [doc] }) }) } : { doc: id => ({ id }) },
    runTransaction: async fn => fn({ get: r => r.get(), set: (r, value) => notifications.set(r.id, value), update: (r, value) => r.update(value) })
  };
  return { db, notifications, change: change => { data = { ...data, ...change }; } };
}

test('both channels deliver once per offset, and rescheduled appointments get fresh reminders', async () => {
  const f = fixture();
  let emails = 0;
  const handler = createReminderHandler({ db: f.db, timestamp: () => 1, sendEmail: async () => { emails++; } });
  for (const scheduleTime of ['2026-10-03T02:30:00Z', '2026-10-04T00:30:00Z']) {
    await handler({ scheduleTime });
    await handler({ scheduleTime });
  }
  assert.equal(emails, 2);
  assert.equal(f.notifications.size, 2);
  assert.equal([...f.notifications.values()][0].recipient_uid, 'resident');
  assert.equal([...f.notifications.values()][0].read, false);
  f.change({ preferred_date: '2026-10-05' });
  await handler({ scheduleTime: '2026-10-05T00:30:00Z' });
  assert.equal(emails, 3);
  assert.equal(f.notifications.size, 3);
});

test('missing email still produces an in-app reminder', async () => {
  const f = fixture({ ...appointment, resident_email: '' });
  await createReminderHandler({ db: f.db, timestamp: () => 1, sendEmail: async () => assert.fail('Unexpected email') })({ scheduleTime: '2026-10-04T00:30:00Z' });
  assert.equal(f.notifications.size, 1);
});

test('email failure preserves in-app delivery and retries without duplicating the alert', async () => {
  const f = fixture();
  let fail = true;
  const handler = createReminderHandler({ db: f.db, timestamp: () => 1, sendEmail: async () => { if (fail) throw Error('Provider unavailable'); } });
  const event = { scheduleTime: '2026-10-04T00:30:00Z' };
  await assert.rejects(handler(event), AggregateError);
  assert.equal(f.notifications.size, 1);
  fail = false;
  await handler(event);
  assert.equal(f.notifications.size, 1);
});
