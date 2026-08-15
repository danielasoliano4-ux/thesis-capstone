import { auth, db } from './firebase.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import {
  collection, query, where, orderBy, getDocs,
  doc, updateDoc, addDoc, serverTimestamp, getDoc
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

let pendingCount = 0;

async function loadAppointments() {
  const list = document.getElementById('apptList');
  list.innerHTML = '<p style="color:#6b7280;padding:16px;">Loading appointments…</p>';

  const snap = await getDocs(
    query(collection(db, 'appointments'), where('status', '==', 'pending'), orderBy('created_at', 'asc'))
  );

  if (snap.empty) {
    list.innerHTML = '<p style="color:#6b7280;padding:16px;"><i class="fa-solid fa-circle-check" style="color:#22c55e;margin-right:6px;"></i>No pending appointments.</p>';
    document.getElementById('pendingCount').textContent = 0;
    document.getElementById('pendingCount').style.background = '#22c55e';
    return;
  }

  pendingCount = snap.size;
  document.getElementById('pendingCount').textContent = pendingCount;
  list.innerHTML = '';

  snap.forEach(docSnap => {
    const d = docSnap.data();
    const card = buildApptCard(docSnap.id, d);
    list.appendChild(card);
  });
}

function buildApptCard(id, d) {
  const card = document.createElement('div');
  card.className = 'appt-card';
  card.id = 'apptCard-' + id;
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

  onAuthStateChanged(auth, (user) => {
    if (user) {
      loadAppointments();
    } else {
      window.location.href = 'login.html';
    }
  });
});