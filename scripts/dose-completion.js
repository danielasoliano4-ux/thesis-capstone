import { auth, db } from './firebase.js';
import { collection, query, where, onSnapshot, getDocs, getDoc, doc, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { availableStock, commitDose } from './dose-stock.mjs';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
let unsubscribe;
export function watchDoseStock(clinicId) {
  unsubscribe?.();
  const select = document.getElementById('completionVaccine');
  select.replaceChildren(new Option('Loading clinic stock...', ''));
  select.disabled = true;
  unsubscribe = onSnapshot(query(collection(db, 'inventory'), where('clinic_id', '==', clinicId)), snapshot => {
    const selected = select.value;
    const items = availableStock(snapshot.docs.map(item => ({...item.data(), id:item.id})), clinicId, today());
    select.replaceChildren(new Option(items.length ? 'Select vaccine / batch...' : 'No available vaccine stock', ''));
    for (const item of items) select.add(new Option(item.type + ' | Batch ' + (item.batch || 'unspecified'), item.id));
    select.disabled = false;
    select.value = items.some(item => item.id === selected) ? selected : '';
    select.setCustomValidity(items.length ? '' : 'Add available vaccine stock before completing this dose.');
  }, error => {
    select.replaceChildren(new Option('Could not load clinic stock', ''));
    select.disabled = false;
    select.setCustomValidity('Could not load clinic stock. Reopen the form to retry.');
    console.error('Could not load dose stock:', error);
  });
}
export async function saveStockDose(clinicId) {
  const form = document.getElementById('doseCompletionForm');
  const button = form.querySelector('[type="submit"]');
  if (button.disabled) return false;
  if (!form.reportValidity()) return false;
  const appointmentId = document.getElementById('completionAppointmentId').value;
  const stockId = document.getElementById('completionVaccine').value;
  if (!stockId) throw new Error('Select an available vaccine batch.');
  const values = { clinicId, uid: auth.currentUser.uid, today: today(), timestamp: serverTimestamp(),
    doseNumber: Number(document.getElementById('completionDose').value),
    date: document.getElementById('completionDate').value, location: document.getElementById('completionLocation').value };
  button.disabled = true;
  try {
    const existing = await getDocs(query(collection(db, 'vaccination_records'), where('appointment_id', '==', appointmentId)));
    if (!existing.empty) throw new Error('This appointment already has a completed dose.');
    const appointmentSnap = await getDoc(doc(db, 'appointments', appointmentId));
    const appointment = appointmentSnap.data();
    if (!appointment) throw new Error('Appointment was not found.');
    const courseRecords = await getDocs(query(collection(db, 'vaccination_records'), where('resident_uid', '==', appointment.resident_uid)));
    if (courseRecords.docs.some(item => {
      const record = item.data();
      return record.clinic_id === clinicId && Number(record.dose_number) === values.doseNumber
        && (record.vaccination_session_id || 'legacy') === (appointment.vaccination_session_id || 'legacy');
    })) throw new Error('This dose is already recorded for this patient course.');
    const refs = { appointment: doc(db, 'appointments', appointmentId), stock: doc(db, 'inventory', stockId),
      record: doc(db, 'vaccination_records', appointmentId), notification: doc(collection(db, 'notifications')) };
    await runTransaction(db, tx => commitDose(tx, refs, values));
    return true;
  } finally { button.disabled = false; }
}
