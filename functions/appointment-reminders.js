'use strict';

const { scheduledTime } = require('./appointment-lifecycle');
const MINUTE_MS = 60 * 1000;
const REMINDERS = [
  { key: 'one_day', hours: 24, label: '24 hours' },
  { key: 'two_hour', hours: 2, label: '2 hours' }
];

function dueReminders(appointment, current) {
  if (appointment.status !== 'confirmed' || appointment.arrived_at) return [];
  const start = scheduledTime(appointment.preferred_date, appointment.preferred_time);
  // Appointment slots have minute precision. Use a half-open rolling window
  // so the target minute is included exactly once and nothing sends early.
  const windowStart = Math.floor(+current / MINUTE_MS) * MINUTE_MS;
  return REMINDERS.filter(reminder => {
    const due = start - reminder.hours * 60 * MINUTE_MS;
    return due >= windowStart && due < windowStart + MINUTE_MS;
  }).map(reminder => ({ ...reminder, start }));
}

function createReminderHandler({ db, timestamp, sendEmail, now = () => new Date() }) {
  return async (event = {}) => {
    // Keep the original window on scheduler retries, even after its minute ends.
    const current = event.scheduleTime ? new Date(event.scheduleTime) : now();
    const snapshot = await db.collection('appointments').where('status', '==', 'confirmed').get();
    const errors = [];
    for (const doc of snapshot.docs) {
      for (const reminder of dueReminders(doc.data(), current)) {
        try {
          // Re-read status and time to avoid using an already changed booking.
          const appointment = (await doc.ref.get()).data();
          if (!appointment || !dueReminders(appointment, current).some(r => r.key === reminder.key && r.start === reminder.start)) continue;
          const field = 'reminder_' + reminder.key;
          const message = 'Your anti-rabies vaccination appointment at ' + (appointment.clinic_name || 'the clinic') +
            ' on ' + appointment.preferred_date + ' at ' + appointment.preferred_time +
            ' is in ' + reminder.label + '. Please bring your vaccination card and arrive on time.';

          // In-app delivery is independent of whether an email address exists
          // or the email provider is available. A stable ID prevents duplicates.
          if (appointment.resident_uid) {
            await db.runTransaction(async tx => {
              const fresh = (await tx.get(doc.ref)).data();
              if (!fresh || fresh.resident_uid !== appointment.resident_uid ||
                  !dueReminders(fresh, current).some(r => r.key === reminder.key && r.start === reminder.start) ||
                  fresh[field + '_in_app_for'] === reminder.start) return;
              tx.set(db.collection('notifications').doc('appointment-reminder-' + doc.id + '-' + reminder.key + '-' + reminder.start), {
                recipient_uid: appointment.resident_uid, user_id: appointment.resident_uid,
                appointment_id: doc.id, type: 'appointment', title: 'Appointment reminder: ' + reminder.label,
                message, read: false, created_at: timestamp()
              });
              tx.update(doc.ref, { [field + '_in_app_for']: reminder.start, [field + '_in_app_sent_at']: timestamp() });
            });
          }
          if (appointment.resident_email && appointment[field + '_email_for'] !== reminder.start) {
            await sendEmail(appointment, reminder, message);
            await doc.ref.update({ [field + '_email_for']: reminder.start, [field + '_email_sent_at']: timestamp() });
          }
        } catch (error) {
          // One failed recipient must not prevent other reminders from sending.
          errors.push(error);
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Appointment reminder delivery failed');
  };
}

module.exports = { dueReminders, createReminderHandler };
