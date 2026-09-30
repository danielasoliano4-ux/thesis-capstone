'use strict';
const { bookingTimeError } = require('./clinic-hours');
const { scheduledTime, deadline } = require('./appointment-lifecycle');
const { createHash } = require('node:crypto');
function activeBooking(item, today, current = new Date()) {
  return item.status === 'pending' || item.status === 'in_progress' ||
    (['confirmed', 'accepted', 'approved'].includes(item.status) &&
      (Number.isFinite(deadline(item)) ? deadline(item) > +current : (!item.reservation_end_date || item.reservation_end_date >= today)));
}
function createBookingHandler({ db, HttpsError, timestamp, now = () => new Date() }) {
  return async request => {
    const claims = request.auth?.token;
    if (!request.auth || claims.secure_login !== true || claims.email_verified !== true || claims.firebase?.sign_in_provider !== 'custom') {
      throw new HttpsError('unauthenticated', 'Please sign in again.');
    }
    const uid = request.auth.uid;
    const data = request.data || {};
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
    if (typeof data.clinic_id !== 'string' || !data.clinic_id || data.clinic_id.includes('/') ||
        !/^\d{4}-\d{2}-\d{2}$/.test(data.preferred_date || '') || data.preferred_date < today ||
        typeof data.preferred_time !== 'string' || !data.preferred_time ||
        (data.bite_date && data.bite_date > today)) {
      throw new HttpsError('invalid-argument', 'Choose a valid clinic, appointment date and time. The bite date cannot be in the future.');
    }
    const scheduled = scheduledTime(data.preferred_date, data.preferred_time);
    if (!Number.isFinite(scheduled) || scheduled <= +now()) throw new HttpsError('invalid-argument', 'Choose a future appointment date and valid time.');
    const lockId = createHash('sha256').update(JSON.stringify([uid, data.clinic_id])).digest('hex');
    const lock = db.collection('_booking_locks').doc(lockId);
    const appointment = db.collection('appointments').doc();
    return db.runTransaction(async tx => {
      const profile = (await tx.get(db.collection('users').doc(uid))).data();
      if (!profile || profile.role !== 'resident' || profile.is_active === false) throw new HttpsError('permission-denied', 'An active resident account is required.');
      const clinic = (await tx.get(db.collection('clinics').doc(data.clinic_id))).data();
      if (!clinic) throw new HttpsError('not-found', 'This clinic is no longer available.');
      const scheduleError = bookingTimeError(clinic, data.preferred_date, data.preferred_time, now());
      if (scheduleError) throw new HttpsError('invalid-argument', scheduleError);
      // All creates for this resident/clinic write the same lock, serializing
      // simultaneous requests even when the appointments query is empty.
      await tx.get(lock);
      const existing = await tx.get(db.collection('appointments')
        .where('resident_uid', '==', uid).where('clinic_id', '==', data.clinic_id));
      const duplicate = existing.docs.find(item => activeBooking(item.data(), today, now()));
      if (duplicate) throw new HttpsError('already-exists', 'You already have a pending or accepted appointment at this clinic.', { appointmentId: duplicate.id, status: duplicate.data().status });
      // Residents supply only scheduling and existing course context. Intake is staff-only.
      const fields = ['vaccination_session_id', 'primary_clinic_id', 'primary_clinic_name', 'clinic_changed_for_dose', 'dose_label', 'vaccine_name', 'preferred_date', 'preferred_time'];
      const payload = Object.fromEntries(fields.filter(key => data[key] !== undefined).map(key => [key, data[key]]));
      tx.set(appointment, { ...payload, scheduled_at_ms: scheduled, resident_uid: uid, resident_name: profile.full_name || '', resident_email: claims.email || profile.email || '', clinic_id: data.clinic_id, clinic_name: clinic.name || '', clinic_address: clinic.address || '', clinic_staff_uid: clinic.staff_uid || '', status: 'pending', created_at: timestamp() });
      tx.set(lock, { appointment_id: appointment.id, updated_at: timestamp() });
      return { id: appointment.id };
    });
  };
}

function rescheduleBookingHandler({ db, HttpsError, timestamp, now = () => new Date() }) {
  return async request => {
    const claims = request.auth?.token;
    if (!request.auth || claims.secure_login !== true || claims.email_verified !== true || claims.firebase?.sign_in_provider !== 'custom')
      throw new HttpsError('unauthenticated', 'Please sign in again.');
    const data = request.data || {};
    if (typeof data.appointment_id !== 'string' || !data.appointment_id || data.appointment_id.includes('/'))
      throw new HttpsError('invalid-argument', 'Choose a valid appointment.');
    const ref = db.collection('appointments').doc(data.appointment_id);
    return db.runTransaction(async tx => {
      const profile = (await tx.get(db.collection('users').doc(request.auth.uid))).data();
      const item = (await tx.get(ref)).data();
      if (!profile || profile.role !== 'resident' || profile.is_active === false || item?.resident_uid !== request.auth.uid)
        throw new HttpsError('permission-denied', 'Only the resident who booked this appointment can reschedule it.');
      if (item.status !== 'confirmed' || deadline(item) <= +now())
        throw new HttpsError('failed-precondition', 'Only active confirmed appointments can be rescheduled.');
      const clinic = (await tx.get(db.collection('clinics').doc(item.clinic_id))).data();
      if (!clinic) throw new HttpsError('not-found', 'This clinic is no longer available.');
      const error = bookingTimeError(clinic, data.preferred_date, data.preferred_time, now());
      if (error) throw new HttpsError('invalid-argument', error);
      const nextDate = new Date(Date.parse(item.preferred_date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
      if (data.preferred_date < item.preferred_date || data.preferred_date > nextDate)
        throw new HttpsError('invalid-argument', 'Choose the original appointment date or the following day.');
      tx.update(ref, { preferred_date: data.preferred_date, preferred_time: data.preferred_time,
        scheduled_at_ms: scheduledTime(data.preferred_date, data.preferred_time),
        arrival_deadline_ms: null, confirmed_at: null, status: 'pending',
        reschedule_requested: true, rescheduled_at: timestamp() });
      return { id: ref.id };
    });
  };
}

module.exports = { createBookingHandler, rescheduleBookingHandler, activeBooking };
