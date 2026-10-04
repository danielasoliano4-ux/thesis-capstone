'use strict';
const { animalExposureSummary } = require('./appointment-lifecycle');
function buildSummary(appointments, vaccinations, patientRecords, residentRows, year) {
const selectedAnalyticsYear = year;
const residents = new Map(residentRows.map(row => [row.id, row]));
const intake = new Map(patientRecords.map(row => [sessionKey(row), row]));
appointments = appointments.map(row => ({ ...row, ...intake.get(sessionKey(row)) }));
vaccinations = vaccinations.map(row => ({ ...intake.get(sessionKey(row)), ...row }));
const known = new Set(appointments.map(sessionKey));
appointments.push(...patientRecords.filter(row => !known.has(sessionKey(row))));
function timestampValue(value) { return value?.toMillis?.() || (value ? new Date(value).getTime() : 0); }
function dateValue(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const date = new Date(`${value.slice(0, 10)}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return typeof value.toDate === 'function' ? value.toDate() : null;
}

function recordDate(record) {
  return dateValue(record.bite_date) || dateValue(record.preferred_date)
    || dateValue(record.date_given) || dateValue(record.created_at);
}

function inSelectedAnalyticsYear(record) {
  return recordDate(record)?.getFullYear() === selectedAnalyticsYear;
}


function barangayFor(record) {
  const profile = residents.get(record.resident_uid);
  return profile?.barangay || record.barangay || record.resident_barangay || 'Unspecified';
}

function ageFor(record) {
  const birthDate = dateValue(record.date_of_birth)
    || dateValue(residents.get(record.resident_uid)?.date_of_birth);
  const eventDate = recordDate(record) || new Date();
  if (!birthDate) return null;
  let age = eventDate.getFullYear() - birthDate.getFullYear();
  if (eventDate < new Date(eventDate.getFullYear(), birthDate.getMonth(), birthDate.getDate())) age--;
  return age >= 0 ? age : null;
}

function sessionKey(record) {
  if (record.vaccination_session_id && record.vaccination_session_id !== 'legacy') return `session:${record.vaccination_session_id}`;
  // Legacy records did not have a session id. Group them by resident so each
  // five-dose course remains one case instead of five separate appointments.
  return record.resident_uid ? `legacy:${record.resident_uid}` : `record:${record.id || crypto.randomUUID()}`;
}

function buildCaseSessions() {
  const sessions = new Map();
  const add = (record, source) => {
    const key = sessionKey(record);
    const eventDate = recordDate(record);
    const session = sessions.get(key) || { key, resident_uid: record.resident_uid, first: record, date: eventDate, doses: new Set(), death: false };
    if (eventDate && (!session.date || eventDate < session.date)) { session.date = eventDate; session.first = record; }
    if (source === 'appointment') {
      const state = String(record.outcome || record.status || '').toLowerCase();
      session.death ||= ['death', 'deceased', 'fatal'].includes(state);
    }
    if (source === 'vaccination') {
      const dose = Number(record.dose_number || 0);
      if (dose >= 1 && dose <= 5) session.doses.add(dose);
    }
    sessions.set(key, session);
  };
  appointments.filter(item => !['declined', 'cancelled'].includes(item.status)).forEach(item => add(item, 'appointment'));
  vaccinations.forEach(item => add(item, 'vaccination'));
  return [...sessions.values()].map(session => ({ ...session, completed: [1, 2, 3, 4, 5].every(dose => session.doses.has(dose)) }));
}

function buildPublicCaseRecords() {
  return buildCaseSessions().filter(session => session.date).sort((a, b) => b.date - a.date).map((session, index) => {
    const records = vaccinations.filter(record => sessionKey(record) === session.key);
    const latestRecord = [...records].sort((a, b) => timestampValue(b.recorded_at || b.date_given) - timestampValue(a.recorded_at || a.date_given))[0];
    const source = session.first;
    const categorySource = [source, ...appointments.filter(record => sessionKey(record) === session.key), ...records].find(record => record.patient_category || record.course_intake_data?.patient_category || record.who_category || record.bite_category || record.category) || source;
    const category = categorySource.patient_category || categorySource.course_intake_data?.patient_category || categorySource.who_category || categorySource.bite_category || categorySource.category || 'Not recorded';
    const doses = session.doses.size;
    const outcome = session.death ? 'death' : session.completed ? 'recovered' : 'ongoing';
    return {
      caseId: `CAB-${session.date.getFullYear()}-${String(index + 1).padStart(3, '0')}`,
      year: session.date.getFullYear(), barangay: barangayFor(source), animal: normalizeAnimalSource(source.animal_type),
      category, severity: /iii|3/i.test(category) ? 'High' : /ii|2/i.test(category) ? 'Medium' : /^(Category )?(I|1)$/i.test(category) ? 'Low' : 'Unknown', outcome,
      doseCount: doses, vaccine: latestRecord?.vaccine_name || source.vaccine_name || 'Not recorded',
      clinic: latestRecord?.clinic_name || source.clinic_name || 'Not recorded',
      date: session.date.toISOString().slice(0, 10)
    };
  });
}

function normalizeAnimalSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'dog') return 'Dog';
  if (normalized === 'cat') return 'Cat';
  if (normalized === 'bat') return 'Bat';
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Others';
}

  const cases = buildCaseSessions().filter(item => item.date?.getFullYear() === selectedAnalyticsYear);
  const yearVaccinations = vaccinations.filter(inSelectedAnalyticsYear);
  const monthlyCases = Array(12).fill(0);
  const monthlyVaccinations = Array(12).fill(0);
  const animalCounts = new Map();
  const barangayMap = new Map();
  const ageGroups = [0, 0, 0, 0, 0];

  cases.forEach(item => {
    const date = item.date;
    if (date) monthlyCases[date.getMonth()]++;
    const animal = normalizeAnimalSource(item.first.animal_type);
    animalCounts.set(animal, (animalCounts.get(animal) || 0) + 1);
    const barangay = barangayFor(item.first);
    const row = barangayMap.get(barangay) || { name: barangay, cases: 0, vaccinations: 0, completed: 0 };
    row.cases++;
    if (item.completed) row.completed++;
    barangayMap.set(barangay, row);
    const age = ageFor(item.first);
    if (age !== null) ageGroups[age < 10 ? 0 : age < 20 ? 1 : age < 40 ? 2 : age < 60 ? 3 : 4]++;
  });

  yearVaccinations.forEach(item => {
    const date = recordDate(item);
    if (date) monthlyVaccinations[date.getMonth()]++;
    const barangay = barangayFor(item);
    const row = barangayMap.get(barangay) || { name: barangay, cases: 0, vaccinations: 0, completed: 0 };
    row.vaccinations++;
    barangayMap.set(barangay, row);
  });

  const barangays = [...barangayMap.values()]
    .filter(item => item.cases || item.vaccinations)
    .sort((first, second) => second.cases - first.cases || second.vaccinations - first.vaccinations)
    .map(item => ({ ...item, completionRate: item.cases ? Math.min(100, Math.round((item.completed / item.cases) * 100)) : 0 }));
  const maxCases = Math.max(1, ...barangays.map(item => item.cases));
  const animalTotal = [...animalCounts.values()].reduce((sum, value) => sum + value, 0);
  const animals = [...animalCounts.entries()].sort((first, second) => second[1] - first[1])
    .slice(0, 6).map(([name, count]) => ({ name, percent: animalTotal ? Math.round(count / animalTotal * 100) : 0 }));
  const deaths = cases.filter(item => item.death).length;
  const ongoing = cases.filter(item => !item.death && !item.completed).length;
  const summary = {
    year: selectedAnalyticsYear,
    monthlyCases,
    monthlyVaccinations,
    barangays,
    caseTrend: monthlyCases.map(value => value ? Math.round(value / Math.max(1, ...monthlyCases) * 100) : 0),
    ageGroups,
    animals,
    totalCases: cases.length,
    totalVaccinations: yearVaccinations.length,
    activePatients: new Set(cases.filter(item => !item.death && !item.completed).map(item => item.resident_uid).filter(Boolean)).size,
    completed: cases.filter(item => item.completed).length,
    ongoing,
    deaths,
    highRiskBarangays: barangays.filter(item => item.cases / maxCases >= 0.66).length,
    publicRecords: buildPublicCaseRecords()
  };
return summary;
}
async function refreshAnalytics(db, timestamp) {
await db.runTransaction(async tx => {
const snapshots = await Promise.all(['appointments','vaccination_records','patient_records','residents'].map(name => tx.get(db.collection(name))));
const rows = snapshots.map(snapshot => snapshot.docs.map(doc => ({ ...doc.data(), id:doc.id })));
const year = Number(new Intl.DateTimeFormat('en', { timeZone:'Asia/Manila', year:'numeric' }).format(new Date()));
tx.set(db.collection('system_settings').doc('live_analytics'), { ...buildSummary(...rows, year), updated_at:timestamp() });
tx.set(db.collection('system_settings').doc('animal_exposure'), { animals:animalExposureSummary(rows[2]), updated_at:timestamp() });
});
}
module.exports = { buildSummary, refreshAnalytics };
