import { app, db } from './firebase.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js';
import { collection, query, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
export const manageAppointment = httpsCallable(getFunctions(app), 'manageAppointment');
const labels = { bite_type: 'Exposure Type', wound_washed: 'Wound washed immediately', animal_type: 'Animal That Bit You', bite_body_part: 'Body Part of the Bite', bite_date: 'Date of Bite', patient_category: 'Category', date_of_birth: 'Date of birth', patient_sex: 'Sex' };
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
  return openIntake(id, appointment);
}
export async function openIntake(id, appointment = {}) {
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
    date_of_birth: '<input name="date_of_birth" type="date" max="' + today + '" required>',
    patient_sex: select('patient_sex', ['Male','Female','Other','Prefer not to say'])
  };
  const field = key => '<div class="intake-field"><label for="intake-' + key + '">' + escape(labels[key]) + ' <span aria-hidden="true">*</span></label>' +
    inputs[key].replace('name="' + key + '"', 'id="intake-' + key + '" name="' + key + '"') +
    (key === 'animal_type' ? '<div class="other-animal" hidden><label for="intake-animal-other">Specify the animal <span aria-hidden="true">*</span></label><input id="intake-animal-other" name="animal_other" maxlength="160" disabled placeholder="e.g. Monkey"></div>' : '') + '</div>';
  dialog.innerHTML = '<header class="intake-header"><div class="intake-heading-icon" aria-hidden="true">&#10010;</div><div><p class="intake-eyebrow">PATIENT CARE</p><h2 id="intakeTitle">Medical intake</h2></div><button type="button" class="intake-dismiss" aria-label="Close medical intake">&times;</button></header>' +
    '<div class="intake-patient"><div class="intake-patient-identity"><span class="intake-caption">PATIENT</span><strong class="intake-patient-name"></strong><div class="intake-name-editor" hidden><label for="intake-patient-name">Patient name</label><input id="intake-patient-name" name="resident_name" form="intakeForm" maxlength="160" required autocomplete="off"></div><button type="button" class="intake-name-edit" aria-label="Edit patient name" title="Edit patient name" aria-expanded="false" aria-controls="intake-patient-name"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z"></path><path d="m14 5 5 5"></path></svg></button></div><span class="intake-arrived">&#10003; Arrival recorded</span></div>' +
    '<p id="intakeDescription">Complete the patient&#8217;s exposure details. All fields are required.</p><form id="intakeForm">' +
    '<fieldset><legend><span>01</span> Exposure details</legend><div class="intake-grid">' + ['bite_type','wound_washed','animal_type','bite_body_part','bite_date','patient_category'].map(field).join('') + '</div></fieldset>' +
    '<fieldset><legend><span>02</span> Patient details</legend><div class="intake-grid">' + ['date_of_birth','patient_sex'].map(field).join('') + '<div class="intake-field"><label>Age</label><output id="intakeAge">Enter date of birth</output></div>' + '</div></fieldset>' +
    '<footer class="intake-footer"><p role="status" aria-live="polite" class="intake-message"></p><div class="intake-actions"><button type="button" class="intake-close">Finish later</button><button type="submit" class="intake-save">Save patient record <span aria-hidden="true">&rarr;</span></button></div></footer></form>';
  document.body.append(dialog);
  const nameInput = dialog.querySelector('[name="resident_name"]');
  const nameDisplay = dialog.querySelector('.intake-patient-name');
  const nameEditor = dialog.querySelector('.intake-name-editor');
  const editName = dialog.querySelector('.intake-name-edit');
  nameInput.value = appointment.resident_name || 'Resident';
  nameDisplay.textContent = nameInput.value;
  const openNameEditor = () => {
    nameEditor.hidden = false;
    nameDisplay.hidden = true;
    editName.setAttribute('aria-expanded', 'true');
    nameInput.focus();
    nameInput.select();
  };
  editName.onclick = openNameEditor;
  nameInput.oninput = () => nameInput.setCustomValidity(nameInput.value.trim() ? '' : 'Enter the patient name.');
  nameInput.addEventListener('invalid', () => {
    if (nameEditor.hidden) openNameEditor();
  });
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
    intake.resident_name = nameInput.value.trim();
    if (!intake.resident_name) {
      openNameEditor();
      nameInput.setCustomValidity('Enter the patient name.');
      nameInput.reportValidity();
      return;
    }
    if (intake.animal_type === 'Other') {
      intake.animal_other = String(intake.animal_other || '').trim();
      if (!intake.animal_other) { otherAnimal.setCustomValidity('Enter the animal.'); otherAnimal.reportValidity(); return; }
    } else delete intake.animal_other;
    const birthInput = dialog.querySelector('[name="date_of_birth"]');
    birthInput.max = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Manila', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
    if (!event.currentTarget.reportValidity()) return;
    button.disabled = true;
    const message = dialog.querySelector('.intake-message');
    message.textContent = 'Saving...';
    try {
      await manageAppointment({ appointment_id: id, action: 'intake', intake });
      dialog.close();
    } catch (error) { message.textContent = error.message; button.disabled = false; }
  };
  const form=dialog.querySelector('form'), save=dialog.querySelector('[type="submit"]'), description=dialog.querySelector('#intakeDescription');
  const fieldsets=[...form.querySelectorAll('fieldset')], birth=form.elements.namedItem('date_of_birth');
  const updateAge=()=>{
    const dob=birth.value;
    dialog.querySelector('#intakeAge').textContent=!dob||dob>today ? 'Enter a valid date of birth' : (Number(today.slice(0,4))-Number(dob.slice(0,4))-(today.slice(5)<dob.slice(5)?1:0))+' years';
  };
  birth.addEventListener('input',updateAge);
  const loadExisting=async()=>{
    save.disabled=true; fieldsets.forEach(fieldset=>fieldset.disabled=true);
    description.textContent='Loading existing patient information...';
    const message=dialog.querySelector('.intake-message'); message.replaceChildren();
    try {
      const {data}=await manageAppointment({appointment_id:id,action:'intake_context'});
      if(!dialog.isConnected||!dialog.open)return;
      for(const [key,value] of Object.entries(data.defaults||{})){
        const input=form.elements.namedItem(key); if(!input)continue;
        if(key==='animal_type'&&!['Dog','Cat','Other'].includes(value)){animalSelect.value='Other';otherAnimal.value=value;}
        else input.value=value;
      }
      const isOther=animalSelect.value==='Other';
      dialog.querySelector('.other-animal').hidden=!isOther;otherAnimal.disabled=!isOther;otherAnimal.required=isOther;
      updateAge();
      description.textContent=data.mode==='review' ? 'Existing information loaded for this exposure. Review the details, correct any changes, and complete missing fields.' : data.mode==='new_exposure' ? 'Returning patient: patient details loaded. Enter the details of this new exposure.' : 'Complete the new patient registration. All medical fields are required.';
      save.innerHTML=data.mode==='review' ? 'Verify & save patient record <span aria-hidden="true">&rarr;</span>' : 'Save patient record <span aria-hidden="true">&rarr;</span>';
      fieldsets.forEach(fieldset=>fieldset.disabled=false);save.disabled=false;
    }catch(error){
      if(!dialog.isConnected||!dialog.open)return;
      description.textContent='Existing information could not be loaded. Retry before reviewing this patient.';
      message.textContent=error.message+' ';
      const retry=document.createElement('button');retry.type='button';retry.textContent='Retry lookup';retry.onclick=loadExisting;message.append(retry);
    }
  };
  dialog.showModal();
  await loadExisting();
}
