'use strict';

const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered'
]);

function createSchedulePushHandler({ db, messaging, logger }) {
  return async event => {
    const notification = event.data?.data();
    if (notification?.push !== true || typeof notification.recipient_uid !== 'string') return;

    const tokenSnapshot = await db.collection('resident_push_tokens')
      .where('resident_uid', '==', notification.recipient_uid)
      .get();
    if (tokenSnapshot.empty) {
      logger.info('No push-enabled devices for schedule notification', { notificationId: event.params.notificationId });
      return;
    }

    const tokens = tokenSnapshot.docs;
    for (let offset = 0; offset < tokens.length; offset += 500) {
      const batch = tokens.slice(offset, offset + 500);
      const response = await messaging.sendEachForMulticast({
        tokens: batch.map(item => item.data().token),
        notification: {
          title: notification.title,
          body: notification.message
        },
        data: {
          action: notification.action || '',
          url: '/residents.html'
        },
        webpush: {
          fcmOptions: { link: '/residents.html' }
        }
      });

      const invalid = [];
      const failed = [];
      response.responses.forEach((result, index) => {
        if (result.success) return;
        if (INVALID_TOKEN_CODES.has(result.error?.code)) invalid.push(batch[index].ref);
        else failed.push(result.error);
      });

      if (invalid.length) {
        const cleanup = db.batch();
        invalid.forEach(ref => cleanup.delete(ref));
        await cleanup.commit();
      }
      if (failed.length) {
        logger.error('Some vaccination schedule push alerts failed', {
          notificationId: event.params.notificationId,
          errors: failed.map(error => error?.message || String(error))
        });
        throw new Error('Unable to deliver all vaccination schedule push alerts.');
      }
    }
  };
}

module.exports = { createSchedulePushHandler };
