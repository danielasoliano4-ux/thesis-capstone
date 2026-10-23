import { auth, db } from './firebase.js';
import { doc, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { priorityUpdates } from './patient-priority.mjs';

export async function savePatientPriority(appointmentIds, clinicId, category, enabled) {
  const staffId = auth.currentUser?.uid;
  const ids = [...new Set(appointmentIds)];
  if (!ids.length || !staffId) throw new Error('An active patient appointment is required.');
  await runTransaction(db, async transaction => {
    const snapshots = await Promise.all(ids.map(id => transaction.get(doc(db, 'appointments', id))));
    const records = snapshots.filter(snapshot => snapshot.exists()).map(snapshot => ({ ...snapshot.data(), id: snapshot.id }));
    const updates = priorityUpdates(records, clinicId, category, enabled, staffId, serverTimestamp());
    updates.forEach(update => transaction.update(doc(db, 'appointments', update.id), update.data));
  });
}
