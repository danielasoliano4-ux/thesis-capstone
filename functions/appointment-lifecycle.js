'use strict';
const WINDOW_MS = 90 * 60 * 1000;
function scheduledTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return NaN;
  const day = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(+day) || day.toISOString().slice(0, 10) !== date) return NaN;
  const match = /^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i.exec(String(time || '').trim());
  if (!match) return NaN;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) return NaN;
  if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
  return Date.parse(date + 'T' + String(hour).padStart(2, '0') + ':' + match[2] + ':00+08:00');
}
function deadline(item) {
  return scheduledTime(item.preferred_date, item.preferred_time) + WINDOW_MS;
}
function isNoShow(item, now) {
  return item?.status === 'confirmed' && !item.arrived_at && deadline(item) <= +now;
}
function validateIntake(data, today, HttpsError) {
  const fields = ['bite_type', 'wound_washed', 'animal_type', 'bite_body_part', 'bite_date', 'patient_sex', 'patient_category'];
  const intake = {};
  for (const key of fields) {
    if (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > 160)
      throw new HttpsError('invalid-argument', 'Complete all medical intake fields.');
    intake[key] = data[key].trim();
  }
  if (!['Yes', 'No', 'Unknown'].includes(intake.wound_washed) ||
      !['Male', 'Female', 'Other', 'Prefer not to say'].includes(intake.patient_sex) ||
      !Number.isInteger(data.patient_age) || data.patient_age < 0 || data.patient_age > 130 ||
      !Number.isFinite(scheduledTime(intake.bite_date, '00:00')) || intake.bite_date > today)
    throw new HttpsError('invalid-argument', 'Check age, sex, wound washing and date of bite.');
  if (!['Bite', 'Scratch', 'Both bite and scratch', 'Lick on broken skin'].includes(intake.bite_type))
    throw new HttpsError('invalid-argument', 'Select a valid exposure type.');
  if (!['Category I', 'Category II', 'Category III'].includes(intake.patient_category))
    throw new HttpsError('invalid-argument', 'Select a valid category.');
  if (!['Dog', 'Cat', 'Other'].includes(intake.animal_type))
    throw new HttpsError('invalid-argument', 'Select Dog, Cat or Other.');
  if (intake.animal_type === 'Other') {
    const other = typeof data.animal_other === 'string' ? data.animal_other.trim() : '';
    if (!other || other.length > 160) throw new HttpsError('invalid-argument', 'Specify the other animal.');
    intake.animal_type = other;
  }
  return { ...intake, patient_age: data.patient_age };
}
function lifecycleHandler({ db, HttpsError, timestamp, now = () => new Date() }) {
  return async request => {
    const claims = request.auth?.token;
    if (!request.auth || claims.secure_login !== true || claims.email_verified !== true ||
        claims.firebase?.sign_in_provider !== 'custom') throw new HttpsError('unauthenticated', 'Please sign in again.');
    const { appointment_id: id, action } = request.data || {};
    if (typeof id !== 'string' || !id || id.includes('/') || !['confirm', 'arrive', 'intake'].includes(action))
      throw new HttpsError('invalid-argument', 'Choose a valid appointment and action.');
    const ref = db.collection('appointments').doc(id);
    return db.runTransaction(async tx => {
      const staff = (await tx.get(db.collection('users').doc(request.auth.uid))).data();
      const item = (await tx.get(ref)).data();
      if (!staff || staff.role !== 'clinic_staff' || staff.is_active !== true ||
          (staff.approval_status || 'approved') !== 'approved' ||
          (item && item.clinic_id !== (staff.clinic_id || request.auth.uid)))
        throw new HttpsError('permission-denied', 'Only active staff of this clinic can manage this appointment.');
      if (!item) throw new HttpsError('not-found', 'This appointment no longer exists.');
      const current = now();
      const start = scheduledTime(item.preferred_date, item.preferred_time);
      const end = start + WINDOW_MS;
      if (action === 'confirm') {
        if (item.status !== 'pending') throw new HttpsError('failed-precondition', 'Only pending appointments can be confirmed.');
        if (!Number.isFinite(end) || +current >= end) throw new HttpsError('failed-precondition', 'The arrival window has ended. Ask the resident to book again.');
        tx.update(ref, { status: 'confirmed', confirmed_at: timestamp(), reschedule_requested: false,
          scheduled_at_ms: start, arrival_deadline_ms: end });
        const notification = db.collection('notifications').doc();
        tx.set(notification, { recipient_uid: item.resident_uid, user_id: item.resident_uid,
          appointment_id: id, type: 'appointment', title: 'Appointment confirmed',
          message: 'Your appointment at ' + item.clinic_name + ' on ' + item.preferred_date + ' at ' + item.preferred_time + ' is confirmed. Please arrive on time.',
          read: false, created_at: timestamp() });
      } else if (action === 'arrive') {
        // Retries after a successful arrival are safe, including after the deadline.
        if (item.arrived_at && item.status === 'in_progress') return { id, status: 'in_progress' };
        const arrivalStart = scheduledTime(item.preferred_date, '00:00');
        if (item.status !== 'confirmed' || !Number.isFinite(end) || +current < arrivalStart || +current >= end)
          throw new HttpsError('failed-precondition', 'Arrival requires a confirmed appointment and can be recorded from the start of the appointment date until the deadline, 90 minutes after the scheduled time.');
        tx.update(ref, { status: 'in_progress', arrived_at: timestamp(), arrived_by: request.auth.uid });
      } else {
        if (item.status !== 'in_progress' || !item.arrived_at)
          throw new HttpsError('failed-precondition', 'Confirm the resident arrival first.');
        const recordRef = db.collection('patient_records').doc(id);
        const record = await tx.get(recordRef);
        if (record.exists) return { id, status: 'in_progress' };
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(current);
        const intake = validateIntake(request.data.intake || {}, today, HttpsError);
        // Read before any writes; the transaction keeps concurrent intake totals consistent.
        const records = await tx.get(db.collection('patient_records'));
        const animals = animalExposureSummary([...records.docs.map(doc => ({ id: doc.id, ...doc.data() })),
          { ...item, ...intake, id, vaccination_session_id: item.vaccination_session_id || 'legacy' }]);
        tx.set(db.collection('system_settings').doc('animal_exposure'), { animals, updated_at: timestamp() });
        tx.set(recordRef, { ...intake, appointment_id: id, resident_uid: item.resident_uid,
          resident_name: item.resident_name || '', clinic_id: item.clinic_id, clinic_name: item.clinic_name || '',
          vaccination_session_id: item.vaccination_session_id || 'legacy', preferred_date: item.preferred_date,
          preferred_time: item.preferred_time, arrived_at: item.arrived_at,
          recorded_by: request.auth.uid, recorded_at: timestamp() });
        tx.update(ref, { ...intake, course_intake_data: intake, intake_completed_at: timestamp(), patient_record_id: id });
      }
      return { id };
    });
  };
}
async function deleteNoShow(db, ref, now = () => new Date()) {
  return db.runTransaction(async tx => {
    const item = (await tx.get(ref)).data();
    // Re-read inside the transaction so cleanup can never delete a recorded arrival.
    if (!isNoShow(item, now())) return false;
    tx.delete(ref);
    return true;
  });
}
async function cleanupAppointments(db, now = () => new Date()) {
  let cursor, deleted = 0;
  do {
    let query = db.collection('appointments').where('status', '==', 'confirmed').orderBy('__name__').limit(200);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      if (isNoShow(doc.data(), now()) && await deleteNoShow(db, doc.ref, now)) deleted++;
    }
    cursor = page.size === 200 ? page.docs[page.docs.length - 1] : null;
  } while (cursor);
  return deleted;
}
function animalExposureSummary(records) {
  const cases = new Map();
  for (const record of records) {
    const animal = String(record.animal_type || '').trim().toLowerCase();
    if (!animal) continue;
    const key = record.vaccination_session_id && record.vaccination_session_id !== 'legacy'
      ? record.resident_uid + ':' + record.vaccination_session_id
      : record.resident_uid || record.appointment_id || record.id;
    if (!cases.has(key)) cases.set(key, animal === 'dog' ? 'Dog' : animal === 'cat' ? 'Cat' : 'Other');
  }
  return ['Dog', 'Cat', 'Other'].map(name => {
    const count = [...cases.values()].filter(animal => animal === name).length;
    return { name, count, percent: cases.size ? Math.round(count / cases.size * 100) : 0 };
  }).filter(animal => animal.count > 0).sort((a, b) => b.count - a.count);
}
module.exports = { animalExposureSummary, scheduledTime, deadline, isNoShow, validateIntake, lifecycleHandler, deleteNoShow, cleanupAppointments };
