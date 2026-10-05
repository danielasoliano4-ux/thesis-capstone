'use strict';

// Remove previously copied foreign-clinic records from appointment documents.
// Original vaccination records and resident history are never changed.
function localAppointmentHistory(appointment) {
  const history = appointment.course_vaccination_history;
  if (!Array.isArray(history)) return null;
  const local = history.filter(record => appointment.clinic_id && record.clinic_id === appointment.clinic_id);
  return local.length === history.length ? null : local;
}

async function run() {
  const args = process.argv.slice(2);
  const project = args[args.indexOf('--project') + 1];
  if (!args.includes('--project') || !project || project.startsWith('--')) {
    throw new Error('Pass --project PROJECT_ID. Default is a dry run; add --apply to remove copied foreign-clinic history.');
  }
  const admin = require('firebase-admin');
  admin.initializeApp({ projectId: project });
  const db = admin.firestore();
  const apply = args.includes('--apply');
  let cursor, affected = 0;
  for (;;) {
    let query = db.collection('appointments').orderBy(admin.firestore.FieldPath.documentId()).limit(200);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    for (const document of page.docs) {
      if (localAppointmentHistory(document.data()) === null) continue;
      affected++;
      if (apply) await db.runTransaction(async tx => {
        const current = await tx.get(document.ref);
        if (!current.exists) return;
        const history = localAppointmentHistory(current.data());
        if (history !== null) tx.update(document.ref, { course_vaccination_history: history });
      });
    }
    cursor = page.docs[page.docs.length - 1];
  }
  console.log(`${apply ? 'Cleaned' : 'Dry run: would clean'} copied history in ${affected} appointments. Original vaccination records were preserved.`);
}

if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { localAppointmentHistory };
