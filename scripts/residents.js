import { auth, db, fetchUserProfile, onAuthStateChanged, signOutUser } from './firebase.js';
import { doc, getDoc, collection, query, where, getDocs, addDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

let currentUid = null;
let currentResidentName = '';
let selectedClinic = null;

function markAllRead() {
  document.querySelectorAll('.notif-item.unread').forEach(item => {
    item.classList.remove('unread');
    const dot = item.querySelector('.unread-dot');
    if (dot) dot.remove();
  });

  const unread = document.getElementById('unreadCount');
  if (unread) unread.textContent = '0';
}

function filterNotifs(type, btn) {
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const items = document.querySelectorAll('.notif-item');
  let visible = 0;

  items.forEach(item => {
    if (type === 'all' || item.dataset.type === type) {
      item.style.display = 'flex';
      visible++;
    } else {
      item.style.display = 'none';
    }
  });

  const emptyState = document.getElementById('emptyState');
  if (emptyState) emptyState.style.display = visible === 0 ? 'block' : 'none';

  document.querySelectorAll('.notif-group-label').forEach(g => {
    g.style.display = type === 'all' ? 'block' : 'none';
  });
}

window.markAllRead = markAllRead;
window.filterNotifs = filterNotifs;

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
  loadResidentBookings(uid);
}

function populateClinicOptions(clinics) {
  const select = document.getElementById('modalClinic');
  if (select) {
    select.innerHTML = '';
    clinics.forEach((clinic) => {
      const option = document.createElement('option');
      option.value = clinic.id;
      option.textContent = `${clinic.name} - ${clinic.status === 'out' ? 'Out of Stock' : clinic.status === 'low' ? 'Low Stock' : 'Available'}`;
      option.dataset.name = clinic.name;
      select.appendChild(option);
    });
  }
  renderClinicBookingList(clinics);
}

window.populateClinicOptions = populateClinicOptions;
if (window.clinicDirectory) populateClinicOptions(window.clinicDirectory);

function renderClinicBookingList(clinics) {
  const list = document.getElementById('clinicBookingList');
  if (!list) return;
  if (!clinics.length) {
    list.innerHTML = '<p style="padding:16px;color:#6b7280;">No clinics are available yet.</p>';
    return;
  }

  list.innerHTML = clinics.map((clinic) => {
    const isOut = clinic.status === 'out';
    const isLow = clinic.status === 'low';
    const color = isOut ? '#ef4444' : isLow ? '#d97706' : '#16a34a';
    const background = isOut ? '#fee2e2' : isLow ? '#fef3c7' : '#dcfce7';
    const statusText = isOut ? 'Out of stock' : isLow ? 'Low stock' : `${clinic.stock_total || 0} doses available`;
    return `
      <div class="clinic-row">
        <div class="clinic-row-icon" style="background:${background};"><i class="fa-solid fa-hospital" style="color:${color};"></i></div>
        <div class="clinic-row-info">
          <h4>${escapeHtml(clinic.name)}</h4>
          <p>${escapeHtml(clinic.address || 'Address not provided')} &nbsp;|&nbsp; ${escapeHtml(clinic.hours || 'Hours not provided')} &nbsp;|&nbsp; <strong style="color:${color};">${statusText}</strong></p>
        </div>
        <button class="book-btn dynamic-book-btn" data-clinic-id="${escapeHtml(clinic.id)}" ${isOut ? 'disabled' : ''}>${isOut ? 'Unavailable' : 'Book Now'}</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.dynamic-book-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const clinic = clinics.find(item => item.id === button.dataset.clinicId);
      if (clinic) openBookingModal(clinic.name, clinic.id);
    });
  });
}

async function loadResidentBookings(uid) {
  const container = document.getElementById('residentBookings');
  if (!container) return;
  try {
    onSnapshot(query(collection(db, 'appointments'), where('resident_uid', '==', uid)), (snapshot) => {
      const bookings = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .filter(item => ['pending', 'confirmed'].includes(item.status))
        .sort((a, b) => `${a.preferred_date} ${a.preferred_time}`.localeCompare(`${b.preferred_date} ${b.preferred_time}`));

      if (!bookings.length) {
        container.innerHTML = '';
        return;
      }

      container.innerHTML = `
      <div style="background:#fff;border:1px solid #ddd;border-radius:14px;padding:18px;">
        <h3 style="margin:0 0 12px;color:#111827;"><i class="fa-regular fa-calendar-check" style="color:#ef0000;margin-right:8px;"></i>Upcoming Bookings</h3>
        ${bookings.map(booking => `
          <div style="display:flex;justify-content:space-between;gap:16px;align-items:center;padding:12px 0;border-top:1px solid #f1f1f1;flex-wrap:wrap;">
            <div><strong>${escapeHtml(booking.clinic_name || 'Clinic')}</strong><div style="font-size:13px;color:#6b7280;">${escapeHtml(booking.preferred_date)} at ${escapeHtml(booking.preferred_time)} · ${escapeHtml(booking.dose_label || 'Dose 1')}</div></div>
            <span style="padding:5px 10px;border-radius:14px;font-size:12px;font-weight:700;background:${booking.status === 'confirmed' ? '#dcfce7' : '#fef3c7'};color:${booking.status === 'confirmed' ? '#15803d' : '#92400e'};">${booking.status === 'confirmed' ? 'Confirmed' : 'Waiting for clinic'}</span>
          </div>`).join('')}
      </div>`;
    }, (error) => console.error('Failed to listen for resident bookings:', error));
  } catch (error) {
    console.error('Failed to load resident bookings:', error);
  }
}

function escapeHtml(value = '') {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
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
  // If the Overview panel contains maps, refresh them after layout changes
  if (tab === 'overview' && window.refreshMaps) setTimeout(() => window.refreshMaps(), 150);
  // Make sure the first aid and notifications panels stay visible when selected
  if ((tab === 'firstaid' || tab === 'notifications') && panel) panel.classList.add('active');
  // Ensure one of the appointments sub-views is visible when opening Appointments
  if (tab === 'appointments') {
    const newEl = document.getElementById('appt-new-resident');
    const activeEl = document.getElementById('appt-active-patient');
    if (newEl && activeEl) {
      const newVis = window.getComputedStyle(newEl).display;
      const actVis = window.getComputedStyle(activeEl).display;
      if (newVis === 'none' && actVis === 'none') {
        // default to new resident view
        newEl.style.display = 'block';
        activeEl.style.display = 'none';
      }
    }
  }
}

// Note: functions used by inline `onclick` will be exposed to `window` after they are defined,
// inside DOMContentLoaded, so HTML inline handlers continue working with module scripts.

function openBookingModal(clinic, clinicId = '') {
  const sel = document.getElementById('modalClinic');
  if (sel && clinicId) {
    sel.value = clinicId;
  } else if (clinic && sel) {
    const option = [...sel.options].find(item => item.dataset.name === clinic || item.text.startsWith(clinic));
    if (option) sel.value = option.value;
  }
  selectedClinic = window.clinicDirectory?.find(item => item.id === sel?.value) || null;
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
  const clinicSelect = document.getElementById('modalClinic');
  const clinicId = clinicSelect.value;
  const clinic = window.clinicDirectory?.find(item => item.id === clinicId) || selectedClinic;
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

  if (!clinic) {
    msgEl.style.display = 'block';
    msgEl.textContent = 'Please select a clinic from the map first.';
    return;
  }

  try {
    const appointmentRef = await addDoc(collection(db, 'appointments'), {
      resident_uid: currentUid,
      resident_name: currentResidentName,
      clinic_id: clinic.id,
      clinic_name: clinic.name,
      clinic_staff_uid: clinic.staff_uid || '',
      dose_label: dose,
      preferred_date: date,
      preferred_time: time,
      status: 'pending',
      created_at: serverTimestamp()
    });

    if (clinic.staff_uid) {
      await addDoc(collection(db, 'notifications'), {
        recipient_uid: clinic.staff_uid,
        user_id: clinic.staff_uid,
        clinic_id: clinic.id,
        appointment_id: appointmentRef.id,
        type: 'appointment',
        title: 'New appointment request',
        message: `${currentResidentName} requested an appointment on ${date} at ${time}.`,
        read: false,
        created_at: serverTimestamp()
      });
    }

    msgEl.style.display = 'block';
    msgEl.style.background = '#f0fdf4';
    msgEl.style.color = '#16a34a';
    msgEl.style.border = '1px solid #bbf7d0';
    msgEl.textContent = 'Appointment booked! Waiting for clinic confirmation.';

    setTimeout(() => {
      closeBookingModal();
      loadResidentBookings(currentUid);
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
    signOutUser().then(() => window.location.href = 'login.html');
  });

  // Expose some functions to window for inline onclick attributes (module scope isn't global)
  window.showTab = showTab;
  window.openBookingModal = openBookingModal;
  window.closeBookingModal = closeBookingModal;
  window.confirmBooking = confirmBooking;
  window.filterMap = filterMap;
  window.handleUpload = handleUpload;
  window.toggleResRow = toggleResRow;

  onAuthStateChanged(auth, (user) => {
    if (user) {
      fetchUserProfile(user.uid).then((profile) => {
        if (!profile || profile.role !== 'resident') {
          alert('This account does not have resident access.');
          signOutUser().then(() => window.location.href = 'login.html');
          return;
        }
        loadResidentDashboard(user.uid);
      });
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