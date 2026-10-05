'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSchedulePushHandler } = require('./schedule-push');

test('schedule notifications are pushed to resident devices and invalid tokens are removed', async () => {
  const deleted = [];
  const sent = [];
  const tokens = [
    { id: 'one', ref: { id: 'one' }, data: () => ({ token: 'valid' }) },
    { id: 'two', ref: { id: 'two' }, data: () => ({ token: 'expired' }) }
  ];
  const db = {
    collection: name => ({
      where: (field, operator, value) => ({
        get: async () => ({
          empty: false,
          docs: name === 'resident_push_tokens' && field === 'resident_uid' && value === 'resident' ? tokens : []
        })
      })
    }),
    batch: () => ({ delete: ref => deleted.push(ref.id), commit: async () => {} })
  };
  const messaging = {
    sendEachForMulticast: async message => {
      sent.push(message);
      return {
        responses: [
          { success: true },
          { success: false, error: { code: 'messaging/registration-token-not-registered' } }
        ]
      };
    }
  };
  const handler = createSchedulePushHandler({ db, messaging, logger: { info() {}, error() {} } });
  await handler({
    params: { notificationId: 'notice' },
    data: { data: () => ({ push: true, recipient_uid: 'resident', title: 'Clinic recommended vaccination dates', message: 'Dose 1: 2026-09-24', action: 'review_schedule' }) }
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].tokens, ['valid', 'expired']);
  assert.equal(sent[0].webpush.fcmOptions.link, '/residents.html');
  assert.deepEqual(deleted, ['two']);
});

test('non-push and malformed push notifications do not send an FCM message', async () => {
  let sends = 0;
  const handler = createSchedulePushHandler({
    db: { collection: () => { throw new Error('should not query tokens'); } },
    messaging: { sendEachForMulticast: async () => { sends++; } },
    logger: { info() {}, error() {} }
  });
  await handler({ data: { data: () => ({ push: false }) } });
  await handler({ data: { data: () => ({ push: 'true', recipient_uid: 'resident' }) } });
  assert.equal(sends, 0);
});
