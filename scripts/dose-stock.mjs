export function usableStock(item, clinicId, today) {
  return item?.clinic_id === clinicId && !item.archived && typeof item.type === 'string' && item.type.trim()
    && /^\d{4}-\d{2}-\d{2}$/.test(item.expiry || '') && item.expiry >= today
    && Number.isInteger(Number(item.quantity)) && Number(item.quantity) > 0;
}
export function availableStock(items, clinicId, today) {
  return items.filter(item => usableStock(item, clinicId, today)).sort((a,b) => a.expiry.localeCompare(b.expiry) || a.type.localeCompare(b.type));
}
export async function commitDose(tx, refs, values) {
  const appointmentSnap = await tx.get(refs.appointment);
  const stockSnap = await tx.get(refs.stock);
  const recordSnap = await tx.get(refs.record);
  const appointment = appointmentSnap.data();
  const stock = stockSnap.data();
  if (recordSnap.exists() || appointment?.status === 'completed') throw new Error('This appointment already has a completed dose.');
  if (!appointment || appointment.clinic_id !== values.clinicId) throw new Error('Appointment does not belong to this clinic.');
  if (appointment.status !== 'in_progress' || !appointment.intake_completed_at) throw new Error('Record arrival and complete medical intake first.');
  if (!usableStock(stock, values.clinicId, values.today)) throw new Error('This vaccine batch is no longer available. Select another batch.');
  const scheduledDose = Number(String(appointment.dose_label || '1').match(/\d+/)?.[0] || 1);
  if (!Number.isInteger(values.doseNumber) || values.doseNumber < 1 || values.doseNumber > 5 || values.doseNumber !== scheduledDose) throw new Error('Dose number must match this appointment.');
  const date = new Date(values.date + 'T00:00:00Z');
  if (!Number.isFinite(+date) || date.toISOString().slice(0,10) !== values.date || values.date > values.today || !values.location.trim()) throw new Error('Enter a valid administration date and clinic location.');
  tx.update(refs.stock, { quantity: Number(stock.quantity) - 1, updated_at: values.timestamp });
  tx.set(refs.record, {
    resident_uid: appointment.resident_uid, resident_name: appointment.resident_name || '', appointment_id: refs.appointment.id,
    vaccination_session_id: appointment.vaccination_session_id || 'legacy', dose_number: values.doseNumber,
    vaccine_name: stock.type, vaccine_type: stock.type, inventory_id: refs.stock.id, vaccine_batch: stock.batch || '',
    clinic_id: values.clinicId, clinic_name: appointment.clinic_name || '', clinic_location: values.location.trim(),
    date_given: values.date, administered_by: values.uid, recorded_at: values.timestamp
  });
  tx.update(refs.appointment, { status: 'completed', completed_at: values.timestamp, completed_dose_number: values.doseNumber, completed_vaccine_name: stock.type });
  tx.set(refs.notification, {
    recipient_uid: appointment.resident_uid, user_id: appointment.resident_uid, appointment_id: refs.appointment.id,
    type: 'vaccine', title: 'Dose ' + values.doseNumber + ' Completed',
    message: 'Your Dose ' + values.doseNumber + ' vaccination was recorded at ' + (appointment.clinic_name || 'the clinic') + ' on ' + values.date + '.',
    read: false, created_at: values.timestamp
  });
}
