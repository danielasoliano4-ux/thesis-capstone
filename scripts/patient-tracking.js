import { auth, db, fetchUserProfile } from './firebase.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import {
  collection, query, where, orderBy, getDocs,
  doc, updateDoc, addDoc, serverTimestamp, getDoc
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

let pendingCount = 0;

async function loadAppointments() {
  const list = document.getElementById('apptList');
  list.innerHTML = '<p style="color:#6b7280;padding:16px;">Loading appointments…</p>';

  const staff = await fetchUserProfile(auth.currentUser.uid);
  const clinicId = staff?.clinic_id || auth.currentUser.uid;
  const snap = await getDocs(query(
    collection(db, 'appointments'),
    where('clinic_id', '==', clinicId),
    where('status', '==', 'pending')
  ));
  const pendingAppointments = snap.docs.sort((a, b) => {
    const first = a.data().created_at?.toMillis?.() || 0;
    const second = b.data().created_at?.toMillis?.() || 0;
    return first - second;
  });

  if (!pendingAppointments.length) {
    list.innerHTML = '<p style="color:#6b7280;padding:16px;"><i class="fa-solid fa-circle-check" style="color:#22c55e;margin-right:6px;"></i>No pending appointments.</p>';
    document.getElementById('pendingCount').textContent = 0;
    document.getElementById('pendingCount').style.background = '#22c55e';
    return;
  }

  pendingCount = pendingAppointments.length;
  document.getElementById('pendingCount').textContent = pendingCount;
  list.innerHTML = '';

  pendingAppointments.forEach(docSnap => {
    const d = docSnap.data();
    const card = buildApptCard(docSnap.id, d);
    list.appendChild(card);
  });
}

function buildApptCard(id, d) {
  const card = document.createElement('div');
  card.className = 'appt-card';
  card.id = 'apptCard-' + id;
  card.dataset.residentUid = d.resident_uid || '';
  card.dataset.clinicName = d.clinic_name || 'the clinic';
  card.dataset.date = d.preferred_date || '';
  card.dataset.time = d.preferred_time || '';
  card.innerHTML = `
    <div class="appt-avatar" id="apptAvatar-${id}">
      <i class="fa-solid fa-user"></i>
    </div>
    <div class="appt-info">
      <p class="patient-name">${d.resident_name || 'Unknown Resident'}</p>
      <p class="patient-meta">${d.preferred_date || ''} &nbsp;·&nbsp; ${d.preferred_time || ''}</p>
      <div class="appt-tags">
        <span class="tag tag-dose">${d.dose_label || 'Dose 1'}</span>
        <span class="tag tag-time"><i class="fa-regular fa-clock"></i> ${d.preferred_time || ''}</span>
        <span class="tag tag-vax">${d.clinic_name || ''}</span>
      </div>
    </div>
    <div class="appt-status-col">
      <span class="status-badge scheduled" id="badge-${id}">Pending</span>
      <button class="mark-btn" id="markBtn-${id}" onclick="window.confirmAppt('${id}')">
        <i class="fa-solid fa-circle-check"></i> Confirm
      </button>
      <button class="mark-btn" style="background:#fff;color:#ef0000;border:1px solid #ef0000;margin-top:4px;" onclick="window.declineAppt('${id}')">
        <i class="fa-solid fa-xmark"></i> Decline
      </button>
    </div>
  `;
  return card;
}

window.confirmAppt = async function(apptId) {
  const btn = document.getElementById('markBtn-' + apptId);
  const badge = document.getElementById('badge-' + apptId);
  const card = document.getElementById('apptCard-' + apptId);
  const avatar = document.getElementById('apptAvatar-' + apptId);

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating…';

  try {
    await updateDoc(doc(db, 'appointments', apptId), {
      status: 'confirmed',
      confirmed_at: serverTimestamp()
    });

    await addDoc(collection(db, 'notifications'), {
      recipient_uid: card.dataset.residentUid,
      user_id: card.dataset.residentUid,
      appointment_id: apptId,
      type: 'appointment',
      title: 'Appointment confirmed',
      message: `Your appointment at ${card.dataset.clinicName} on ${card.dataset.date} at ${card.dataset.time} was confirmed.`,
      read: false,
      created_at: serverTimestamp()
    });

    badge.textContent = 'Confirmed';
    badge.className = 'status-badge completed';
    card.classList.add('completed-card');
    avatar.style.background = '#f0fdf4';
    avatar.style.color = '#22c55e';
    btn.classList.add('done');
    btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Confirmed';

    pendingCount = Math.max(0, pendingCount - 1);
    document.getElementById('pendingCount').textContent = pendingCount;
    if (pendingCount === 0) document.getElementById('pendingCount').style.background = '#22c55e';

    showToast('Appointment confirmed! Resident has been notified.');
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Confirm';
    alert('Error: ' + err.message);
  }
};

window.declineAppt = async function(apptId) {
  if (!confirm('Decline this appointment?')) return;

  try {
    await updateDoc(doc(db, 'appointments', apptId), {
      status: 'declined',
      declined_at: serverTimestamp()
    });

    const card = document.getElementById('apptCard-' + apptId);
    const badge = document.getElementById('badge-' + apptId);
    badge.textContent = 'Declined';
    badge.className = 'status-badge';
    badge.style.background = '#fee2e2';
    badge.style.color = '#dc2626';
    card.style.opacity = '0.5';

    await addDoc(collection(db, 'notifications'), {
      recipient_uid: card.dataset.residentUid,
      user_id: card.dataset.residentUid,
      appointment_id: apptId,
      type: 'appointment',
      title: 'Appointment declined',
      message: `Your appointment request for ${card.dataset.date} was declined. Please choose another clinic or date.`,
      read: false,
      created_at: serverTimestamp()
    });

    pendingCount = Math.max(0, pendingCount - 1);
    document.getElementById('pendingCount').textContent = pendingCount;
    if (pendingCount === 0) document.getElementById('pendingCount').style.background = '#22c55e';

    showToast('Appointment declined.');
  } catch (err) {
    alert('Error: ' + err.message);
  }
};

function showToast(msg) {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMsg');
  if (toastMsg) toastMsg.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('todayDate').textContent =
    new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      await loadAppointments();
      loadActivePatients();
    } else {
      window.location.href = 'login.html';
    }
  });
});

async function loadActivePatients() {
  const grid = document.getElementById('patientsGrid');
  if (!grid || !auth.currentUser) return;
  const staff = await fetchUserProfile(auth.currentUser.uid);
  const clinicId = staff?.clinic_id || auth.currentUser.uid;
  const snapshot = await getDocs(query(
    collection(db, 'appointments'),
    where('clinic_id', '==', clinicId),
    where('status', '==', 'confirmed')
  ));
  if (snapshot.empty) return;
  grid.innerHTML = '';
  snapshot.docs.forEach((appointmentDoc) => {
    const appointment = appointmentDoc.data();
    const card = document.createElement('div');
    card.className = 'patient-card blue-tint';
    card.innerHTML = `
      <div class="patient-header"><h3>${escapeHtml(appointment.resident_name || 'Resident')}</h3><p class="patient-id">Appointment patient</p></div>
      <div class="treatment-section"><label>Appointment</label><div><span class="doses-badge">${escapeHtml(appointment.dose_label || 'Dose 1')}</span></div></div>
      <div class="appointment-info"><i class="fa-regular fa-calendar"></i><span><strong>Scheduled:</strong> ${escapeHtml(appointment.preferred_date)} at ${escapeHtml(appointment.preferred_time)}</span></div>
      <button class="view-record-btn" type="button">View Full Record</button>`;
    grid.appendChild(card);
  });
}

function escapeHtml(value = '') {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}