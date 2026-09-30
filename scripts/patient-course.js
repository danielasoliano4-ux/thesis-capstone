export const courseKey = item => JSON.stringify([item.resident_uid || '', item.vaccination_session_id || 'legacy']);
function scheduled(item) {
 const match = /^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i.exec(String(item.preferred_time || '').trim());
 if (!match) return NaN;
 let hour = Number(match[1]);
 if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
 return Date.parse(item.preferred_date + 'T' + String(hour).padStart(2,'0') + ':' + match[2] + ':00+08:00');
}
export function courseStatus(appointments, records, now = Date.now()) {
 const doses = new Set(records.map(item => Number(item.dose_number)).filter(n => Number.isInteger(n) && n >= 1 && n <= 5));
 if (doses.size === 5) return {status:'complete', doses:5, note:'All 5 doses recorded'};
 const next = [1,2,3,4,5].find(n => !doses.has(n));
 const followups = appointments.filter(item => !doses.has(Number(item.completed_dose_number || String(item.dose_label || '').match(/\d+/)?.[0] || next)));
 if (followups.some(item => item.status === 'in_progress' || item.arrived_at)) return {status:'ongoing', doses:doses.size, note:'Patient arrived; care in progress'};
 const booked = followups.filter(item => ['pending','confirmed'].includes(item.status)).sort((a,b) => scheduled(b)-scheduled(a));
 const upcoming = booked.find(item => scheduled(item) + 90*60000 > now);
 if (upcoming) return {status:'ongoing', doses:doses.size, note:'Next appointment: ' + upcoming.preferred_date + ' at ' + upcoming.preferred_time};
 if (doses.size && (booked.some(item => scheduled(item) + 90*60000 <= now) || followups.some(item => ['expired','no_show'].includes(item.status))))
  return {status:'incomplete', doses:doses.size, note:'Follow-up arrival deadline missed'};
 // Use the same Day 0/3/7/14/28 schedule as the resident portal when no booking remains.
 const first = records.find(item => Number(item.dose_number) === 1);
 const date = typeof first?.date_given === 'string' ? first.date_given.slice(0,10) : first?.date_given?.toDate?.().toLocaleDateString('en-CA',{timeZone:'Asia/Manila'});
 const due = date ? Date.parse(date + 'T00:00:00+08:00') + [0,3,7,14,28][next-1]*86400000 : NaN;
 if (doses.size && Number.isFinite(due) && now >= due + 86400000) return {status:'incomplete',doses:doses.size,note:'Follow-up dose is overdue; no arrival recorded'};
 return {status:'ongoing',doses:doses.size,note:doses.size ? 'Course in progress; awaiting next dose' : 'Patient intake and treatment in progress'};
}
