import { app, db } from './firebase.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js';
import { collection, query, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
export const manageAppointment = httpsCallable(getFunctions(app), 'manageAppointment');
const labels = { bite_type: 'Exposure Type', wound_washed: 'Wound washed immediately', animal_type: 'Animal That Bit You', bite_body_part: 'Body Part of the Bite', bite_date: 'Date of Bite', patient_category: 'Category', patient_age: 'Age', patient_sex: 'Sex' };
const escape = value => { const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML; };
let recordUnsubscribe;
export function listenPatientRecords(parent, field, value) {
  if (!parent) return;
  recordUnsubscribe?.();
  let section = parent.querySelector('.permanent-patient-records');
  if (!section) { section = document.createElement('section'); section.className = 'permanent-patient-records'; section.style.cssText = 'margin:20px 0;padding:20px;background:white;border:1px solid #e5e7eb;border-radius:12px;'; parent.prepend(section); }
  section.innerHTML = '<h3>Patient Records</h3><p>Loading records...</p>';
  recordUnsubscribe = onSnapshot(query(collection(db, 'patient_records'), where(field, '==', value)), snapshot => {
    const records = snapshot.docs.map(doc => doc.data()).sort((a,b) => (b.recorded_at?.toMillis?.() || 0) - (a.recorded_at?.toMillis?.() || 0));
    section.innerHTML = '<h3>Patient Records</h3>' + (records.length ? records.map(item =>
      '<details style="padding:12px 0;border-bottom:1px solid #e5e7eb;"><summary>' + escape(item.resident_name) + ' ? ' + escape(item.clinic_name) + ' ? ' + escape(item.preferred_date) + '</summary><dl>' +
      Object.entries(labels).map(([key,label]) => '<dt style="font-weight:600;margin-top:8px;">' + label + '</dt><dd style="margin:0;">' + escape(item[key]) + '</dd>').join('') + '</dl></details>'
    ).join('') : '<p>No completed medical intake records yet.</p>');
  }, error => { section.innerHTML = '<h3>Patient Records</h3><p>' + escape('Could not load records: ' + error.message) + '</p>'; });
}
export async function markArrivalAndOpenIntake(id, appointment) {
  await manageAppointment({ appointment_id: id, action: 'arrive' });
  openIntake(id, appointment);
}
export function openIntake(id, appointment = {}) {
  document.getElementById('appointmentIntakeDialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'appointmentIntakeDialog';
  dialog.setAttribute('aria-labelledby', 'intakeTitle');
  if (!document.getElementById('appointmentIntakeStyles')) {
    const stylesheet = document.createElement('link');
    stylesheet.id = 'appointmentIntakeStyles';
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./appointment-intake.css', import.meta.url).href;
    document.head.append(stylesheet);
  }
  dialog.setAttribute('aria-describedby', 'intakeDescription');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Manila', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  const select = (name, options) => '<select name="' + name + '" required><option value="">Select...</option>' + options.map(value => '<option>' + value + '</option>').join('') + '</select>';
  const inputs = {
    bite_type: select('bite_type', ['Bite','Scratch','Both bite and scratch','Lick on broken skin']),
    wound_washed: select('wound_washed', ['Yes','No','Unknown']),
    animal_type: select('animal_type', ['Dog','Cat','Other']),
    bite_body_part: '<input name="bite_body_part" maxlength="160" required placeholder="e.g. Left leg">',
    bite_date: '<input name="bite_date" type="date" max="' + today + '" required>',
    patient_category: select('patient_category', ['Category I','Category II','Category III']),
    patient_age: '<input name="patient_age" type="number" min="0" max="130" step="1" required>',
    patient_sex: select('patient_sex', ['Male','Female','Other','Prefer not to say'])
  };
  const field = key => '<div class="intake-field"><label for="intake-' + key + '">' + escape(labels[key]) + ' <span aria-hidden="true">*</span></label>' +
    inputs[key].replace('name="' + key + '"', 'id="intake-' + key + '" name="' + key + '"') +
    (key === 'animal_type' ? '<div class="other-animal" hidden><label for="intake-animal-other">Specify the animal <span aria-hidden="true">*</span></label><input id="intake-animal-other" name="animal_other" maxlength="160" disabled placeholder="e.g. Monkey"></div>' : '') + '</div>';
  dialog.innerHTML = '<header class="intake-header"><div class="intake-heading-icon" aria-hidden="true">&#10010;</div><div><p class="intake-eyebrow">PATIENT CARE</p><h2 id="intakeTitle">Medical intake</h2></div><button type="button" class="intake-dismiss" aria-label="Close medical intake">&times;</button></header>' +
    '<div class="intake-patient"><div><span class="intake-caption">PATIENT</span><strong>' + escape(appointment.resident_name || 'Resident') + '</strong></div><span class="intake-arrived">&#10003; Arrival recorded</span></div>' +
    '<p id="intakeDescription">Complete the patient&#8217;s exposure details. All fields are required.</p><form>' +
    '<fieldset><legend><span>01</span> Exposure details</legend><div class="intake-grid">' + ['bite_type','wound_washed','animal_type','bite_body_part','bite_date','patient_category'].map(field).join('') + '</div></fieldset>' +
    '<fieldset><legend><span>02</span> Patient details</legend><div class="intake-grid">' + ['patient_age','patient_sex'].map(field).join('') + '</div></fieldset>' +
    '<footer class="intake-footer"><p role="status" aria-live="polite" class="intake-message"></p><div class="intake-actions"><button type="button" class="intake-close">Finish later</button><button type="submit" class="intake-save">Save patient record <span aria-hidden="true">&rarr;</span></button></div></footer></form>';
  document.body.append(dialog);
  const animalSelect = dialog.querySelector('[name="animal_type"]');
  const otherAnimal = dialog.querySelector('[name="animal_other"]');
  animalSelect.onchange = () => {
    const isOther = animalSelect.value === 'Other';
    dialog.querySelector('.other-animal').hidden = !isOther;
    otherAnimal.disabled = !isOther;
    otherAnimal.required = isOther;
    otherAnimal.setCustomValidity('');
    if (isOther) otherAnimal.focus();
  };
  otherAnimal.oninput = () => otherAnimal.setCustomValidity(otherAnimal.value.trim() ? '' : 'Enter the animal.');
  dialog.querySelector('.intake-close').onclick = () => dialog.close();
  dialog.querySelector('.intake-dismiss').onclick = () => dialog.close();
  dialog.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const button = dialog.querySelector('[type="submit"]');
    if (button.disabled) return;
    const intake = Object.fromEntries(new FormData(event.currentTarget));
    if (intake.animal_type === 'Other') {
      intake.animal_other = String(intake.animal_other || '').trim();
      if (!intake.animal_other) { otherAnimal.setCustomValidity('Enter the animal.'); otherAnimal.reportValidity(); return; }
    } else delete intake.animal_other;
    intake.patient_age = Number(intake.patient_age);
    button.disabled = true;
    const message = dialog.querySelector('.intake-message');
    message.textContent = 'Saving...';
    try {
      await manageAppointment({ appointment_id: id, action: 'intake', intake });
      dialog.close();
    } catch (error) { message.textContent = error.message; button.disabled = false; }
  };
  dialog.showModal();
}
