import { auth, db } from '../firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc, collection, query, where, orderBy, getDocs, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let currentUid = null;
let currentResidentName = '';

async function loadResidentDashboard(uid) {
  currentUid = uid;
  const residentDoc = await getDoc(doc(db, 'residents', uid));
  const residentData = residentDoc.exists() ? residentDoc.data() : {};

  // Prefer resident's first/last name; fall back to users.full_name or auth displayName
  if (residentData.first_name) {
    currentResidentName = residentData.first_name + ' ' + (residentData.last_name || '');
  } else {
    const userDoc = await getDoc(doc(db, 'users', uid));
    if (userDoc.exists() && userDoc.data().full_name) {
      currentResidentName = userDoc.data().full_name;
    } else if (auth.currentUser && auth.currentUser.displayName) {
      currentResidentName = auth.currentUser.displayName;
    }
  }

  const headerName = document.getElementById('headerName');
  if (headerName && currentResidentName) headerName.textContent = currentResidentName;

  const recordsSnap = await getDocs(
    query(collection(db, 'vaccination_records'), where('resident_uid', '==', uid), orderBy('date_given', 'desc'))
  );

  const hasRecord = !recordsSnap.empty;
  const latestRecord = hasRecord ? recordsSnap.docs[0].data() : null;

  initView(hasRecord, latestRecord);
}

function initView(hasRecord, latestRecord) {
  if (hasRecord) {
    document.getElementById('view-new').style.display = 'none';
    document.getElementById('view-active').style.display = 'block';
    document.getElementById('nav-records').style.display = 'flex';
    document.getElementById('appt-new-resident').style.display = 'none';
    document.getElementById('appt-active-patient').style.display = 'block';
    document.getElementById('notifDot').style.display = 'block';
    document.getElementById('notifBadge').style.display = 'inline';
    if (latestRecord) populateActivePatientData(latestRecord);
  } else {
    document.getElementById('view-new').style.display = 'block';
    document.getElementById('view-active').style.display = 'none';
    document.getElementById('nav-records').style.display = 'none';
    document.getElementById('panel-records').style.display = 'none';
    document.getElementById('appt-new-resident').style.display = 'block';
    document.getElementById('appt-active-patient').style.display = 'none';
    setTimeout(renderCasesChart, 150);
  }
}

function populateActivePatientData(data) {
  const doses = data.dose_number || 1;
  const total = 5;
  const pct = Math.round((doses / total) * 100);
  if (document.getElementById('activeDosesCount')) document.getElementById('activeDosesCount').textContent = doses;
  if (document.getElementById('progressLabel')) document.getElementById('progressLabel').textContent = `Treatment Progress — ${doses} of ${total} doses`;
  if (document.getElementById('progressBar')) document.getElementById('progressBar').style.width = pct + '%';
  if (document.getElementById('progressPct')) document.getElementById('progressPct').textContent = pct + '% Complete';
  if (document.getElementById('recordPct')) document.getElementById('recordPct').textContent = pct + '%';
  if (document.getElementById('recordDoses')) document.getElementById('recordDoses').textContent = `${doses} / ${total} doses`;
  for (let i = 1; i <= 5; i++) {
    const pip = document.getElementById('pip' + i);
    if (!pip) continue;
    if (i <= doses) pip.className = 'dose-pip done';
    else if (i === doses + 1) pip.className = 'dose-pip current';
    else pip.className = 'dose-pip';
  }
  if (data.resident_name && document.getElementById('recordName')) document.getElementById('recordName').textContent = data.resident_name;
  if (data.vaccine_name && document.getElementById('recordVaccine')) document.getElementById('recordVaccine').textContent = data.vaccine_name;
  if (data.clinic_name && document.getElementById('recordStart')) document.getElementById('recordStart').textContent = data.clinic_name;
  if (data.next_due_date) {
    const nextDate = data.next_due_date.toDate ? data.next_due_date.toDate().toLocaleDateString() : data.next_due_date;
    if (document.getElementById('activeNextAppt')) document.getElementById('activeNextAppt').textContent = nextDate;
    if (document.getElementById('nextDoseLabel')) document.getElementById('nextDoseLabel').innerHTML = `<i class="fa-regular fa-calendar"></i> Next: Dose ${doses + 1} on ${nextDate}`;
  }
}

function renderCasesChart() {
  const ctx = document.getElementById('monthlyChart');
  if (!ctx || !window.Chart) return;
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
      datasets: [
        { label: 'Rabies Cases', data: [12, 18, 15, 22, 19, 24, 17], backgroundColor: 'rgba(239,0,0,0.75)', borderRadius: 4, borderSkipped: false },
        { label: 'Vaccinations', data: [45, 62, 55, 80, 72, 95, 53], backgroundColor: 'rgba(52,211,153,0.75)', borderRadius: 4, borderSkipped: false }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'top', labels: { font: { size: 11 }, padding: 10 } } },
      scales: {
        y: { beginAtZero: true, grid: { color: '#f3f4f6' }, ticks: { font: { size: 11 } } },
        x: { grid: { display: false }, ticks: { font: { size: 11 } } }
      }
    }
  });
}

function renderResVizChart() {
  const ctx = document.getElementById('resVizChart');
  if (!ctx || !window.Chart) return;
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul'],
      datasets: [
        { label:'Rabies Cases', data:[12,18,15,22,19,24,17], backgroundColor:'rgba(239,0,0,0.75)', borderRadius:4 },
        { label:'Vaccinations', data:[45,62,55,80,72,95,53], backgroundColor:'rgba(52,211,153,0.75)', borderRadius:4 }
      ]
    },
    options: {
      responsive:true,
      plugins:{ legend:{ position:'top', labels:{ font:{size:11}, padding:10 } } },
      scales:{
        y:{ beginAtZero:true, grid:{color:'#f3f4f6'}, ticks:{font:{size:11}} },
        x:{ grid:{display:false}, ticks:{font:{size:11}} }
      }
    }
  });
}

function showTab(tab, el) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const panel = document.getElementById('panel-' + tab);
  if (panel) panel.classList.add('active');
  if (el) el.classList.add('active');
}

function openBookingModal(clinic) {
  const sel = document.getElementById('modalClinic');
  if (clinic && sel) {
    for (let o of sel.options) {
      if (o.text.startsWith(clinic)) { sel.value = o.value; break; }
    }
  }
  const dateEl = document.getElementById('modalDate');
  if (dateEl && !dateEl.value) {
    const today = new Date().toISOString().split('T')[0];
    dateEl.value = today;
    dateEl.min = today;
  }
  document.getElementById('bookingModal').classList.add('open');
}

function closeBookingModal() {
  document.getElementById('bookingModal').classList.remove('open');
}

async function confirmBooking() {
  const clinic = document.getElementById('modalClinic').value;
  const dose = document.getElementById('modalDose').value;
  const date = document.getElementById('modalDate').value;
  const time = document.getElementById('modalTime').value;
  const msgEl = document.getElementById('bookingMsg');

  if (!date) {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = 'Please select a preferred date.';
    return;
  }

  const btn = document.querySelector('.modal-submit');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Booking...';

  try {
    await addDoc(collection(db, 'appointments'), {
      resident_uid: currentUid,
      resident_name: currentResidentName,
      clinic_name: clinic,
      dose_label: dose,
      preferred_date: date,
      preferred_time: time,
      status: 'pending',
      created_at: serverTimestamp()
    });

    msgEl.style.display = 'block';
    msgEl.style.background = '#f0fdf4';
    msgEl.style.color = '#16a34a';
    msgEl.style.border = '1px solid #bbf7d0';
    msgEl.textContent = 'Appointment booked! Waiting for clinic confirmation.';

    setTimeout(() => {
      closeBookingModal();
      msgEl.style.display = 'none';
    }, 2000);
  } catch (err) {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = 'Booking failed: ' + err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Booking';
  }
}

function filterMap(btn) {
  document.querySelectorAll('.map-filter button').forEach(b => b.classList.remove('active-btn'));
  btn.classList.add('active-btn');
}

function handleUpload(input) {
  if (input.files.length) alert('File "' + input.files[0].name + '" selected for upload. (Demo mode)');
}

function toggleResRow(row) {
  const next = row.nextElementSibling;
  const icon = row.querySelector('.fa-chevron-down, .fa-chevron-up');
  const isOpen = next.style.display === 'table-row';
  document.querySelectorAll('.res-accordion-detail').forEach(d => d.style.display = 'none');
  document.querySelectorAll('.res-accordion-row i.fa-chevron-up').forEach(i => {
    i.className = i.className.replace('fa-chevron-up','fa-chevron-down');
  });
  if (!isOpen) {
    next.style.display = 'table-row';
    if (icon) icon.className = icon.className.replace('fa-chevron-down','fa-chevron-up');
  }
}

let resCurrentFilter = 'all';
function resSetFilter(filter, btn) {
  resCurrentFilter = filter;
  document.querySelectorAll('.res-filter-btn').forEach(b => b.classList.remove('active-filter'));
  btn.classList.add('active-filter');
  resApplyFilter();
}
function resFilterRecords(q) { resApplyFilter(q.toLowerCase().trim()); }
function resApplyFilter(q = '') {
  const rows = document.querySelectorAll('#resTbody .res-accordion-row');
  let shown = 0;
  rows.forEach(row => {
    const outcome = row.dataset.outcome || '';
    const text = row.textContent.toLowerCase();
    const matchFilter = resCurrentFilter === 'all' || outcome === resCurrentFilter;
    const matchSearch = !q || text.includes(q);
    const show = matchFilter && matchSearch;
    row.style.display = show ? '' : 'none';
    const detail = row.nextElementSibling;
    if (detail && detail.classList.contains('res-accordion-detail')) {
      if (!show) detail.style.display = 'none';
    }
    if (show) shown++;
  });
  document.getElementById('resRecordsCount').textContent = 'Showing ' + shown + ' of 5 records';
}

document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('bookingModal').addEventListener('click', function(e) {
    if (e.target === this) closeBookingModal();
  });

  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', () => {
    signOut(auth).then(() => window.location.href = 'login.html');
  });

  onAuthStateChanged(auth, (user) => {
    if (user) {
      loadResidentDashboard(user.uid);
    } else {
      window.location.href = 'login.html';
    }
  });

  if (location.hash === '#panel-appointments') {
    const apptTab = document.querySelectorAll('.nav-tab')[1];
    if (apptTab) showTab('appointments', apptTab);
  }
  renderCasesChart();
  setTimeout(renderResVizChart, 300);
});