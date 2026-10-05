const { requireBookingStock, releaseReservation } = require('./stock-reservations');
const { loadTreatment } = require('./treatment');
const {checkSlotCapacity,checkBatchSlotCapacity}=require('./booking-capacity');
'use strict';
const { bookingTimeError } = require('./clinic-hours');
const { scheduledTime, deadline, isPendingExpired } = require('./appointment-lifecycle');
const { createHash } = require('node:crypto');
function activeBooking(item, today, current = new Date()) {
  return (item.status === 'pending' && !isPendingExpired(item, current)) || item.status === 'in_progress' ||
    (['confirmed', 'accepted', 'approved'].includes(item.status) &&
      (Number.isFinite(deadline(item)) ? deadline(item) > +current : (!item.reservation_end_date || item.reservation_end_date >= today)));
}
function notifyClinicAppointment(tx, db, appointmentId, item, profile, change, timestamp) {
  const rescheduled = change.action === 'rescheduled';
  const residentName = profile.full_name || item.resident_name || 'A resident';
  const dose = item.dose_label || `Dose ${item.dose_number || 1}`;
  const recipient = item.clinic_staff_uid || item.clinic_id;
  const date = change.preferred_date || item.preferred_date || '';
  const time = change.preferred_time || item.preferred_time || '';
  const message = rescheduled
    ? `${residentName} requested to reschedule ${dose} from ${item.preferred_date} at ${item.preferred_time} to ${date} at ${time}. Clinic confirmation is required again.`
    : `${residentName} cancelled ${dose} on ${date} at ${time}. Reason: ${change.reason}`;
  tx.set(db.collection('notifications').doc(), {
    recipient_uid: recipient, user_id: recipient, clinic_id: item.clinic_id,
    appointment_id: appointmentId, resident_uid: item.resident_uid,
    audience: 'clinic_staff', type: 'appointment', action: change.action,
    title: rescheduled ? 'Appointment reschedule requested' : 'Appointment cancelled',
    message, preferred_date: date, preferred_time: time,
    previous_date: item.preferred_date || '', previous_time: item.preferred_time || '',
    read: false, created_at: timestamp()
  });
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
      await requireBookingStock(tx, db, data.clinic_id, HttpsError, now());
      const scheduleError = bookingTimeError(clinic, data.preferred_date, data.preferred_time, now());
      if (scheduleError) throw new HttpsError('invalid-argument', scheduleError);
      // All creates for this resident write the same lock, serializing
      // simultaneous requests even when the appointments query is empty.
      const lockState=(await tx.get(lock)).data();
      const existing = await tx.get(db.collection('appointments')
        .where('resident_uid', '==', uid));
      const duplicate = existing.docs.find(item => activeBooking(item.data(), today, now()));
      if (duplicate) throw new HttpsError('already-exists', 'You already have a pending or accepted appointment for this treatment. Cancel it before changing clinics.', { appointmentId: duplicate.id, status: duplicate.data().status });
      const slotLock = await checkSlotCapacity(tx, db, data.clinic_id, data.preferred_date, data.preferred_time, null, HttpsError);

      const prior=existing.docs.map(item=>item.data());
      const history=await tx.get(db.collection('vaccination_records').where('resident_uid','==',uid));
      const latest=history.docs.map(item=>item.data()).sort((a,b)=>String(b.date_given).localeCompare(String(a.date_given)))[0];
      const last=existing.docs.find(item=>item.id===lockState?.appointment_id)?.data()
        || prior.sort((a,b)=>(b.created_at?.toMillis?.()||0)-(a.created_at?.toMillis?.()||0))[0];
      let session=last?.vaccination_session_id||latest?.vaccination_session_id||'legacy';
      let course=await loadTreatment(tx,db,uid,session);
      if(course.treatment.doses.every(d=>d.actual_administration_date)) {
        // A new appointment starts its own course; completed history stays intact.
        session=appointment.id;
        course=await loadTreatment(tx,db,uid,session);
      }
      const {ref:treatmentRef,records,treatment}=course;
      const next=treatment.doses.find(d=>!d.actual_administration_date);
      next.appointment_date=data.preferred_date; next.appointment_id=appointment.id;
      const payload={preferred_date:data.preferred_date,preferred_time:data.preferred_time,vaccination_session_id:session,treatment_id:treatmentRef.id,dose_number:next.dose_number,dose_label:'Dose '+next.dose_number,recommended_date:next.recommended_date,course_vaccination_history:records.filter(record=>record.clinic_id===data.clinic_id)};
      tx.set(treatmentRef,{...treatment,updated_at:timestamp()});
      tx.set(appointment, { ...payload, scheduled_at_ms: scheduled, resident_uid: uid, resident_name: profile.full_name || '', resident_email: claims.email || profile.email || '', clinic_id: data.clinic_id, clinic_name: clinic.name || '', clinic_address: clinic.address || '', clinic_staff_uid: clinic.staff_uid || '', status: 'pending', created_at: timestamp() });
      tx.set(slotLock, { updated_at: timestamp() });
      tx.set(lock, { appointment_id: appointment.id, updated_at: timestamp() });
      return { id: appointment.id, vaccination_session_id: session };
    });
  };
}

function createBatchBookingHandler({ db, HttpsError, timestamp, now = () => new Date() }) {
  return async request => {
    const claims = request.auth?.token;
    if (!request.auth || claims.secure_login !== true || claims.email_verified !== true || claims.firebase?.sign_in_provider !== 'custom')
      throw new HttpsError('unauthenticated', 'Please sign in again.');

    const uid = request.auth.uid;
    const data = request.data || {};
    if (typeof data.clinic_id !== 'string' || !data.clinic_id || data.clinic_id.includes('/')
      || !Array.isArray(data.appointments) || !data.appointments.length || data.appointments.length > 5
      || typeof data.vaccination_session_id !== 'string' || !data.vaccination_session_id) {
      throw new HttpsError('invalid-argument', 'Choose a clinic and the recommended dose dates to book.');
    }

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
    const submittedDoses = new Set();
    for (const appointment of data.appointments) {
      if (!Number.isInteger(appointment?.dose_number) || appointment.dose_number < 1 || appointment.dose_number > 5
        || submittedDoses.has(appointment.dose_number) || !/^\d{4}-\d{2}-\d{2}$/.test(appointment.preferred_date || '')
        || !Number.isFinite(Date.parse(`${appointment.preferred_date}T00:00:00Z`))
        || new Date(`${appointment.preferred_date}T00:00:00Z`).toISOString().slice(0, 10) !== appointment.preferred_date
        || typeof appointment.preferred_time !== 'string' || !appointment.preferred_time) {
        throw new HttpsError('invalid-argument', 'Enter one valid date and time for each recommended dose.');
      }
      submittedDoses.add(appointment.dose_number);
    }

    const lockId = createHash('sha256').update(JSON.stringify([uid])).digest('hex');
    const residentLock = db.collection('_booking_locks').doc(lockId);
    return db.runTransaction(async tx => {
      const profile = (await tx.get(db.collection('users').doc(uid))).data();
      if (!profile || profile.role !== 'resident' || profile.is_active === false)
        throw new HttpsError('permission-denied', 'An active resident account is required.');
      const clinic = (await tx.get(db.collection('clinics').doc(data.clinic_id))).data();
      if (!clinic) throw new HttpsError('not-found', 'This clinic is no longer available.');
      await requireBookingStock(tx, db, data.clinic_id, HttpsError, now());

      await tx.get(residentLock);
      const existing = await tx.get(db.collection('appointments').where('resident_uid', '==', uid));
      const prior = existing.docs.map(item => ({ id: item.id, ...item.data() }));
      const history = await tx.get(db.collection('vaccination_records').where('resident_uid', '==', uid));
      const latest = history.docs.map(item => item.data()).sort((a, b) => String(b.date_given).localeCompare(String(a.date_given)))[0];
      const last = [...prior].sort((a, b) => (b.created_at?.toMillis?.() || 0) - (a.created_at?.toMillis?.() || 0))[0];
      const session = last?.vaccination_session_id || latest?.vaccination_session_id || 'legacy';
      if (session !== data.vaccination_session_id)
        throw new HttpsError('failed-precondition', 'Your vaccination course changed. Refresh the page and review the latest schedule.');

      const course = await loadTreatment(tx, db, uid, session);
      const active = prior.filter(item => activeBooking(item, today, now()));
      if (active.some(item => (item.vaccination_session_id || 'legacy') !== session))
        throw new HttpsError('already-exists', 'Finish or cancel appointments from your other vaccination course before booking this schedule.');

      const activeByDose = new Map();
      active.filter(item => (item.vaccination_session_id || 'legacy') === session).forEach(item => {
        const doseNumber = Number(item.dose_number || String(item.dose_label || '').match(/\d+/)?.[0] || 0);
        if (doseNumber) {
          const matching = activeByDose.get(doseNumber) || [];
          matching.push(item);
          activeByDose.set(doseNumber, matching);
        }
      });
      const incomplete = course.treatment.doses.filter(dose => !dose.actual_administration_date);
      const required = incomplete.filter(dose => !(activeByDose.get(dose.dose_number) || []).some(item => item.status === 'in_progress'));
      if (!required.length || required.length !== data.appointments.length
        || required.some(dose => !submittedDoses.has(dose.dose_number))) {
        throw new HttpsError('failed-precondition', 'The pending doses changed. Refresh the page and review your schedule.');
      }

      const submitted = new Map(data.appointments.map(appointment => [appointment.dose_number, appointment]));
      let previousDate = '';
      const planned = required.map(dose => {
        const choice = submitted.get(dose.dose_number);
        const minimumDate = dose.recommended_date && dose.recommended_date > today ? dose.recommended_date : today;
        if (!dose.recommended_date || choice.preferred_date < minimumDate || choice.preferred_date < previousDate)
          throw new HttpsError('failed-precondition', `Dose ${dose.dose_number} must be booked on or after its clinic-recommended date and in dose order.`);
        previousDate = choice.preferred_date;

        const scheduled = scheduledTime(choice.preferred_date, choice.preferred_time);
        if (!Number.isFinite(scheduled) || scheduled <= +now())
          throw new HttpsError('invalid-argument', `Choose a future time for Dose ${dose.dose_number}.`);
        const scheduleError = bookingTimeError(clinic, choice.preferred_date, choice.preferred_time, now());
        if (scheduleError) throw new HttpsError('invalid-argument', `Dose ${dose.dose_number}: ${scheduleError}`);

        const matches = activeByDose.get(dose.dose_number) || [];
        if (matches.length > 1 || matches.some(item => item.status === 'in_progress'))
          throw new HttpsError('already-exists', `Dose ${dose.dose_number} already has an appointment in progress or duplicate bookings.`);
        const current = matches[0] || null;
        return { dose, choice, scheduled, current };
      });

      const uniqueSlots = new Set(planned.map(item => item.scheduled));
      if (uniqueSlots.size !== planned.length)
        throw new HttpsError('invalid-argument', 'Choose a different appointment time for each dose.');

      const movingAppointments = planned.filter(item => item.current && (
        item.current.clinic_id !== data.clinic_id
        || scheduledTime(item.current.preferred_date, item.current.preferred_time) !== item.scheduled
      )).map(item => item.current.id);
      const slotLocks = await checkBatchSlotCapacity(tx, db, data.clinic_id, planned.map(item => ({
        scheduled: item.scheduled
      })), movingAppointments, HttpsError);

      const updates = [];
      for (let index = 0; index < planned.length; index++) {
        const item = planned[index];
        const appointmentRef = item.current
          ? db.collection('appointments').doc(item.current.id)
          : db.collection('appointments').doc();
        const changed = item.current && (
          item.current.clinic_id !== data.clinic_id
          || scheduledTime(item.current.preferred_date, item.current.preferred_time) !== item.scheduled
        );
        if (changed && ['confirmed', 'accepted', 'approved'].includes(item.current.status))
          throw new HttpsError('failed-precondition', `Dose ${item.dose.dose_number} is already confirmed. Reschedule that appointment before submitting this batch.`);
        const payload = {
          preferred_date: item.choice.preferred_date,
          preferred_time: item.choice.preferred_time,
          scheduled_at_ms: item.scheduled,
          vaccination_session_id: session,
          treatment_id: course.ref.id,
          dose_number: item.dose.dose_number,
          dose_label: `Dose ${item.dose.dose_number}`,
          recommended_date: item.dose.recommended_date,
          course_vaccination_history: course.records.filter(record => record.clinic_id === data.clinic_id),
          resident_uid: uid,
          resident_name: profile.full_name || '',
          resident_email: claims.email || profile.email || '',
          clinic_id: data.clinic_id,
          clinic_name: clinic.name || '',
          clinic_address: clinic.address || '',
          clinic_staff_uid: clinic.staff_uid || ''
        };
        if (item.current) {
          tx.update(appointmentRef, {
            ...payload,
            ...(changed ? { status: 'pending', confirmed_at: null, arrival_deadline_ms: null, reschedule_requested: true, rescheduled_at: timestamp() } : {})
          });
          if (changed) {
            const change = { action: 'rescheduled', preferred_date: payload.preferred_date, preferred_time: payload.preferred_time };
            notifyClinicAppointment(tx, db, appointmentRef.id, { ...item.current, ...payload, preferred_date: item.current.preferred_date, preferred_time: item.current.preferred_time }, profile, change, timestamp);
            if (item.current.clinic_id !== payload.clinic_id)
              notifyClinicAppointment(tx, db, appointmentRef.id, item.current, profile, { action: 'cancelled', reason: `The resident moved this appointment to ${clinic.name || 'another clinic'}.` }, timestamp);
          }
        } else {
          tx.set(appointmentRef, { ...payload, status: 'pending', created_at: timestamp() });
        }
        tx.set(slotLocks[index], { updated_at: timestamp() });
        updates.push({ dose_number: item.dose.dose_number, appointment_id: appointmentRef.id, date: item.choice.preferred_date });
        item.dose.appointment_date = item.choice.preferred_date;
        item.dose.appointment_id = appointmentRef.id;
      }
      tx.set(course.ref, { ...course.treatment, doses: course.treatment.doses, updated_at: timestamp() });
      return { appointments: updates };
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
      if (!['pending', 'confirmed'].includes(item.status) || item.arrived_at
        || (item.status === 'pending' ? isPendingExpired(item, now()) : deadline(item) <= +now()))
        throw new HttpsError('failed-precondition', 'Only active pending or confirmed appointments can be rescheduled.');
      const scheduled = scheduledTime(data.preferred_date, data.preferred_time);
      if (Number.isFinite(scheduled) && scheduled === scheduledTime(item.preferred_date, item.preferred_time)) {
        if (item.status === 'pending' && item.reschedule_requested) return { id: ref.id, status: 'pending' };
        throw new HttpsError('invalid-argument', 'Choose a different appointment date or time.');
      }
      const clinic = (await tx.get(db.collection('clinics').doc(item.clinic_id))).data();
      if (!clinic) throw new HttpsError('not-found', 'This clinic is no longer available.');
      await requireBookingStock(tx, db, item.clinic_id, HttpsError, now());
      const error = bookingTimeError(clinic, data.preferred_date, data.preferred_time, now());
      if (error) throw new HttpsError('invalid-argument', error);
      const nextDate = new Date(Date.parse(item.preferred_date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
      if (data.preferred_date < item.preferred_date || data.preferred_date > nextDate)
        throw new HttpsError('invalid-argument', 'Choose the original appointment date or the following day.');
      const slotLock = await checkSlotCapacity(tx, db, item.clinic_id, data.preferred_date, data.preferred_time, ref.id, HttpsError);
      const course=await loadTreatment(tx,db,item.resident_uid,item.vaccination_session_id||'legacy');
      const dose=course.treatment.doses.find(d=>d.dose_number===Number(item.dose_number||String(item.dose_label||'1').match(/\d+/)?.[0]));
      const release = await releaseReservation(tx, db, item, timestamp, now());
      if (release) release();
      if(dose&&!dose.actual_administration_date){dose.appointment_date=data.preferred_date;tx.set(course.ref,{...course.treatment,updated_at:timestamp()});}
      tx.set(slotLock, { updated_at: timestamp() });
      tx.update(ref, { preferred_date: data.preferred_date, preferred_time: data.preferred_time,
        scheduled_at_ms: scheduled,
        arrival_deadline_ms: null, confirmed_at: null, status: 'pending',
        ...(release ? {stock_reservation:{...item.stock_reservation,status:'released',released_at:timestamp()}} : {}),
        previous_preferred_date: item.preferred_date, previous_preferred_time: item.preferred_time,
        reschedule_requested: true, rescheduled_at: timestamp() });
      notifyClinicAppointment(tx, db, ref.id, { ...item, clinic_staff_uid: item.clinic_staff_uid || clinic.staff_uid || '' }, profile,
        { action: 'rescheduled', preferred_date: data.preferred_date, preferred_time: data.preferred_time }, timestamp);
      return { id: ref.id, status: 'pending' };
    });
  };
}

module.exports = { createBookingHandler, createBatchBookingHandler, rescheduleBookingHandler, activeBooking };
function cancelBookingHandler({db,HttpsError,timestamp,now=()=>new Date()}) {
 return async request=>{
  const claims=request.auth?.token,data=request.data||{};
  if(!claims||claims.secure_login!==true||claims.email_verified!==true||claims.firebase?.sign_in_provider!=='custom') throw new HttpsError('unauthenticated','Sign in again.');
  if(typeof data.appointment_id!=='string'||!data.appointment_id||data.appointment_id.includes('/')||typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>2000) throw new HttpsError('invalid-argument','Choose an appointment and provide a cancellation reason.');
  return db.runTransaction(async tx=>{
   const ref=db.collection('appointments').doc(data.appointment_id),item=(await tx.get(ref)).data();
   const user=(await tx.get(db.collection('users').doc(request.auth.uid))).data();
   if(user?.role!=='resident'||user.is_active===false||item?.resident_uid!==request.auth.uid) throw new HttpsError('permission-denied','Only the resident who booked can cancel this appointment.');
   if(item.status==='cancelled') return {id:ref.id};
   if(!['pending','confirmed'].includes(item.status)||item.arrived_at) throw new HttpsError('failed-precondition','Only pending or confirmed appointments before arrival can be cancelled.');
   const release=await releaseReservation(tx,db,item,timestamp,now());
   if(release) release();
   tx.update(ref,{status:'cancelled',cancellation_reason:data.reason.trim(),cancelled_at:timestamp(),cancelled_by:request.auth.uid,...(release?{stock_reservation:{...item.stock_reservation,status:'released',released_at:timestamp()}}:{})});
   notifyClinicAppointment(tx, db, ref.id, item, user, { action: 'cancelled', reason: data.reason.trim() }, timestamp);
   return {id:ref.id};
  });
 };
}
module.exports.cancelBookingHandler=cancelBookingHandler;
