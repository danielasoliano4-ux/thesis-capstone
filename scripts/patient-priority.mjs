export function patientCategory(...records) {
  for (const record of records) {
    const value = record?.patient_category || record?.course_intake_data?.patient_category || record?.priority_category;
    const match = String(value || '').trim().match(/^(?:category\s*)?(III|II|I|3|2|1)$/i);
    if (match) return 'Category ' + ({ 1: 'I', 2: 'II', 3: 'III' }[match[1]] || match[1].toUpperCase());
  }
  return '';
}

export function activePriorityAppointment(record) {
  return ['confirmed', 'in_progress'].includes(record?.status);
}

export function isPriority(record) {
  return activePriorityAppointment(record) && record.queue_priority === 'high';
}

export function comparePatientPriority(first, second) {
  const priority = Number(isPriority(second)) - Number(isPriority(first));
  if (priority) return priority;
  if (!isPriority(first)) return 0;
  const rank = record => ({ 'Category I': 1, 'Category II': 2, 'Category III': 3 }[patientCategory(record)] || 0);
  return rank(second) - rank(first);
}

export function priorityUpdates(records, clinicId, category, enabled, staffId, timestamp) {
  if (!clinicId || !staffId) throw new Error('Sign in to an approved clinic staff account.');
  if (records.some(record => record.clinic_id !== clinicId)) throw new Error('You can only prioritize patients at your clinic.');
  const active = records.filter(activePriorityAppointment);
  if (!active.length) throw new Error('This patient no longer has an active appointment.');
  const assessedCategory = patientCategory({ patient_category: category });
  if (enabled && !assessedCategory) throw new Error('Record the patient category before setting priority.');
  return active.map(record => ({
    id: record.id,
    data: { queue_priority: enabled ? 'high' : 'normal', priority_category: assessedCategory, priority_updated_by: staffId, priority_updated_at: timestamp }
  }));
}
