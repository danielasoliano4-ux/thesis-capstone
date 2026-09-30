export function appointmentDeadline(item) {
  if (Number.isFinite(item.arrival_deadline_ms)) return item.arrival_deadline_ms;
  const match = /^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i.exec(String(item.preferred_time || '').trim());
  if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(item.preferred_date || '')) return NaN;
  let hour = Number(match[1]);
  if (Number(match[2]) > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) return NaN;
  if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
  return Date.parse(item.preferred_date + 'T' + String(hour).padStart(2, '0') + ':' + match[2] + ':00+08:00') + 90 * 60 * 1000;
}
// Firestore stores clinic acceptance as "confirmed".
export function clinicBooking(bookings, clinicId, today, now = Date.now()) {
  const active = bookings.filter(item => item.clinic_id === clinicId &&
    ((item.status === 'pending' && !pendingAppointmentExpired(item, now)) || item.status === 'in_progress' ||
      (['confirmed', 'accepted', 'approved'].includes(item.status) &&
        (Number.isFinite(appointmentDeadline(item)) ? now < appointmentDeadline(item) : (!item.reservation_end_date || item.reservation_end_date >= today)))));
  return active.find(item => item.status !== 'pending') || active[0] || null;
}

export function pendingAppointmentExpired(item, now = Date.now()) {
  const scheduled = Number.isFinite(item.scheduled_at_ms) ? item.scheduled_at_ms : appointmentDeadline({ ...item, arrival_deadline_ms: null }) - 90 * 60 * 1000;
  return item.status === 'pending' && Number.isFinite(scheduled) && now >= scheduled;
}
