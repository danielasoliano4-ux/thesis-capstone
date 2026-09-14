import { auth, db, fetchUserProfile } from './firebase.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import {
  collection, query, where, orderBy, getDocs,
  doc, updateDoc, addDoc, serverTimestamp, getDoc, runTransaction
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

let pendingCount = 0;
let currentClinicId = null;
let activeAppointment = null;

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
    const clinicVaccinationSnap = await getDocs(query(
      collection(db, 'vaccination_records'),
      where('clinic_id', '==', currentClinicId)
    ));
    const clinicVaccinationRecords = clinicVaccinationSnap.docs.map(item => item.data());
    const appointmentDocs = [...appointments.docs].sort((first, second) => {
      const priority = { pending: 0, confirmed: 1, in_progress: 2, completed: 3, cancelled: 4, declined: 5 };
      return (priority[first.data().status] ?? 6) - (priority[second.data().status] ?? 6);
    });
    for (const apptDoc of appointmentDocs) {
      const appt = apptDoc.data();
      if (['pending', 'declined', 'cancelled'].includes(appt.status)) continue;
      console.log('Processing appointment:', appt.resident_name, appt.resident_uid);
      
      if (!uniqueResidents.has(appt.resident_uid)) {
        try {
          const recordsForAppointment = clinicVaccinationRecords.filter(record => record.resident_uid === appt.resident_uid
            && (!appt.vaccination_session_id || record.vaccination_session_id === appt.vaccination_session_id));
          const completedDoses = new Set(recordsForAppointment
            .map(record => Number(record.dose_number || 0))
            .filter(doseNumber => doseNumber >= 1 && doseNumber <= 5));
          const doses = completedDoses.size;
          uniqueResidents.set(appt.resident_uid, {
            name: appt.resident_name,
            uid: appt.resident_uid,
            doses,
            vaccinationSessionId: appt.vaccination_session_id || 'legacy',
            nextAppt: appt.preferred_date,
            appointments: []
          });
        } catch (vaccErr) {
          console.warn('Could not load vaccination records for', appt.resident_uid, ':', vaccErr.message);
          uniqueResidents.set(appt.resident_uid, {
            name: appt.resident_name,
            uid: appt.resident_uid,
            doses: 0,
            vaccinationSessionId: appt.vaccination_session_id || 'legacy',
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
      if (resident) {
        const appointment = resident.appointments.find(item => item.status === 'confirmed')
          || resident.appointments.find(item => item.status === 'pending')
          || resident.appointments[0];
        if (appointment?.id) openRecordModal(appointment.id);
      }
    }));
  } catch (err) {
    console.error('Failed to load patients:', err);
    const errorMsg = err.message || err.code || 'Unknown error';
    grid.innerHTML = `<p style="color:#ef0000;padding:16px;"><strong>Error loading patients:</strong> ${errorMsg}</p><p style="color:#666;padding:0 16px;font-size:12px;">Check browser console for details.</p>`;
  }
}

async function loadAppointments() {
  const list = document.getElementById('apptList');
  list.innerHTML = '<p style="color:#6b7280;padding:16px;">Loading appointments…</p>';

  const staff = await fetchUserProfile(auth.currentUser.uid);
  const clinicId = staff?.clinic_id || auth.currentUser.uid;
  const snap = await getDocs(query(
    collection(db, 'appointments'),
    where('clinic_id', '==', clinicId)
  ));
  const today = new Date().toISOString().split('T')[0];
  const scheduledAppointments = snap.docs.filter((appointment) => {
    const data = appointment.data();
    return ['confirmed', 'in_progress'].includes(data.status)
      && data.preferred_date === today;
  }).sort((a, b) => {
    const first = a.data().created_at?.toMillis?.() || 0;
    const second = b.data().created_at?.toMillis?.() || 0;
    return first - second;
  });

  if (!scheduledAppointments.length) {
    list.innerHTML = '<p style="color:#6b7280;padding:16px;"><i class="fa-solid fa-circle-check" style="color:#22c55e;margin-right:6px;"></i>No confirmed appointments scheduled for today.</p>';
    document.getElementById('pendingCount').textContent = 0;
    document.getElementById('pendingCount').style.background = '#22c55e';
    return;
  }

  pendingCount = scheduledAppointments.length;
  document.getElementById('pendingCount').textContent = pendingCount;
  list.innerHTML = '';

  scheduledAppointments.forEach(docSnap => {
    const d = docSnap.data();
    const card = buildScheduledApptCard(docSnap.id, d);
    list.appendChild(card);
    card.querySelector('.view-appt-details').addEventListener('click', () => openRecordModal(docSnap.id));
  });
}

function buildScheduledApptCard(id, d) {
  const card = document.createElement('div');
  card.className = 'appt-card';
  card.innerHTML = `
    <div class="appt-avatar"><i class="fa-solid fa-user"></i></div>
    <div class="appt-info">
      <p class="patient-name">${escapeHtml(d.resident_name || 'Unknown Resident')}</p>
      <p class="patient-meta">${escapeHtml(d.preferred_date || '')} &nbsp;·&nbsp; ${escapeHtml(d.preferred_time || '')}</p>
      <div class="appt-tags"><span class="tag tag-dose">${escapeHtml(d.dose_label || 'Dose 1')}</span><span class="tag tag-time"><i class="fa-regular fa-clock"></i> ${escapeHtml(d.preferred_time || '')}</span></div>
    </div>
    <div class="appt-status-col">
      <span class="status-badge scheduled">${escapeHtml(d.status || 'confirmed')}</span>
      <button class="mark-btn view-appt-details" type="button"><i class="fa-regular fa-id-card"></i> View Details</button>
    </div>`;
  return card;
}

function buildApptCard(id, d) {
  const card = document.createElement('div');
  card.className = 'appt-card';
  card.id = 'apptCard-' + id;
  card.dataset.residentUid = d.resident_uid || '';
  card.dataset.clinicName = d.clinic_name || 'the clinic';
  card.dataset.date = d.preferred_date || '';
  card.dataset.time = d.preferred_time || '';
  card.dataset.rescheduleRequested = d.reschedule_requested ? 'true' : 'false';
  card.innerHTML = `
    <div class="appt-avatar" id="apptAvatar-${id}">
      <i class="fa-solid fa-user"></i>
    </div>
    <div class="appt-info">
      <p class="patient-name">${d.resident_name || 'Unknown Resident'}</p>
      <p class="patient-meta">${d.preferred_date || ''}${d.reservation_end_date && d.reservation_end_date !== d.preferred_date ? ` to ${d.reservation_end_date}` : ''} &nbsp;·&nbsp; ${d.preferred_time || ''}</p>
      <div class="appt-tags">
        <span class="tag tag-dose">${d.dose_label || 'Dose 1'}</span>
        <span class="tag tag-time"><i class="fa-regular fa-clock"></i> ${d.preferred_time || ''}</span>
        <span class="tag tag-vax">${d.clinic_name || ''}</span>
      </div>
    </div>
    <div class="appt-status-col">
      <span class="status-badge scheduled" id="badge-${id}">Pending</span>
      <button class="mark-btn view-appt-details" type="button" style="background:#fff;color:#2563eb;border:1px solid #2563eb;margin-bottom:4px;">
        <i class="fa-regular fa-id-card"></i> View Details
      </button>
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
      reschedule_requested: false,
      confirmed_at: serverTimestamp()
    });

    await addDoc(collection(db, 'notifications'), {
      recipient_uid: card.dataset.residentUid,
      user_id: card.dataset.residentUid,
      appointment_id: apptId,
      type: 'appointment',
      title: card.dataset.rescheduleRequested === 'true' ? 'Reschedule Confirmed' : 'Appointment confirmed',
      message: card.dataset.rescheduleRequested === 'true'
        ? `Your rescheduled appointment at ${card.dataset.clinicName} on ${card.dataset.date} at ${card.dataset.time} was confirmed by the clinic.`
        : `Your appointment at ${card.dataset.clinicName} on ${card.dataset.date} at ${card.dataset.time} was confirmed.`,
      read: false,
      created_at: serverTimestamp()
    });

    await addDoc(collection(db, 'notifications'), {
      recipient_uid: card.dataset.residentUid,
      user_id: card.dataset.residentUid,
      appointment_id: apptId,
      type: 'appointment',
      title: 'Appointment Reminder',
      message: `Reminder: your appointment at ${card.dataset.clinicName} is scheduled for ${card.dataset.date} at ${card.dataset.time}. Please bring your vaccination card.`,
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
      const appointmentId = new URLSearchParams(window.location.search).get('appointment');
      if (appointmentId) openRecordModal(appointmentId);
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
    const residentSnap = appointment.resident_uid
      ? await getDoc(doc(db, 'residents', appointment.resident_uid))
      : null;
    const resident = residentSnap?.exists() ? residentSnap.data() : {};
    const relatedAppointmentsSnap = appointment.resident_uid && appointment.clinic_id
      ? await getDocs(query(
        collection(db, 'appointments'),
        where('clinic_id', '==', appointment.clinic_id),
        where('resident_uid', '==', appointment.resident_uid)
      ))
      : { docs: [] };
    const relatedAppointments = relatedAppointmentsSnap.docs.map(item => item.data());
    const firstWith = field => appointment[field] || relatedAppointments.find(item => item[field])?.[field] || '';
    const details = {
      ...appointment,
      resident_address: firstWith('resident_address') || resident.address,
      date_of_birth: firstWith('date_of_birth') || resident.birthday,
      patient_sex: firstWith('patient_sex') || resident.gender,
      bite_date: firstWith('bite_date'),
      animal_type: firstWith('animal_type'),
      bite_body_part: firstWith('bite_body_part'),
      patient_category: firstWith('patient_category'),
      wound_washed: firstWith('wound_washed'),
      bite_type: firstWith('bite_type'),
      valid_id_url: firstWith('valid_id_url'),
      valid_id_name: firstWith('valid_id_name'),
      valid_id_type: firstWith('valid_id_type')
    };
    activeAppointment = { id, ...details };
    document.getElementById('recordAppointmentId').value = id;
    document.getElementById('recordModalTitle').textContent = `${details.resident_name || 'Resident'} — Full Record`;
    const isImage = ['image/jpeg', 'image/png'].includes(details.valid_id_type) || /\.(jpe?g|png)$/i.test(details.valid_id_name || details.valid_id_url || '');
    const validIdMarkup = details.valid_id_url
      ? (isImage
        ? `<a href="${escapeHtml(details.valid_id_url)}" target="_blank" rel="noopener"><img class="record-id-preview" src="${escapeHtml(details.valid_id_url)}" alt="Uploaded valid ID"></a>`
        : `<a href="${escapeHtml(details.valid_id_url)}" target="_blank" rel="noopener">View uploaded ID${details.valid_id_name ? ` (${escapeHtml(details.valid_id_name)})` : ''}</a>`)
      : 'Not provided';
    document.getElementById('recordDetails').innerHTML = `
      <div class="record-detail-grid">
        <div><strong>Address</strong><span>${displayValue(details.resident_address)}</span></div>
        <div><strong>Date of Birth</strong><span>${displayValue(details.date_of_birth)}</span></div>
        <div><strong>Sex</strong><span>${displayValue(details.patient_sex)}</span></div>
        <div><strong>Date of Bite</strong><span>${displayValue(details.bite_date)}</span></div>
        <div><strong>Animal</strong><span>${displayValue(details.animal_type)}</span></div>
        <div><strong>Body Part</strong><span>${displayValue(details.bite_body_part)}</span></div>
        <div><strong>Valid ID</strong><span>${validIdMarkup}</span></div>
        <div><strong>Reservation</strong><span>${displayValue(details.preferred_date)}${details.reservation_end_date && details.reservation_end_date !== details.preferred_date ? ` to ${displayValue(details.reservation_end_date)}` : ''} at ${displayValue(details.preferred_time)}</span></div>
        <div><strong>Dose</strong><span>${displayValue(details.dose_label)}</span></div>
        <div><strong>Category of Patient</strong><span>${displayValue(details.patient_category)}</span></div>
        <div><strong>Was the Bite Washed?</strong><span>${displayValue(details.wound_washed)}</span></div>
        <div><strong>Type of Bite</strong><span>${displayValue(details.bite_type)}</span></div>
      </div>`;
    document.getElementById('editAddress').value = details.resident_address || '';
    document.getElementById('editDateOfBirth').value = details.date_of_birth || '';
    document.getElementById('editSex').value = details.patient_sex || '';
    document.getElementById('editBiteDate').value = details.bite_date || '';
    document.getElementById('editAnimal').value = details.animal_type || '';
    document.getElementById('editBitePart').value = details.bite_body_part || '';
    document.getElementById('recordCategory').value = details.patient_category || '';
    document.getElementById('recordWoundWashed').value = details.wound_washed || '';
    document.getElementById('recordBiteType').value = details.bite_type || '';
    document.getElementById('staffRecordForm').hidden = true;
    const completionForm = document.getElementById('doseCompletionForm');
    completionForm.hidden = appointment.status === 'completed' || appointment.status === 'declined';
    document.getElementById('completionAppointmentId').value = id;
    document.getElementById('completionDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('completionDose').value = Number(String(appointment.dose_label || '1').match(/\d+/)?.[0] || 1);
    document.getElementById('completionVaccine').value = appointment.vaccine_name || '';
    document.getElementById('completionLocation').value = appointment.clinic_address || '';
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
  document.getElementById('doseCompletionForm').addEventListener('submit', async event => {
    event.preventDefault();
    const appointmentId = document.getElementById('completionAppointmentId').value;
    const vaccineName = document.getElementById('completionVaccine').value.trim();
    const location = document.getElementById('completionLocation').value.trim();
    const doseNumber = Number(document.getElementById('completionDose').value);
    if (!activeAppointment || !vaccineName || !location || !Number.isInteger(doseNumber)) return;
    try {
      const inventorySnap = await getDocs(query(
        collection(db, 'inventory'),
        where('clinic_id', '==', currentClinicId)
      ));
      const inventoryItem = inventorySnap.docs.find(item => item.data().type === vaccineName && Number(item.data().quantity || 0) > 0);
      if (!inventoryItem) {
        throw new Error(`This clinic has no available inventory for ${vaccineName}.`);
      }
      const existingRecordSnap = await getDocs(query(
        collection(db, 'vaccination_records'),
        where('resident_uid', '==', activeAppointment.resident_uid),
        where('dose_number', '==', doseNumber)
      ));
      const matchingExistingRecord = existingRecordSnap.docs.some(recordDoc => {
        const record = recordDoc.data();
        return record.clinic_id === currentClinicId
          && (!activeAppointment.vaccination_session_id || record.vaccination_session_id === activeAppointment.vaccination_session_id);
      });
      if (matchingExistingRecord) throw new Error(`Dose ${doseNumber} is already recorded and cannot be replaced.`);
      await runTransaction(db, async transaction => {
        const currentInventory = await transaction.get(inventoryItem.ref);
        const quantity = Number(currentInventory.data()?.quantity || 0);
        if (quantity <= 0) throw new Error(`This clinic has no available inventory for ${vaccineName}.`);
        transaction.update(inventoryItem.ref, { quantity: quantity - 1 });
      });
      await addDoc(collection(db, 'vaccination_records'), {
        resident_uid: activeAppointment.resident_uid,
        resident_name: activeAppointment.resident_name || '',
        appointment_id: appointmentId,
        vaccination_session_id: activeAppointment.vaccination_session_id || 'legacy',
        dose_number: doseNumber,
        vaccine_name: vaccineName,
        vaccine_type: vaccineName,
        clinic_id: currentClinicId,
        clinic_name: activeAppointment.clinic_name || '',
        clinic_location: location,
        date_given: document.getElementById('completionDate').value,
        administered_by: auth.currentUser.uid,
        recorded_at: serverTimestamp()
      });
      await updateDoc(doc(db, 'appointments', appointmentId), {
        status: 'completed',
        completed_at: serverTimestamp(),
        completed_dose_number: doseNumber,
        completed_vaccine_name: vaccineName
      });
      closeRecordModal();
      showToast(`Dose ${doseNumber} recorded. The vaccination history is immutable.`);
      await loadAppointments();
      await loadPatients();
    } catch (error) {
      alert('Failed to record dose: ' + error.message);
    }
  });
  modal.addEventListener('click', event => {
    if (event.target === modal) closeRecordModal();
  });
  document.getElementById('staffRecordForm').addEventListener('submit', async event => {
    event.preventDefault();
    const appointmentId = document.getElementById('recordAppointmentId').value;
    if (!appointmentId || appointmentId === 'appointments') {
      alert('This patient record is missing a valid appointment ID. Please close it and open the appointment again.');
      return;
    }
    try {
      const assessment = {
        resident_address: document.getElementById('editAddress').value.trim(),
        date_of_birth: document.getElementById('editDateOfBirth').value || null,
        patient_sex: document.getElementById('editSex').value,
        bite_date: document.getElementById('editBiteDate').value,
        animal_type: document.getElementById('editAnimal').value.trim(),
        bite_body_part: document.getElementById('editBitePart').value.trim(),
        patient_category: document.getElementById('recordCategory').value,
        wound_washed: document.getElementById('recordWoundWashed').value,
        bite_type: document.getElementById('recordBiteType').value,
        assessed_by: auth.currentUser.uid,
        assessed_at: serverTimestamp()
      };
      const relatedAppointments = activeAppointment?.resident_uid && activeAppointment?.clinic_id
        ? await getDocs(query(
          collection(db, 'appointments'),
          where('clinic_id', '==', activeAppointment.clinic_id),
          where('resident_uid', '==', activeAppointment.resident_uid)
        ))
        : { docs: [] };
      const appointmentIds = new Set([appointmentId, ...relatedAppointments.docs.map(item => item.id)]);
      await Promise.all([...appointmentIds].map(id => updateDoc(doc(db, 'appointments', id), assessment)));
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