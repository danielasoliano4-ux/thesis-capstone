import { auth, db, fetchUserProfile } from './firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { routes } from './routes.js';
import {
  collection, doc, onSnapshot, serverTimestamp, setDoc, updateDoc
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js';

let selectedAnalyticsYear = new Date().getFullYear();
let appointments = [];
let vaccinations = [];
let residents = new Map();
let users = [];
let clinics = [];
let inventory = [];

const VACCINE_BRAND_ALIASES = {
  'verorab': 'Verorab (PVRV)', 'verorab pvrv': 'Verorab (PVRV)', 'verovab': 'Verorab (PVRV)',
  'rabipur': 'Rabipur (PCECV)', 'rabipub': 'Rabipur (PCECV)',
  'speeda': 'Speeda (PVRV)', 'vaxirab': 'VaxiRab N (PCECV)', 'vaxirab n': 'VaxiRab N (PCECV)',
  'rabivax': 'Rabivax-S (PVRV)', 'rabivax s': 'Rabivax-S (PVRV)',
  'imovax': 'Imovax (HDCV)', 'rabavert': 'RabAvert (PCECV)', 'rab avert': 'RabAvert (PCECV)'
};
function canonicalVaccineBrand(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return VACCINE_BRAND_ALIASES[key] || 'Other / unclassified';
}

document.getElementById('adminSignOutBtn')?.addEventListener('click', async () => {
  await signOut(auth);
  window.location.replace(routes.adminLogin);
});

document.getElementById('clearReportDates')?.addEventListener('click', () => {
  document.getElementById('reportStartDate').value = '';
  document.getElementById('reportEndDate').value = '';
});
document.querySelectorAll('[data-report]').forEach(button => button.addEventListener('click', () => openReportPreview(button.dataset.report)));
document.getElementById('closeReportPreviewBtn')?.addEventListener('click', closeReportPreview);
document.getElementById('printReportPreviewBtn')?.addEventListener('click', () => window.print());
document.getElementById('reportPreviewModal')?.addEventListener('click', event => {
  if (event.target.id === 'reportPreviewModal') closeReportPreview();
});
document.getElementById('addClinicBtn')?.addEventListener('click', () => editClinic());
document.getElementById('addUserBtn')?.addEventListener('click', () => createUserAccount());
document.getElementById('analyticsYear')?.addEventListener('change', event => {
  selectedAnalyticsYear = Number(event.target.value) || new Date().getFullYear();
  renderAnalytics();
});

onAuthStateChanged(auth, async user => {
  if (!user) return;
  const profile = await fetchUserProfile(user.uid);
  if (profile?.role !== 'admin' && profile?.role !== 'administrator') return;
  onSnapshot(collection(db, 'appointments'), snapshot => {
    appointments = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderAnalytics();
  }, reportError);
  onSnapshot(collection(db, 'vaccination_records'), snapshot => {
    vaccinations = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderAnalytics();
  }, reportError);
  onSnapshot(collection(db, 'residents'), snapshot => {
    residents = new Map(snapshot.docs.map(item => [item.id, item.data()]));
    renderAnalytics();
  }, reportError);
  onSnapshot(collection(db, 'users'), snapshot => {
    users = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderManagement();
    renderAnalytics();
  }, reportError);
  onSnapshot(collection(db, 'clinics'), snapshot => {
    clinics = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderManagement();
    renderAnalytics();
  }, reportError);
  onSnapshot(collection(db, 'inventory'), snapshot => {
    inventory = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderManagement();
    renderAnalytics();
  }, reportError);
});

function reportError(error) {
  console.error('Failed to load live analytics data:', error);
}

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

function refreshYearSelector() {
  const select = document.getElementById('analyticsYear');
  if (!select) return;
  const years = new Set([new Date().getFullYear()]);
  [...appointments, ...vaccinations].forEach(record => {
    const year = recordDate(record)?.getFullYear();
    if (year) years.add(year);
  });
  const values = [...years].sort((a, b) => b - a);
  if (!values.includes(selectedAnalyticsYear)) selectedAnalyticsYear = values[0];
  select.innerHTML = values.map(year => `<option value="${year}">${year}</option>`).join('');
  select.value = String(selectedAnalyticsYear);
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
    const category = source.who_category || source.bite_category || source.category || 'Not recorded';
    const doses = session.doses.size;
    const outcome = session.death ? 'death' : session.completed ? 'recovered' : 'ongoing';
    return {
      caseId: `CAB-${session.date.getFullYear()}-${String(index + 1).padStart(3, '0')}`,
      year: session.date.getFullYear(), barangay: barangayFor(source), animal: normalizeAnimalSource(source.animal_type),
      category, severity: /iii|3/i.test(category) ? 'High' : /ii|2/i.test(category) ? 'Medium' : 'Low', outcome,
      doseCount: doses, vaccine: latestRecord?.vaccine_name || source.vaccine_name || 'Not recorded',
      clinic: latestRecord?.clinic_name || source.clinic_name || 'Not recorded',
      date: session.date.toISOString().slice(0, 10)
    };
  });
}

function renderAnalytics() {
  refreshYearSelector();
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
    pendingStaff: users.filter(user => user.role === 'clinic_staff' && (user.approval_status === 'pending' || user.status === 'pending')).length,
    clinicsOutOfStock: clinics.filter(clinic => usableClinicStock(clinic.id) === 0).length,
    expiringBatches: inventory.filter(item => !item.archived && isExpiringOrExpired(item.expiry)).length,
    publicRecords: buildPublicCaseRecords()
  };
  updateDashboard(summary, maxCases);
  setDoc(doc(db, 'system_settings', 'live_analytics'), { ...summary, updated_at: serverTimestamp() }, { merge: true }).catch(reportError);
}

function normalizeAnimalSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'dog') return 'Dog';
  if (normalized === 'cat') return 'Cat';
  if (normalized === 'bat') return 'Bat';
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Others';
}

function updateDashboard(data, maxCases) {
  setText('statTotalCases', data.totalCases);
  setText('statTotalVaccinations', data.totalVaccinations);
  setText('statActivePatients', data.activePatients);
  setText('statHighRiskBarangays', data.highRiskBarangays);
  setText('statOngoingCases', data.ongoing);
  setText('statCompletedCases', data.completed);
  setText('statDeaths', data.deaths);
  setText('analyticsChartTitle', `Monthly Rabies Cases & Vaccinations (${selectedAnalyticsYear})`);
  setText('heatmapCasesHeader', `Cases (${selectedAnalyticsYear})`);
  if (window.adminMonthlyChart) {
    window.adminMonthlyChart.data.datasets[0].data = data.monthlyCases;
    window.adminMonthlyChart.data.datasets[1].data = data.monthlyVaccinations;
    window.adminMonthlyChart.update();
  }
  updateStockChart();
  updateSystemMetrics(data);
  const body = document.getElementById('heatmapBody');
  if (!body) return;
  body.innerHTML = data.barangays.map(item => {
    const ratio = item.cases / Math.max(1, maxCases);
    const risk = ratio >= 0.66 ? ['High', 'badge-high', 'risk-high'] : ratio >= 0.33 ? ['Medium', 'badge-med', 'risk-med'] : ['Low', 'badge-low', 'risk-low'];
    return `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td>${item.cases}</td><td>${item.vaccinations}</td><td>${item.completionRate}%</td><td><span class="risk-badge ${risk[1]}">${risk[0]}</span></td><td class="risk-bar-cell"><div class="risk-bar-wrap"><div class="risk-bar-fill ${risk[2]}" style="width:${Math.round(ratio * 100)}%;"></div></div></td></tr>`;
  }).join('') || '<tr><td colspan="6">No live case data has been recorded yet.</td></tr>';
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function escapeHtml(value) {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}

function renderManagement() {
  const staff = users.filter(user => user.role === 'clinic_staff');
  const pending = staff.filter(user => user.approval_status === 'pending' || user.status === 'pending');
  setText('userTotalResidents', users.filter(user => user.role === 'resident').length || residents.size);
  setText('userClinicStaff', staff.length);
  setText('userPendingApproval', pending.length);
  setText('userTotalClinics', clinics.length);

  const pendingGrid = document.getElementById('pendingStaffGrid');
  if (pendingGrid) {
    pendingGrid.innerHTML = pending.length ? pending.map(user => `<div class="user-card">
      <div class="user-avatar" style="background:#dbeafe;color:#2563eb;"><i class="fa-solid fa-user-nurse"></i></div>
      <h4>${escapeHtml(user.full_name || user.email || 'Clinic Staff')}</h4>
      <p>${escapeHtml(user.clinic_name || user.clinic_id || 'Clinic not assigned')}<br>Created ${formatDate(user.created_at)}${user.bplo_certificate_url ? `<br><a href="${escapeHtml(user.bplo_certificate_url)}" target="_blank" rel="noopener">View BPLO certificate</a>` : ''}</p>
      <button class="approve-btn" type="button" data-approve-user="${user.id}">Approve</button>
      <button class="deny-btn" type="button" data-deny-user="${user.id}">Deny</button>
    </div>`).join('') : '<p>No pending clinic staff approvals.</p>';
    pendingGrid.querySelectorAll('[data-approve-user]').forEach(button => button.addEventListener('click', () => changeStaffStatus(button.dataset.approveUser, true)));
    pendingGrid.querySelectorAll('[data-deny-user]').forEach(button => button.addEventListener('click', () => changeStaffStatus(button.dataset.denyUser, false)));
  }

  const userBody = document.getElementById('activeUsersBody');
  if (userBody) {
    userBody.innerHTML = users.length ? users.map(user => {
      const active = user.is_active !== false && user.status !== 'disabled';
      const residentProfile = residents.get(user.id);
      const location = user.role === 'resident' ? residentProfile?.barangay || '-' : user.clinic_name || user.clinic_id || '-';
      const priorHistory = user.role === 'resident' && residentProfile?.prior_vaccination_history_declared
        ? `<br><small style="color:#1d4ed8;font-weight:700;">Prior vaccination declared</small>${residentProfile.prior_vaccination_document_url ? `<br><a href="${escapeHtml(residentProfile.prior_vaccination_document_url)}" target="_blank" rel="noopener">Review supporting record</a>` : ''}`
        : '';
      return `<tr><td><strong>${escapeHtml(user.full_name || user.email || 'User')}</strong>${priorHistory}</td><td>${escapeHtml(user.role || '-')}</td><td>${escapeHtml(location)}</td><td><span class="status ${active ? 'adequate' : 'critical'}">${active ? 'Active' : 'Inactive'}</span></td><td>${formatDate(user.last_active_at || user.updated_at || user.created_at)}</td><td><div class="table-action-group"><button type="button" class="table-action table-action-edit" data-edit-user="${user.id}" aria-label="Edit ${escapeHtml(user.full_name || user.email || 'user')}"><i class="fa-regular fa-pen-to-square"></i><span>Edit</span></button><button type="button" class="table-action table-action-delete" data-delete-user="${user.id}" aria-label="Delete ${escapeHtml(user.full_name || user.email || 'user')}"><i class="fa-regular fa-trash-can"></i><span>Delete</span></button></div></td></tr>`;
    }).join('') : '<tr><td colspan="6">No users found.</td></tr>';
    userBody.querySelectorAll('[data-edit-user]').forEach(button => button.addEventListener('click', () => editUser(users.find(item => item.id === button.dataset.editUser))));
    userBody.querySelectorAll('[data-delete-user]').forEach(button => button.addEventListener('click', () => deleteUserAccount(button.dataset.deleteUser)));
  }

  const clinicBody = document.getElementById('clinicsBody');
  if (clinicBody) {
    clinicBody.innerHTML = clinics.length ? clinics.map(clinic => {
      const stock = inventory.filter(item => item.clinic_id === clinic.id);
      const totalStock = stock.reduce((total, item) => total + Number(item.quantity || 0), 0);
      const status = totalStock === 0 ? ['critical', 'Out of Stock'] : totalStock <= 15 ? ['low', 'Low Stock'] : ['adequate', 'Available'];
      const updated = [...stock, clinic].map(item => item.updated_at || item.created_at).sort((first, second) => timestampValue(second) - timestampValue(first))[0];
      return `<tr><td><strong>${escapeHtml(clinic.name || 'Unnamed Clinic')}</strong></td><td>${escapeHtml(clinic.type || 'ABTC')}</td><td>${escapeHtml(clinic.barangay || clinic.address || '-')}</td><td>${totalStock} doses</td><td><span class="status ${status[0]}">${status[1]}</span></td><td>${formatDate(updated)}</td><td><div class="table-action-group"><button type="button" class="table-action table-action-edit" data-edit-clinic="${clinic.id}" aria-label="Edit ${escapeHtml(clinic.name || 'clinic')}"><i class="fa-regular fa-pen-to-square"></i><span>Edit</span></button><button type="button" class="table-action table-action-delete" data-delete-clinic="${clinic.id}" aria-label="Delete ${escapeHtml(clinic.name || 'clinic')}"><i class="fa-regular fa-trash-can"></i><span>Delete</span></button></div></td></tr>`;
    }).join('') : '<tr><td colspan="7">No clinics found.</td></tr>';
    clinicBody.querySelectorAll('[data-edit-clinic]').forEach(button => button.addEventListener('click', () => editClinic(clinics.find(item => item.id === button.dataset.editClinic))));
    clinicBody.querySelectorAll('[data-delete-clinic]').forEach(button => button.addEventListener('click', () => deleteClinic(button.dataset.deleteClinic)));
  }
}

async function changeStaffStatus(userId, approved) {
  try {
    await updateDoc(doc(db, 'users', userId), { is_active: approved, approval_status: approved ? 'approved' : 'denied', updated_at: serverTimestamp() });
  } catch (error) {
    console.error('Could not update staff approval:', error);
    alert(`Could not update staff approval: ${error.message}`);
  }
}

function timestampValue(value) {
  return value?.toMillis?.() || (value ? new Date(value).getTime() : 0);
}

function formatDate(value) {
  const time = timestampValue(value);
  return time ? new Date(time).toLocaleDateString() : 'Not recorded';
}

function isExpiringOrExpired(expiry) {
  if (!expiry) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const expiryDate = new Date(`${String(expiry).slice(0, 10)}T00:00:00`);
  return !Number.isNaN(expiryDate.getTime()) && expiryDate.getTime() - today.getTime() <= 30 * 86400000;
}

function isExpired(expiry) {
  if (!expiry) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const expiryDate = new Date(`${String(expiry).slice(0, 10)}T00:00:00`);
  return !Number.isNaN(expiryDate.getTime()) && expiryDate < today;
}

function usableClinicStock(clinicId) {
  return inventory.filter(item => item.clinic_id === clinicId && !item.archived && !isExpired(item.expiry) && Number(item.quantity || 0) > 0)
    .reduce((total, item) => total + Number(item.quantity || 0), 0);
}

function updateStockChart() {
  if (!window.adminStockChart) return;
  const byType = new Map();
  inventory.filter(item => !item.archived).forEach(item => {
    const type = canonicalVaccineBrand(item.type);
    byType.set(type, (byType.get(type) || 0) + Number(item.quantity || 0));
  });
  const entries = [...byType.entries()].sort((a, b) => b[1] - a[1]);
  window.adminStockChart.data.labels = entries.length ? entries.map(([name]) => name) : ['No active inventory'];
  window.adminStockChart.data.datasets[0].data = entries.length ? entries.map(([, quantity]) => quantity) : [1];
  window.adminStockChart.data.datasets[0].backgroundColor = entries.length ? ['#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#ec4899', '#0891b2'] : ['#e5e7eb'];
  window.adminStockChart.update();
}

function updateSystemMetrics(data) {
  const message = `${data.pendingStaff} pending staff approval${data.pendingStaff === 1 ? '' : 's'}, ${data.clinicsOutOfStock} clinic${data.clinicsOutOfStock === 1 ? '' : 's'} out of usable stock, and ${data.expiringBatches} batch${data.expiringBatches === 1 ? '' : 'es'} expired or expiring within 30 days.`;
  setText('systemAlertText', message);
  const body = document.getElementById('systemMetricsBody');
  if (!body) return;
  const metrics = [
    ['Staff Account Approvals', `${data.pendingStaff} pending`, data.pendingStaff ? 'low' : 'adequate', 'User Management'],
    ['Clinics Out of Usable Stock', `${data.clinicsOutOfStock} clinic${data.clinicsOutOfStock === 1 ? '' : 's'}`, data.clinicsOutOfStock ? 'critical' : 'adequate', 'Clinic Management'],
    ['Expired / Expiring Batches', `${data.expiringBatches} batch${data.expiringBatches === 1 ? '' : 'es'}`, data.expiringBatches ? 'critical' : 'adequate', 'Clinic Management'],
    ['Live Appointment Records', `${appointments.length} total`, 'adequate', 'Analytics']
  ];
  body.innerHTML = metrics.map(([name, value, status, destination]) => `<tr><td><strong>${name}</strong></td><td>${value}</td><td><span class="status ${status}">${status === 'adequate' ? 'Normal' : status === 'low' ? 'Attention' : 'Critical'}</span></td><td><button type="button" class="update-link live-metric-link" data-metric-destination="${destination}">View</button></td></tr>`).join('');
  body.querySelectorAll('[data-metric-destination]').forEach(button => button.addEventListener('click', () => {
    const index = { Analytics: 0, 'User Management': 1, 'Clinic Management': 2 }[button.dataset.metricDestination] || 0;
    showTab(['analytics', 'users', 'clinics'][index], document.querySelectorAll('.admin-tab')[index]);
  }));
}

async function createUserAccount() {
  const email = prompt('Email address for the new account:'); if (!email) return;
  const password = prompt('Temporary password (at least 6 characters):'); if (!password) return;
  const full_name = prompt('Full name / username:') || '';
  const role = prompt('Role: resident, clinic_staff, or admin', 'resident') || 'resident';
  try { await httpsCallable(getFunctions(), 'manageUserAccount')({ action: 'create', email, password, profile: { full_name, username: full_name, role } }); }
  catch (error) { alert(`Could not create account: ${error.message}. Deploy Cloud Functions first.`); }
}

async function editUser(user) {
  if (!user) return;
  const full_name = prompt('Full name / username:', user.full_name || user.username || ''); if (full_name === null) return;
  const role = prompt('Role:', user.role || 'resident'); if (role === null) return;
  try { await httpsCallable(getFunctions(), 'manageUserAccount')({ action: 'update', uid: user.id, profile: { full_name, username: full_name, role } }); }
  catch (error) { alert(`Could not update account: ${error.message}`); }
}

async function deleteUserAccount(uid) {
  if (!confirm('Delete this user account permanently?')) return;
  try { await httpsCallable(getFunctions(), 'manageUserAccount')({ action: 'delete', uid }); }
  catch (error) { alert(`Could not delete account: ${error.message}`); }
}

async function editClinic(clinic = null) {
  const name = prompt('Clinic name:', clinic?.name || ''); if (!name) return;
  const type = prompt('Clinic type:', clinic?.type || 'ABTC'); if (type === null) return;
  const barangay = prompt('Barangay:', clinic?.barangay || ''); if (barangay === null) return;
  const ref = clinic ? doc(db, 'clinics', clinic.id) : doc(collection(db, 'clinics'));
  try { await setDoc(ref, { name, type, barangay, updated_at: serverTimestamp(), ...(clinic ? {} : { created_at: serverTimestamp() }) }, { merge: true }); }
  catch (error) { alert(`Could not save clinic: ${error.message}`); }
}

async function deleteClinic(id) { if (confirm('Delete this clinic permanently?')) { try { const { deleteDoc } = await import('https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js'); await deleteDoc(doc(db, 'clinics', id)); } catch (error) { alert(`Could not delete clinic: ${error.message}`); } } }

function reportRange() {
  const start = document.getElementById('reportStartDate')?.value || '';
  const end = document.getElementById('reportEndDate')?.value || '';
  if (start && end && start > end) throw new Error('The start date must be on or before the end date.');
  return { start, end, label: start || end ? `${start || 'Beginning'} to ${end || 'Today'}` : 'All recorded dates' };
}

function inReportRange(record, range) {
  const value = recordDate(record)?.toISOString().slice(0, 10) || '';
  return (!range.start || value >= range.start) && (!range.end || value <= range.end);
}

function legacyDownloadReport(kind) {
  try {
    const range = reportRange();
    if (!window.jspdf?.jsPDF) throw new Error('The PDF library has not loaded. Check your internet connection and try again.');
    const pdf = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    const titles = { cases: 'Rabies Cases Report', vaccinations: 'Vaccination Status Report', inventory: 'Vaccine Inventory Report', risk: 'Barangay Risk Assessment' };
    let rows = [];
    if (kind === 'cases') rows = appointments.filter(item => item.status !== 'declined' && inReportRange(item, range)).map(item => `${item.preferred_date || 'No date'} | ${item.resident_name || 'Resident'} | ${item.barangay || barangayFor(item)} | ${item.status || 'pending'}`);
    if (kind === 'vaccinations') rows = vaccinations.filter(item => inReportRange(item, range)).map(item => `${item.date_given || 'No date'} | ${item.resident_name || item.resident_uid || 'Resident'} | Dose ${item.dose_number || '-'} | ${item.vaccine_name || '-'} | ${item.clinic_name || '-'}`);
    if (kind === 'inventory') rows = inventory.filter(item => !item.archived).map(item => `${item.clinic_id || '-'} | ${item.type || '-'} | Batch ${item.batch || '-'} | ${Number(item.quantity || 0)} doses | Expires ${item.expiry || '-'}`);
    if (kind === 'risk') {
      const counts = new Map();
      appointments.filter(item => item.status !== 'declined' && inReportRange(item, range)).forEach(item => { const name = barangayFor(item); counts.set(name, (counts.get(name) || 0) + 1); });
      rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} | ${count} reported case${count === 1 ? '' : 's'}`);
    }
    pdf.setFontSize(16); pdf.text('Anti-Rabies Locator — ' + titles[kind], 40, 48);
    pdf.setFontSize(10); pdf.text(`Date filter: ${range.label}`, 40, 68); pdf.text(`Generated: ${new Date().toLocaleString()}`, 40, 83);
    if (!rows.length) rows = ['No records match this report and date range.'];
    let y = 110;
    rows.forEach((row, index) => {
      const lines = pdf.splitTextToSize(`${index + 1}. ${row}`, 515);
      if (y + lines.length * 13 > 800) { pdf.addPage(); y = 45; }
      pdf.text(lines, 40, y); y += lines.length * 13 + 5;
    });
    pdf.save(`${kind}-report-${new Date().toISOString().slice(0, 10)}.pdf`);
  } catch (error) {
    alert(`Could not generate report: ${error.message}`);
  }
}

function reportDefinition(kind, range) {
  const caseRows = appointments.filter(item => item.status !== 'declined' && inReportRange(item, range));
  const vaccinationRows = vaccinations.filter(item => inReportRange(item, range));
  const activeInventory = inventory.filter(item => !item.archived);
  if (kind === 'cases') return {
    title: 'Rabies Cases Report', subtitle: 'Reported animal-bite cases by clinic and barangay',
    headers: ['Date', 'Resident', 'Barangay', 'Clinic', 'Status'],
    rows: caseRows.map(item => [item.preferred_date || 'No date', item.resident_name || 'Resident', item.barangay || barangayFor(item), item.clinic_name || '-', item.status || 'pending']),
    totals: [['Reported cases', caseRows.length], ['Confirmed', caseRows.filter(item => item.status === 'confirmed').length], ['Completed', caseRows.filter(item => item.status === 'completed').length]]
  };
  if (kind === 'vaccinations') return {
    title: 'Vaccination Status Report', subtitle: 'Completed anti-rabies vaccine doses by resident and clinic',
    headers: ['Date given', 'Resident', 'Dose', 'Vaccine', 'Clinic'],
    rows: vaccinationRows.map(item => [item.date_given || 'No date', item.resident_name || item.resident_uid || 'Resident', `Dose ${item.dose_number || '-'}`, item.vaccine_name || '-', item.clinic_name || '-']),
    totals: [['Doses recorded', vaccinationRows.length], ['Residents served', new Set(vaccinationRows.map(item => item.resident_uid).filter(Boolean)).size], ['Clinics reporting', new Set(vaccinationRows.map(item => item.clinic_id).filter(Boolean)).size]]
  };
  if (kind === 'inventory') return {
    title: 'Vaccine Inventory Report', subtitle: 'Current non-archived vaccine batches across all clinics',
    headers: ['Clinic', 'Vaccine', 'Batch', 'Quantity', 'Expiry date'],
    rows: activeInventory.map(item => [item.clinic_name || clinics.find(clinic => clinic.id === item.clinic_id)?.name || item.clinic_id || '-', item.type || '-', item.batch || '-', `${Number(item.quantity || 0)} doses`, item.expiry || '-']),
    totals: [['Active batches', activeInventory.length], ['Total doses', activeInventory.reduce((sum, item) => sum + Number(item.quantity || 0), 0)], ['Low / expired', activeInventory.filter(item => Number(item.quantity || 0) <= 15 || isExpired(item.expiry)).length]]
  };
  if (kind === 'risk') {
    const counts = new Map();
    caseRows.forEach(item => { const name = barangayFor(item); counts.set(name, (counts.get(name) || 0) + 1); });
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const highest = Math.max(1, ...rows.map(([, count]) => count));
    return {
      title: 'Barangay Risk Assessment', subtitle: 'Case-volume risk classification by barangay',
      headers: ['Barangay', 'Reported cases', 'Risk classification'],
      rows: rows.map(([name, count]) => [name, count, count / highest >= .66 ? 'High' : count / highest >= .33 ? 'Medium' : 'Low']),
      totals: [['Barangays assessed', rows.length], ['High-risk barangays', rows.filter(([, count]) => count / highest >= .66).length], ['Reported cases', rows.reduce((sum, [, count]) => sum + count, 0)]]
    };
  }
  return null;
}

function openReportPreview(kind) {
  try {
    const range = reportRange();
    const report = reportDefinition(kind, range);
    const documentEl = document.getElementById('reportPreviewDocument');
    const modal = document.getElementById('reportPreviewModal');
    if (!report || !documentEl || !modal) throw new Error('The report preview is unavailable. Please refresh and try again.');
    const table = report.rows.length
      ? `<table><thead><tr>${report.headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${report.rows.map(row => `<tr>${row.map(value => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : '<p class="report-empty">No records match this report and date range.</p>';
    documentEl.innerHTML = `<header class="report-document-header"><div><div class="report-brand"><i class="fa-solid fa-shield-virus"></i> Anti-Rabies Locator</div><h1>${escapeHtml(report.title)}</h1><p>${escapeHtml(report.subtitle)}</p></div><div class="report-generated">Cabuyao, Laguna<br>Coverage: ${escapeHtml(range.label)}<br>Generated: ${escapeHtml(new Date().toLocaleString())}</div></header><section class="report-summary">${report.totals.map(([label, value]) => `<div class="report-summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</section><h2>Report details</h2>${table}<footer class="report-footer"><span>Anti-Rabies Locator System</span><span>Administrator report</span></footer>`;
    document.getElementById('reportPreviewTitle').textContent = report.title;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
  } catch (error) {
    alert(`Could not prepare report preview: ${error.message}`);
  }
}

function closeReportPreview() {
  const modal = document.getElementById('reportPreviewModal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}
