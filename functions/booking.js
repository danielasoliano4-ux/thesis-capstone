const { loadTreatment } = require('./treatment');
const {checkSlotCapacity}=require('./booking-capacity');
'use strict';
const { bookingTimeError } = require('./clinic-hours');
const { scheduledTime, deadline, isPendingExpired } = require('./appointment-lifecycle');
const { createHash } = require('node:crypto');
function activeBooking(item, today, current = new Date()) {
  return (item.status === 'pending' && !isPendingExpired(item, current)) || item.status === 'in_progress' ||
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
    const lockId = createHash('sha256').update(JSON.stringify([uid])).digest('hex');
    const lock = db.collection('_booking_locks').doc(lockId);
    const appointment = db.collection('appointments').doc();
    return db.runTransaction(async tx => {
      const profile = (await tx.get(db.collection('users').doc(uid))).data();
      if (!profile || profile.role !== 'resident' || profile.is_active === false) throw new HttpsError('permission-denied', 'An active resident account is required.');
      const clinic = (await tx.get(db.collection('clinics').doc(data.clinic_id))).data();
      if (!clinic) throw new HttpsError('not-found', 'This clinic is no longer available.');
      const scheduleError = bookingTimeError(clinic, data.preferred_date, data.preferred_time, now());
      if (scheduleError) throw new HttpsError('invalid-argument', scheduleError);
      // All creates for this resident write the same lock, serializing
      // simultaneous requests even when the appointments query is empty.
      await tx.get(lock);
      const existing = await tx.get(db.collection('appointments')
        .where('resident_uid', '==', uid));
      const duplicate = existing.docs.find(item => activeBooking(item.data(), today, now()));
      if (duplicate) throw new HttpsError('already-exists', 'You already have a pending or accepted appointment for this treatment. Cancel it before changing clinics.', { appointmentId: duplicate.id, status: duplicate.data().status });
      const slotLock = await checkSlotCapacity(tx, db, data.clinic_id, data.preferred_date, data.preferred_time, null, HttpsError);

      const prior=existing.docs.map(item=>item.data());
      const history=await tx.get(db.collection('vaccination_records').where('resident_uid','==',uid));
      const latest=history.docs.map(item=>item.data()).sort((a,b)=>String(b.date_given).localeCompare(String(a.date_given)))[0];
      const last=prior.sort((a,b)=>(b.created_at?.toMillis?.()||0)-(a.created_at?.toMillis?.()||0))[0];
      const session=last?.vaccination_session_id||latest?.vaccination_session_id||'legacy';
      const {ref:treatmentRef,records,treatment}=await loadTreatment(tx,db,uid,session);
      const next=treatment.doses.find(d=>!d.actual_administration_date);
      if(!next) throw new HttpsError('failed-precondition','Treatment is complete. A new exposure requires clinic review.');
      next.appointment_date=data.preferred_date; next.appointment_id=appointment.id;
      const payload={preferred_date:data.preferred_date,preferred_time:data.preferred_time,vaccination_session_id:session,treatment_id:treatmentRef.id,dose_number:next.dose_number,dose_label:'Dose '+next.dose_number,recommended_date:next.recommended_date,course_vaccination_history:records};
      tx.set(treatmentRef,{...treatment,updated_at:timestamp()});
      tx.set(appointment, { ...payload, scheduled_at_ms: scheduled, resident_uid: uid, resident_name: profile.full_name || '', resident_email: claims.email || profile.email || '', clinic_id: data.clinic_id, clinic_name: clinic.name || '', clinic_address: clinic.address || '', clinic_staff_uid: clinic.staff_uid || '', status: 'pending', created_at: timestamp() });
      tx.set(slotLock, { updated_at: timestamp() });
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
      const slotLock = await checkSlotCapacity(tx, db, item.clinic_id, data.preferred_date, data.preferred_time, ref.id, HttpsError);
      const course=await loadTreatment(tx,db,item.resident_uid,item.vaccination_session_id||'legacy');
      const dose=course.treatment.doses.find(d=>d.dose_number===Number(item.dose_number||String(item.dose_label||'1').match(/\d+/)?.[0]));
      if(dose&&!dose.actual_administration_date){dose.appointment_date=data.preferred_date;tx.set(course.ref,{...course.treatment,updated_at:timestamp()});}
      tx.set(slotLock, { updated_at: timestamp() });
      tx.update(ref, { preferred_date: data.preferred_date, preferred_time: data.preferred_time,
        scheduled_at_ms: scheduledTime(data.preferred_date, data.preferred_time),
        arrival_deadline_ms: null, confirmed_at: null, status: 'pending',
        reschedule_requested: true, rescheduled_at: timestamp() });
      return { id: ref.id };
    });
  };
}

module.exports = { createBookingHandler, rescheduleBookingHandler, activeBooking };
