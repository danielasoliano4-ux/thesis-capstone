import { auth, db, fetchUserProfile } from './firebase.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import {
  collection, query, where, orderBy, getDocs,
  doc, updateDoc, addDoc, serverTimestamp, getDoc
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

let pendingCount = 0;
let currentClinicId = null;

async function loadPatients() {
  const grid = document.getElementById('patientsGrid');
  grid.innerHTML = '<p style="color:#6b7280;padding:16px;">Loading patients…</p>';

  try {
    console.log('Current clinic ID:', currentClinicId);
    
    if (!currentClinicId) {
      throw new Error('Clinic ID not loaded. Please refresh the page.');
    }

    const appointments = await getDocs(query(
      collection(db, 'appointments'),
      where('clinic_id', '==', currentClinicId)
    ));

    console.log('Appointments found:', appointments.size);

    const uniqueResidents = new Map();
    for (const apptDoc of appointments.docs) {
      const appt = apptDoc.data();
      console.log('Processing appointment:', appt.resident_name, appt.resident_uid);
      
      if (!uniqueResidents.has(appt.resident_uid)) {
        try {
          const vaccinationSnap = await getDocs(query(
            collection(db, 'vaccination_records'),
            where('resident_uid', '==', appt.resident_uid)
          ));
          console.log('Vaccination records for', appt.resident_uid, ':', vaccinationSnap.size);
          const doses = Math.max(0, ...vaccinationSnap.docs.map(v => Number(v.data().dose_number || 0)));
          uniqueResidents.set(appt.resident_uid, {
            name: appt.resident_name,
            uid: appt.resident_uid,
            doses,
            nextAppt: appt.preferred_date,
            appointments: []
          });
        } catch (vaccErr) {
          console.warn('Could not load vaccination records for', appt.resident_uid, ':', vaccErr.message);
          uniqueResidents.set(appt.resident_uid, {
            name: appt.resident_name,
            uid: appt.resident_uid,
            doses: 0,
            nextAppt: appt.preferred_date,
            appointments: []
          });
        }
      }
      uniqueResidents.get(appt.resident_uid).appointments.push({ id: apptDoc.id, ...appt });
    }

    if (!uniqueResidents.size) {
      grid.innerHTML = '<p style="color:#6b7280;padding:16px;"><i class="fa-solid fa-circle-check" style="color:#22c55e;margin-right:6px;"></i>No patients with appointments.</p>';
      return;
    }

    grid.innerHTML = '';
    const colors = ['blue-tint', 'yellow-tint', 'green-tint', 'red-tint'];
    let colorIndex = 0;
    for (const resident of uniqueResidents.values()) {
      const pct = Math.round((resident.doses / 5) * 100);
      const tintClass = colors[colorIndex % colors.length];
      const completedBadge = resident.doses === 5 ? '<span class="completed-badge">Completed</span>' : '';
      const nextApptText = resident.doses < 5 ? `<div class="appointment-info"><i class="fa-regular fa-calendar"></i><span><strong>Next Appointment:</strong> ${resident.nextAppt}</span></div>` : '';
      const card = `
        <div class="patient-card ${tintClass}">
          <div class="patient-header">
            <div class="header-with-badge">
              <h3>${resident.name}</h3>
              ${completedBadge}
            </div>
          </div>
          <div class="treatment-section">
            <label>Treatment Progress</label>
            <div><span class="doses-badge">${resident.doses}/5 doses</span></div>
            <div class="progress-bar-container"><div class="progress-bar" style="width:${pct}%;"></div></div>
            <p class="progress-text">${pct}% Complete</p>
          </div>
          ${nextApptText}
          <button class="view-record-btn" data-resident-uid="${resident.uid}">View Full Record</button>
        </div>`;
      grid.innerHTML += card;
      colorIndex++;
    }


    grid.querySelectorAll('.view-record-btn').forEach(btn => btn.addEventListener('click', () => {
      const uid = btn.dataset.residentUid;
      const resident = uniqueResidents.get(uid);
      if (resident) openResidentRecord(resident);
    }));
  } catch (err) {
    console.error('Failed to load patients:', err);
    const errorMsg = err.message || err.code || 'Unknown error';
    grid.innerHTML = `<p style="color:#ef0000;padding:16px;"><strong>Error loading patients:</strong> ${errorMsg}</p><p style="color:#666;padding:0 16px;font-size:12px;">Check browser console for details.</p>`;
  }
}

function openResidentRecord(resident) {
  const modal = document.getElementById('recordModal');
  const details = document.getElementById('recordDetails');
  details.innerHTML = `<p><strong>${resident.name}</strong><br>Doses: ${resident.doses}/5</p>`;
  modal.style.display = 'block';
}

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
      const staff = await fetchUserProfile(user.uid);
      currentClinicId = staff?.clinic_id || user.uid;
      await loadAppointments();
      await loadPatients();
    } else {
      window.location.href = 'login.html';
    }
  });
});

function displayValue(value) {
  return value === null || value === undefined || value === '' ? 'Not provided' : escapeHtml(String(value));
}

async function openRecordModal(id) {
  try {
    const appointmentSnap = await getDoc(doc(db, 'appointments', id));
    if (!appointmentSnap.exists()) {
      alert('This patient record is no longer available.');
      return;
    }
    const appointment = appointmentSnap.data();
    document.getElementById('recordAppointmentId').value = id;
    document.getElementById('recordModalTitle').textContent = `${appointment.resident_name || 'Resident'} — Full Record`;
    document.getElementById('recordDetails').innerHTML = `
      <div class="record-detail-grid">
        <div><strong>Address</strong><span>${displayValue(appointment.resident_address)}</span></div>
        <div><strong>Age</strong><span>${displayValue(appointment.patient_age)}</span></div>
        <div><strong>Sex</strong><span>${displayValue(appointment.patient_sex)}</span></div>
        <div><strong>Date of Bite</strong><span>${displayValue(appointment.bite_date)}</span></div>
        <div><strong>Animal</strong><span>${displayValue(appointment.animal_type)}</span></div>
        <div><strong>Body Part</strong><span>${displayValue(appointment.bite_body_part)}</span></div>
        <div><strong>Appointment</strong><span>${displayValue(appointment.preferred_date)} at ${displayValue(appointment.preferred_time)}</span></div>
        <div><strong>Dose</strong><span>${displayValue(appointment.dose_label)}</span></div>
        <div><strong>Category of Patient</strong><span>${displayValue(appointment.patient_category)}</span></div>
        <div><strong>Was the Bite Washed?</strong><span>${displayValue(appointment.wound_washed)}</span></div>
        <div><strong>Type of Bite</strong><span>${displayValue(appointment.bite_type)}</span></div>
      </div>`;
    document.getElementById('editAddress').value = appointment.resident_address || '';
    document.getElementById('editAge').value = appointment.patient_age ?? '';
    document.getElementById('editSex').value = appointment.patient_sex || '';
    document.getElementById('editBiteDate').value = appointment.bite_date || '';
    document.getElementById('editAnimal').value = appointment.animal_type || '';
    document.getElementById('editBitePart').value = appointment.bite_body_part || '';
    document.getElementById('recordCategory').value = appointment.patient_category || '';
    document.getElementById('recordWoundWashed').value = appointment.wound_washed || '';
    document.getElementById('recordBiteType').value = appointment.bite_type || '';
    document.getElementById('staffRecordForm').hidden = true;
    document.getElementById('editRecordBtn').hidden = false;
    const modal = document.getElementById('recordModal');
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
  } catch (error) {
    alert('Failed to load patient record: ' + error.message);
  }
}

function closeRecordModal() {
  const modal = document.getElementById('recordModal');
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
}

document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('recordModal');
  document.getElementById('closeRecordModalBtn').addEventListener('click', closeRecordModal);
  document.getElementById('editRecordBtn').addEventListener('click', () => {
    document.getElementById('staffRecordForm').hidden = false;
    document.getElementById('editRecordBtn').hidden = true;
  });
  document.getElementById('cancelEditBtn').addEventListener('click', () => {
    document.getElementById('staffRecordForm').hidden = true;
    document.getElementById('editRecordBtn').hidden = false;
  });
  modal.addEventListener('click', event => {
    if (event.target === modal) closeRecordModal();
  });
  document.getElementById('staffRecordForm').addEventListener('submit', async event => {
    event.preventDefault();
    const appointmentId = document.getElementById('recordAppointmentId').value;
    try {
      await updateDoc(doc(db, 'appointments', appointmentId), {
        resident_address: document.getElementById('editAddress').value.trim(),
        patient_age: document.getElementById('editAge').value ? Number(document.getElementById('editAge').value) : null,
        patient_sex: document.getElementById('editSex').value,
        bite_date: document.getElementById('editBiteDate').value,
        animal_type: document.getElementById('editAnimal').value.trim(),
        bite_body_part: document.getElementById('editBitePart').value.trim(),
        patient_category: document.getElementById('recordCategory').value,
        wound_washed: document.getElementById('recordWoundWashed').value,
        bite_type: document.getElementById('recordBiteType').value,
        assessed_by: auth.currentUser.uid,
        assessed_at: serverTimestamp()
      });
      closeRecordModal();
      document.getElementById('staffRecordForm').hidden = true;
      document.getElementById('editRecordBtn').hidden = false;
      showToast('Patient record saved.');
    } catch (error) {
      alert('Failed to save patient record: ' + error.message);
    }
  });
});

function escapeHtml(value = '') {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}