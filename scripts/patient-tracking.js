import { watchDoseStock, saveStockDose } from './dose-completion.js';
import { manageAppointment } from './appointment-intake.js';
import { courseKey, courseStatus } from './patient-course.js';
import { auth, db, fetchUserProfile } from './firebase.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import {
  collection, query, where, orderBy, getDocs,
  doc, updateDoc, addDoc, serverTimestamp, getDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

function manilaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

let pendingCount = 0;
let currentClinicId = null;
let activeAppointment = null;

let patientAppointments = [], patientVaccinations = [], patientIntakes = [];
let patientUnsubscribes = [], patientTimer;
function startPatientListeners() {
 patientUnsubscribes.forEach(unsubscribe => unsubscribe());
 clearInterval(patientTimer);
 patientAppointments = []; patientVaccinations = []; patientIntakes = [];
 patientUnsubscribes = ['appointments','vaccination_records','patient_records'].map(name =>
  onSnapshot(query(collection(db,name),where('clinic_id','==',currentClinicId)), snapshot => {
   const rows = snapshot.docs.map(item => ({...item.data(),id:item.id}));
   if(name === 'appointments') patientAppointments = rows;
   if(name === 'vaccination_records') patientVaccinations = rows;
   if(name === 'patient_records') patientIntakes = rows;
   loadPatients();
  }, error => { document.getElementById('patientsGrid').textContent = 'Could not load patient records: ' + error.message; }));
 patientTimer = setInterval(loadPatients, 30000);
}
function loadPatients() {
 const grid = document.getElementById('patientsGrid');
 const groups = new Map();
 for (const item of [...patientIntakes,...patientAppointments,...patientVaccinations]) {
  const key = courseKey(item);
  if(!groups.has(key)) groups.set(key,{key, source:item});
 }
 const patients = [...groups.values()].map(group => {
  const appointments = patientAppointments.filter(item => courseKey(item) === group.key);
  const records = patientVaccinations.filter(item => courseKey(item) === group.key);
  const intake = patientIntakes.find(item => courseKey(item) === group.key);
  if (!intake && !records.length && !appointments.some(item => item.status === 'in_progress')) return null;
  const source = intake || appointments.find(item=>item.intake_completed_at) || group.source;
  const appointment = appointments.find(item=>item.status === 'in_progress') || appointments.find(item=>item.status === 'confirmed') || appointments[0];
  return {...group, source, intake, appointment, ...courseStatus(appointments,records)};
 }).filter(Boolean).sort((a,b)=>String(a.source.resident_name || '').localeCompare(String(b.source.resident_name || '')));
 const selected = document.getElementById('patientStatusFilter').value;
 const search = document.getElementById('patientSearch').value.trim().toLowerCase();
 for(const status of ['all','ongoing','incomplete','complete']) {
  const count = status === 'all' ? patients.length : patients.filter(item=>item.status===status).length;
  document.querySelector('#patientStatusFilter option[value="'+status+'"]').textContent = (status === 'all' ? 'All patients' : status.charAt(0).toUpperCase()+status.slice(1)) + ' ('+count+')';
 }
 const visible = patients.filter(item => (selected==='all'||item.status===selected) && String(item.source.resident_name||'').toLowerCase().includes(search));
 document.getElementById('patientResultCount').textContent = visible.length + ' of ' + patients.length + ' patient courses';
 grid.innerHTML = visible.map((patient,index) => {
  const source=patient.source, pct=patient.doses*20;
  const fields = {bite_type:'Exposure type',animal_type:'Animal',wound_washed:'Wound washed',bite_body_part:'Body part',bite_date:'Date of bite',patient_age:'Age',patient_sex:'Sex'};
  const details = Object.entries(fields).map(([key,label])=>'<div><dt>'+label+'</dt><dd>'+displayValue(source[key])+'</dd></div>').join('');
  return '<article class="patient-card"><div class="patient-header"><h3>'+escapeHtml(source.resident_name||'Resident')+'</h3><span class="course-status '+patient.status+'">'+patient.status.charAt(0).toUpperCase()+patient.status.slice(1)+'</span></div><div class="treatment-section"><label>Treatment progress</label><span class="doses-badge">'+patient.doses+'/5 doses</span><div class="progress-bar-container"><div class="progress-bar" style="width:'+pct+'%"></div></div></div><p class="course-note">'+escapeHtml(patient.note)+'</p><details class="patient-intake-details"><summary>Patient intake details</summary><dl>'+details+'</dl></details>'+(patient.appointment ? '<button class="view-record-btn" data-patient-index="'+index+'">View Full Record</button>':'')+'</article>';
 }).join('') || '<p class="patient-empty">No patients match these filters.</p>';
 grid.querySelectorAll('[data-patient-index]').forEach(button=>button.onclick=()=>openRecordModal(visible[Number(button.dataset.patientIndex)].appointment.id));
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
    await manageAppointment({ appointment_id: apptId, action: 'confirm' });

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
  document.getElementById('patientSearch').addEventListener('input', loadPatients);
  document.getElementById('patientStatusFilter').addEventListener('change', loadPatients);
  document.getElementById('todayDate').textContent =
    new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      const staff = await fetchUserProfile(user.uid);
      currentClinicId = staff?.clinic_id || user.uid;
      await loadAppointments();
      startPatientListeners();
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
    const relatedAppointments = relatedAppointmentsSnap.docs.map(item => item.data()).filter(item => courseKey(item) === courseKey(appointment));
    const savedIntake = patientIntakes.find(item => courseKey(item) === courseKey(appointment)) || {};
    const firstWith = field => savedIntake[field] ?? (appointment[field] || relatedAppointments.find(item => item[field])?.[field] || '');
    const details = {
      ...appointment,
      resident_address: firstWith('resident_address') || resident.address,
      date_of_birth: firstWith('date_of_birth') || resident.birthday,
      patient_age: firstWith('patient_age'),
      patient_sex: firstWith('patient_sex') || resident.gender,
      bite_date: firstWith('bite_date'),
      animal_type: firstWith('animal_type'),
      bite_body_part: firstWith('bite_body_part'),
      patient_category: firstWith('patient_category'),
      wound_washed: firstWith('wound_washed'),
      bite_type: firstWith('bite_type'),
    };
    activeAppointment = { id, ...details };
    document.getElementById('recordAppointmentId').value = id;
    document.getElementById('recordModalTitle').textContent = `${details.resident_name || 'Resident'} — Full Record`;
    document.getElementById('recordDetails').innerHTML = `
      <div class="record-detail-grid">
        <div><strong>Address</strong><span>${displayValue(details.resident_address)}</span></div>
        <div><strong>Date of Birth</strong><span>${displayValue(details.date_of_birth)}</span></div>
        <div><strong>Age</strong><span>${displayValue(details.patient_age)}</span></div>
        <div><strong>Sex</strong><span>${displayValue(details.patient_sex)}</span></div>
        <div><strong>Date of Bite</strong><span>${displayValue(details.bite_date)}</span></div>
        <div><strong>Animal</strong><span>${displayValue(details.animal_type)}</span></div>
        <div><strong>Body Part</strong><span>${displayValue(details.bite_body_part)}</span></div>
        <div><strong>Reservation</strong><span>${displayValue(details.preferred_date)}${details.reservation_end_date && details.reservation_end_date !== details.preferred_date ? ` to ${displayValue(details.reservation_end_date)}` : ''} at ${displayValue(details.preferred_time)}</span></div>
        <div><strong>Dose</strong><span>${displayValue(details.dose_label)}</span></div>
        <div><strong>Was the Bite Washed?</strong><span>${displayValue(details.wound_washed)}</span></div>
        <div><strong>Type of Bite</strong><span>${displayValue(details.bite_type)}</span></div>
      </div>`;
    document.getElementById('editAddress').value = details.resident_address || '';
    document.getElementById('editDateOfBirth').value = details.date_of_birth || '';
    document.getElementById('editSex').value = details.patient_sex || '';
    const biteDateInput = document.getElementById('editBiteDate');
    biteDateInput.max = manilaToday();
    biteDateInput.onfocus = () => { biteDateInput.max = manilaToday(); };
    biteDateInput.value = details.bite_date || '';
    document.getElementById('editAnimal').value = details.animal_type || '';
    document.getElementById('editBitePart').value = details.bite_body_part || '';
    document.getElementById('recordCategory').value = details.patient_category || '';
    document.getElementById('recordWoundWashed').value = details.wound_washed || '';
    document.getElementById('recordBiteType').value = details.bite_type || '';
    document.getElementById('staffRecordForm').hidden = true;
    const completionForm = document.getElementById('doseCompletionForm');
    completionForm.hidden = appointment.status !== 'in_progress' || !appointment.intake_completed_at;
    document.getElementById('completionAppointmentId').value = id;
    document.getElementById('completionDate').value = manilaToday();
    document.getElementById('completionDate').max = manilaToday();
    document.getElementById('completionDose').readOnly = true;
    document.getElementById('completionDose').value = Number(String(appointment.dose_label || '1').match(/\d+/)?.[0] || 1);
    watchDoseStock(currentClinicId);
    document.getElementById('completionLocation').value = appointment.clinic_address || '';
    document.getElementById('editRecordBtn').hidden = Boolean(activeAppointment?.intake_completed_at);
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
    document.getElementById('editRecordBtn').hidden = Boolean(activeAppointment?.intake_completed_at);
  });
  document.getElementById('doseCompletionForm').addEventListener('submit', async event => {
    event.preventDefault();
    const doseNumber = Number(document.getElementById('completionDose').value);
    try {
      if (!await saveStockDose(currentClinicId)) return;
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
    const biteDate = document.getElementById('editBiteDate').value;
    if (biteDate && biteDate > manilaToday()) {
      alert('Date of bite must be today or earlier.');
      return;
    }
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
      const appointmentIds = new Set([appointmentId, ...relatedAppointments.docs.filter(item => !item.data().intake_completed_at).map(item => item.id)]);
      await Promise.all([...appointmentIds].map(id => updateDoc(doc(db, 'appointments', id), assessment)));
      closeRecordModal();
      document.getElementById('staffRecordForm').hidden = true;
      document.getElementById('editRecordBtn').hidden = Boolean(activeAppointment?.intake_completed_at);
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