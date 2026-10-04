import { notifyDialog } from './app-dialogs.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js';
import { app, auth, db } from './firebase.js';
import { collection, query, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { availableStock } from './dose-stock.mjs';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
let unsubscribe;
export function watchDoseStock(clinicId) {
  unsubscribe?.();
  const select = document.getElementById('completionVaccine');
  select.replaceChildren(new Option('Loading clinic stock...', ''));
  select.disabled = true;
  unsubscribe = onSnapshot(query(collection(db, 'inventory'), where('clinic_id', '==', clinicId)), snapshot => {
    const selected = select.value;
    const items = availableStock(snapshot.docs.map(item => ({...item.data(), id:item.id})), clinicId, today());
    select.replaceChildren(new Option(items.length ? 'Select vaccine / batch...' : 'No available vaccine stock', ''));
    for (const item of items) select.add(new Option(item.type + ' | Batch ' + (item.batch || 'unspecified'), item.id));
    select.disabled = false;
    select.value = items.some(item => item.id === selected) ? selected : '';
    select.setCustomValidity(items.length ? '' : 'Add available vaccine stock before completing this dose.');
  }, error => {
    select.replaceChildren(new Option('Could not load clinic stock', ''));
    select.disabled = false;
    select.setCustomValidity('Could not load clinic stock. Reopen the form to retry.');
    console.error('Could not load dose stock:', error);
  });
}

const manageTreatment = httpsCallable(getFunctions(app), 'manageTreatment');
let reviewedAppointment = '';
let reviewGeneration = 0;
export async function reviewTreatment(appointmentId, selectedDoseNumber) {
  const generation = ++reviewGeneration;
  reviewedAppointment = '';
  const form = document.getElementById('doseCompletionForm');
  let panel = document.getElementById('treatmentReview');
  if (!panel) { panel = document.createElement('section'); panel.id = 'treatmentReview'; form.prepend(panel); }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  panel.textContent = 'Loading verified vaccination history...';
  try {
    const {data} = await manageTreatment({action:'review', appointment_id:appointmentId});
    if (generation !== reviewGeneration) return;
    panel.replaceChildren();
    const treatmentSummary = document.createElement('details'); treatmentSummary.className='treatment-card'; panel.append(treatmentSummary);
    const title = document.createElement('summary'); title.textContent = 'View vaccination history'; treatmentSummary.append(title);
    for (const dose of data.doses) {
      const record = data.history.find(r => Number(r.dose_number) === dose.dose_number);
      const line = document.createElement('p');
      line.textContent = 'Dose '+dose.dose_number+' \u2014 '+dose.status+(record||dose.actual_administration_date?'':' | Recommended: '+(dose.recommended_date||'Awaiting clinical schedule confirmation'))+(record?' | '+record.date_given+' | '+record.clinic_name+' | '+record.vaccine_name+' | Verified':'')+(dose.appointment_date?' | Appointment: '+dose.appointment_date:'');
      treatmentSummary.append(line);
    }
    const doseInput = document.getElementById('completionDose');
    doseInput.type = 'text'; doseInput.readOnly = true;
    const pending = data.doses.filter(d => !d.actual_administration_date);
    let selected = pending.find(d => d.dose_number === Number(selectedDoseNumber)) || data.next;
    const selectionLabel = document.createElement('label'); selectionLabel.textContent = '1. Select pending dose'; selectionLabel.className='treatment-selection';
    const selection = document.createElement('select'); selection.id = 'treatmentDoseSelection';
    if (!pending.length) selection.add(new Option('Treatment complete', ''));
    for (const d of pending) selection.add(new Option('Dose '+d.dose_number+' \u2014 '+d.status, d.dose_number));
    selection.disabled = !pending.length; selection.value = selected?.dose_number || '';
    selectionLabel.append(selection); panel.append(selectionLabel);
    let confirmLabel = document.createElement('label');
    const check = document.createElement('input'); check.type='checkbox'; check.id='completionConfirmed'; check.required=true;
    confirmLabel.className='treatment-confirm'; confirmLabel.append(check, ' I reviewed the history and confirm the dose being administered.'); panel.append(confirmLabel);
    const remarksLabel=document.createElement('label'); remarksLabel.textContent='Remarks (optional)';
    const remarks=document.createElement('textarea'); remarks.id='completionRemarks'; remarks.maxLength=2000; remarksLabel.append(remarks); panel.append(remarksLabel);
    const external=document.createElement('details'); const summary=document.createElement('summary'); summary.textContent='2. Verify previous doses'; external.className='treatment-card'; external.append(summary); const progress=document.createElement('p');progress.className='treatment-progress';external.append(progress);const grid=document.createElement('div');grid.className='treatment-field-grid';external.append(grid);
    const help=document.createElement('p');help.className='treatment-helper';external.insertBefore(help,grid);
    const previous=document.createElement('input');previous.type='hidden';previous.id='previousDoseNumber';external.append(previous);
    const field=(label,type='text',optional=false)=>{const l=document.createElement('label');const caption=document.createElement('span');caption.textContent=label;const input=document.createElement('input');input.type=type;input.maxLength=200;input.dataset.essential=optional?'false':'true';l.append(caption,input);grid.append(l);return input;};
    const externalDate=field('Date of 1st Dose','date');externalDate.max=today();
    const externalVaccine=field('Vaccine Brand');
    const vaccineType=field('Generic Name / Vaccine Type');
    const batch=field('Batch Number / Lot Number');
    const externalClinic=field('Administering Facility / Clinic Name');
    const vaccinator=field('Vaccinator Name / Signature (Optional)','text',true);
    const verify=document.createElement('button');verify.type='button';verify.textContent='Verify dose and continue';verify.className='treatment-primary';
    verify.onclick=async()=>{
      for(const input of grid.querySelectorAll('input')){
        input.setCustomValidity(input.dataset.essential==='true'&&!input.value.trim()?'Complete this field.':'');
        if(!input.reportValidity())return;
      }
      verify.disabled=true;
      try{
        await manageTreatment({action:'verify_external',appointment_id:appointmentId,dose_number:Number(previous.value),selected_dose_number:selected.dose_number,confirmed:true,verification_method:'staff_record_review',vaccine_batch:batch.value.trim(),vaccine_type:vaccineType.value.trim(),date:externalDate.value,external_clinic:externalClinic.value.trim(),vaccine:externalVaccine.value.trim(),vaccinator_name:vaccinator.value.trim(),remarks:remarks.value});
        await reviewTreatment(appointmentId,selected?.dose_number);
      }catch(e){notifyDialog(e.message);verify.disabled=false;}
    };external.append(verify);panel.append(external);
    const warning=document.createElement('p');warning.setAttribute('role','status');warning.className='treatment-warning';panel.insertBefore(warning,external);
    const updateSelection=()=>{
      selected=pending.find(d=>d.dose_number===Number(selection.value));
      const missing=data.doses.filter(d=>selected&&d.dose_number<selected.dose_number&&!d.actual_administration_date);
      treatmentSummary.hidden=selected?.dose_number===1;
      doseInput.value=selected?'Dose '+selected.dose_number:'Treatment complete';
      doseInput.dataset.doseNumber=selected?.dose_number||'';
      check.checked=false;check.disabled=!selected||!!missing.length;
      warning.hidden=!missing.length;
      warning.textContent=missing.length?'Verify '+missing.map(d=>'Dose '+d.dose_number).join(', ')+' before completing Dose '+selected.dose_number+'.':'';const prior=data.doses.filter(d=>selected&&d.dose_number<selected.dose_number);progress.textContent=(prior.length-missing.length)+' of '+prior.length+' earlier doses verified';summary.textContent='2. Verify previous doses ('+missing.length+' remaining)';
      external.hidden=!missing.length;external.open=!!missing.length;
      previous.value=missing[0]?.dose_number||'';
      const ordinal={1:'1st',2:'2nd',3:'3rd',4:'4th'}[Number(previous.value)]||'1st';
      externalDate.previousElementSibling.textContent='Date of '+ordinal+' Dose';
      help.textContent=missing.length?'Enter the details for Dose '+previous.value+' to continue.':'';
      for(const input of grid.querySelectorAll('input'))input.setCustomValidity('');
      for(const control of external.querySelectorAll('input, select'))control.disabled=!missing.length;
      previous.disabled=missing.length<2;
      verify.disabled=!missing.length;
      submit.disabled=!selected||!!missing.length||!check.checked;
    };
    selection.onchange=updateSelection;
    previous.onchange=()=>{verify.disabled=Number(previous.value)!==data.next?.dose_number;};
    check.onchange=()=>{submit.disabled=!check.checked||!selected;};
    updateSelection();
    const schedule=document.createElement('details'),scheduleTitle=document.createElement('summary');scheduleTitle.textContent='Adjust schedule after clinical review';schedule.className='treatment-card';schedule.append(scheduleTitle);const scheduleGrid=document.createElement('div');scheduleGrid.className='treatment-field-grid';schedule.append(scheduleGrid);
    const dates=[];
    for(const d of data.doses.filter(d=>!d.actual_administration_date&&data.next&&d.dose_number>=data.next.dose_number)){
      const label=document.createElement('label');label.textContent='Dose '+d.dose_number;const input=document.createElement('input');input.type='date';input.value=d.recommended_date||'';label.append(input);scheduleGrid.append(label);dates.push({dose:d,input});
    }
    const reason=document.createElement('textarea');reason.placeholder='Approved clinic protocol and clinical reason for these dates';reason.setAttribute('aria-label','Clinical review and reason');schedule.append(reason);
    const adjust=document.createElement('button');adjust.type='button';adjust.textContent='Save reviewed dates';adjust.className='treatment-secondary';adjust.disabled=!dates.length;
    adjust.onclick=async()=>{adjust.disabled=true;try{await manageTreatment({action:'schedule',appointment_id:appointmentId,confirmed:true,reason:reason.value,dates:dates.filter(x=>x.input.value!==(x.dose.recommended_date||'')).map(x=>({dose_number:x.dose.dose_number,recommended_date:x.input.value}))});await reviewTreatment(appointmentId, selected?.dose_number);}catch(e){notifyDialog(e.message);adjust.disabled=false;}};schedule.append(adjust);panel.append(schedule);panel.append(remarksLabel,confirmLabel);
    reviewedAppointment=appointmentId;
   } catch(error) {
    if (generation !== reviewGeneration) return;
    console.error('Treatment review failed:', error);
    const message = document.createElement('p');
    message.textContent = ['functions/internal', 'functions/not-found'].includes(error.code)
      ? 'Vaccination history is temporarily unavailable. Please retry. If this continues, contact the system administrator.'
      : 'Unable to load vaccination history. ' + error.message;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry loading history';
    retry.onclick = () => reviewTreatment(appointmentId);
    panel.replaceChildren(message, retry);
  }
}
export async function saveStockDose(clinicId) {
  const form=document.getElementById('doseCompletionForm'),button=form.querySelector('[type="submit"]');
  const appointmentId=document.getElementById('completionAppointmentId').value;
  if(button.disabled||!form.reportValidity())return false;
  if(reviewedAppointment!==appointmentId)throw new Error('Wait for treatment history to load.');
  button.disabled=true;
  try{
    await manageTreatment({action:'complete',appointment_id:appointmentId,stock_id:document.getElementById('completionVaccine').value,
      dose_number:Number(document.getElementById('completionDose').dataset.doseNumber),date:document.getElementById('completionDate').value,
      location:document.getElementById('completionLocation').value,confirmed:document.getElementById('completionConfirmed').checked,
      remarks:document.getElementById('completionRemarks').value});
    return true;
  }finally{button.disabled=false;}
}
