import { auth, db, fetchUserProfile } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import {
  collection, doc, onSnapshot, serverTimestamp, setDoc, updateDoc
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

const YEAR = 2026;
let appointments = [];
let vaccinations = [];
let residents = new Map();
let users = [];
let clinics = [];
let inventory = [];

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
  }, reportError);
  onSnapshot(collection(db, 'clinics'), snapshot => {
    clinics = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderManagement();
  }, reportError);
  onSnapshot(collection(db, 'inventory'), snapshot => {
    inventory = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderManagement();
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

function currentYear(record) {
  return recordDate(record)?.getFullYear() === YEAR;
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

function renderAnalytics() {
  const cases = appointments.filter(item => currentYear(item) && item.status !== 'declined');
  const yearVaccinations = vaccinations.filter(currentYear);
  const monthlyCases = Array(12).fill(0);
  const monthlyVaccinations = Array(12).fill(0);
  const animalCounts = new Map();
  const barangayMap = new Map();
  const ageGroups = [0, 0, 0, 0, 0];

  cases.forEach(item => {
    const date = recordDate(item);
    if (date) monthlyCases[date.getMonth()]++;
    const animal = String(item.animal_type || 'Others').trim() || 'Others';
    animalCounts.set(animal, (animalCounts.get(animal) || 0) + 1);
    const barangay = barangayFor(item);
    const row = barangayMap.get(barangay) || { name: barangay, cases: 0, vaccinations: 0, completed: 0 };
    row.cases++;
    if (item.status === 'completed' || item.outcome === 'completed') row.completed++;
    barangayMap.set(barangay, row);
    const age = ageFor(item);
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
  const completed = new Set(cases.filter(item => item.status === 'completed' || item.outcome === 'completed').map(item => item.id));
  yearVaccinations.forEach(item => { if (item.appointment_id) completed.add(item.appointment_id); });
  const isDeath = item => ['death', 'deceased', 'fatal'].includes(String(item.outcome || item.status || '').toLowerCase());
  const deaths = cases.filter(isDeath).length;
  const ongoing = cases.filter(item => !isDeath(item) && !completed.has(item.id)).length;
  const summary = {
    monthlyCases,
    monthlyVaccinations,
    barangays,
    caseTrend: monthlyCases.map(value => value ? Math.round(value / Math.max(1, ...monthlyCases) * 100) : 0),
    ageGroups,
    animals,
    totalCases: cases.length,
    totalVaccinations: yearVaccinations.length,
    activePatients: new Set(cases.filter(item => !completed.has(item.id)).map(item => item.resident_uid)).size,
    completed: completed.size,
    ongoing,
    deaths,
    highRiskBarangays: barangays.filter(item => item.cases / maxCases >= 0.66).length
  };
  updateDashboard(summary, maxCases);
  setDoc(doc(db, 'system_settings', 'live_analytics'), { ...summary, updated_at: serverTimestamp() }, { merge: true }).catch(reportError);
}

function updateDashboard(data, maxCases) {
  setText('statTotalCases', data.totalCases);
  setText('statTotalVaccinations', data.totalVaccinations);
  setText('statActivePatients', data.activePatients);
  setText('statHighRiskBarangays', data.highRiskBarangays);
  setText('statOngoingCases', data.ongoing);
  setText('statCompletedCases', data.completed);
  setText('statDeaths', data.deaths);
  if (window.adminMonthlyChart) {
    window.adminMonthlyChart.data.datasets[0].data = data.monthlyCases;
    window.adminMonthlyChart.data.datasets[1].data = data.monthlyVaccinations;
    window.adminMonthlyChart.update();
  }
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
  const pending = staff.filter(user => user.is_active === false || user.approval_status === 'pending' || user.status === 'pending');
  setText('userTotalResidents', users.filter(user => user.role === 'resident').length || residents.size);
  setText('userClinicStaff', staff.length);
  setText('userPendingApproval', pending.length);
  setText('userTotalClinics', clinics.length);

  const pendingGrid = document.getElementById('pendingStaffGrid');
  if (pendingGrid) {
    pendingGrid.innerHTML = pending.length ? pending.map(user => `<div class="user-card">
      <div class="user-avatar" style="background:#dbeafe;color:#2563eb;"><i class="fa-solid fa-user-nurse"></i></div>
      <h4>${escapeHtml(user.full_name || user.email || 'Clinic Staff')}</h4>
      <p>${escapeHtml(user.clinic_name || user.clinic_id || 'Clinic not assigned')}<br>Created ${formatDate(user.created_at)}</p>
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
      const location = user.role === 'resident' ? residents.get(user.id)?.barangay || '-' : user.clinic_name || user.clinic_id || '-';
      return `<tr><td><strong>${escapeHtml(user.full_name || user.email || 'User')}</strong></td><td>${escapeHtml(user.role || '-')}</td><td>${escapeHtml(location)}</td><td><span class="status ${active ? 'adequate' : 'critical'}">${active ? 'Active' : 'Inactive'}</span></td><td>${formatDate(user.last_active_at || user.updated_at || user.created_at)}</td><td><span class="update-link">Live</span></td></tr>`;
    }).join('') : '<tr><td colspan="6">No users found.</td></tr>';
  }

  const clinicBody = document.getElementById('clinicsBody');
  if (clinicBody) {
    clinicBody.innerHTML = clinics.length ? clinics.map(clinic => {
      const stock = inventory.filter(item => item.clinic_id === clinic.id);
      const totalStock = stock.reduce((total, item) => total + Number(item.quantity || 0), 0);
      const status = totalStock === 0 ? ['critical', 'Out of Stock'] : totalStock <= 15 ? ['low', 'Low Stock'] : ['adequate', 'Available'];
      const updated = [...stock, clinic].map(item => item.updated_at || item.created_at).sort((first, second) => timestampValue(second) - timestampValue(first))[0];
      return `<tr><td><strong>${escapeHtml(clinic.name || 'Unnamed Clinic')}</strong></td><td>${escapeHtml(clinic.type || 'ABTC')}</td><td>${escapeHtml(clinic.barangay || clinic.address || '-')}</td><td>${totalStock} doses</td><td><span class="status ${status[0]}">${status[1]}</span></td><td>${formatDate(updated)}</td><td><span class="update-link">Live</span></td></tr>`;
    }).join('') : '<tr><td colspan="7">No clinics found.</td></tr>';
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
