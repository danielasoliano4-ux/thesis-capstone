const { readStock, publishStock, availableQuantity } = require('./stock-reservations');

'use strict';
const {createHash}=require('node:crypto');
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const key=(uid,session)=>createHash('sha256').update(JSON.stringify([uid,session])).digest('hex');
const validDate=d=>typeof d==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10)===d;
function dosesFrom(records,saved=[],day=today()){
 const accepted=records.filter(r=>r.date_given && (r.source!=='external'||r.verification_status==='Verified'));
 const first=accepted.find(r=>Number(r.dose_number)===1);
 return [0,3,7,14,28].map((offset,i)=>{
  const old=saved.find(d=>d.dose_number===i+1)||{},r=accepted.find(r=>Number(r.dose_number)===i+1);
  const recommended=old.recommended_date||(first?new Date(Date.parse(first.date_given.slice(0,10)+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10):null);
  return {...old,dose_number:i+1,recommended_date:recommended,appointment_date:old.appointment_date||null,actual_administration_date:r?.date_given||null,administering_clinic:r?.clinic_id||r?.clinic_name||null,vaccine_used:r?.vaccine_name||null,status:r?.source==='external'?'Completed \u2013 Verified Previous Record':r?(recommended&&r.date_given>recommended?'Completed?Delayed':'Completed'):(recommended&&recommended<day?'Overdue':'Pending')};
 });
}
async function loadTreatment(tx,db,uid,session){
 const ref=db.collection('treatments').doc(key(uid,session)),saved=(await tx.get(ref)).data();
 const history=await tx.get(db.collection('vaccination_records').where('resident_uid','==',uid));
 const records=history.docs.map(d=>d.data()).filter(r=>(r.vaccination_session_id||'legacy')===session && r.date_given && (r.source!=='external'||r.verification_status==='Verified'));
 return {ref,records,treatment:{...saved,resident_uid:uid,vaccination_session_id:session,doses:dosesFrom(records,saved?.doses)}};
}
function needsSeparateTreatment(appointment,records,appointmentId){
 const dose=Number(appointment.dose_number||String(appointment.dose_label||'').match(/\d+/)?.[0]);
 if(dose!==1||!['pending','confirmed','accepted','approved','in_progress'].includes(appointment.status)) return false;
 if(![1,2,3,4,5].every(n=>records.some(record=>Number(record.dose_number)===n))) return false;
 if(records.some(record=>record.appointment_id===appointmentId)) return false;
 const created=appointment.created_at?.toMillis?.();
 const recorded=records.map(record=>record.recorded_at?.toMillis?.()).filter(Number.isFinite);
 if(Number.isFinite(created)&&recorded.length) return created>=Math.max(...recorded);
 const lastDate=records.map(record=>String(record.date_given||'').slice(0,10)).sort().pop();
 return validDate(appointment.preferred_date)&&appointment.preferred_date>=lastDate;
}
function treatmentHandler({db,HttpsError,timestamp,verifyDocument}){
 return async request=>{
  const c=request.auth?.token,data=request.data||{};
  const fail=m=>{throw new HttpsError('failed-precondition',m);};
  if(!c||c.secure_login!==true||c.email_verified!==true||c.firebase?.sign_in_provider!=='custom') throw new HttpsError('unauthenticated','Sign in again.');
  if(typeof data.appointment_id!=='string'||!data.appointment_id||data.appointment_id.includes('/')) fail('Choose an appointment.');
  return db.runTransaction(async tx=>{
   const ar=db.collection('appointments').doc(data.appointment_id),a=(await tx.get(ar)).data();
   const staff=(await tx.get(db.collection('users').doc(request.auth.uid))).data();
   if(!a||staff?.role!=='clinic_staff'||staff.is_active!==true||(staff.approval_status||'approved')!=='approved'||a.clinic_id!==(staff.clinic_id||request.auth.uid)) throw new HttpsError('permission-denied','Only receiving clinic staff can review this treatment.');
   if(typeof a.resident_uid!=='string'||!a.resident_uid) throw new HttpsError('failed-precondition','This appointment has no linked resident account. Reopen the correct appointment before recording a dose.');
   let course=await loadTreatment(tx,db,a.resident_uid,a.vaccination_session_id||'legacy');
   let repair=null;
   if(data.action==='review'&&needsSeparateTreatment(a,course.records,data.appointment_id)){
    // Repair older Dose 1 bookings that still point at a completed course.
    // The appointment ID gives retries the same separate treatment session.
    const session='renewal-'+data.appointment_id;
    const intakeRef=db.collection('patient_records').doc(a.patient_record_id||data.appointment_id);
    const intake=(await tx.get(intakeRef)).data();
    repair={intakeRef,intake,previousSession:a.vaccination_session_id||'legacy'};
    course=await loadTreatment(tx,db,a.resident_uid,session);
    course.treatment.doses[0].appointment_date=a.preferred_date;
    course.treatment.doses[0].appointment_id=data.appointment_id;
    a.vaccination_session_id=session;
   }
   const {ref,records,treatment}=course;
   const next=treatment.doses.find(d=>!d.actual_administration_date);
   if(data.action==='review'){
    const docs=await tx.get(db.collection('vaccination_documents').where('resident_uid','==',a.resident_uid));
    if(repair){
     tx.set(ref,{...treatment,updated_at:timestamp()});
     tx.update(ar,{vaccination_session_id:a.vaccination_session_id,treatment_id:ref.id,dose_number:1,dose_label:'Dose 1 (Day 0)',recommended_date:null,course_vaccination_history:[],previous_vaccination_session_id:repair.previousSession});
     if(repair.intake&&repair.intake.resident_uid===a.resident_uid&&repair.intake.clinic_id===a.clinic_id)
      tx.update(repair.intakeRef,{vaccination_session_id:a.vaccination_session_id});
    }
    const history=records.filter(record=>record.clinic_id===a.clinic_id);
    const doses=treatment.doses.map(dose=>{
      const record=records.find(record=>Number(record.dose_number)===dose.dose_number);
      if(!record||record.clinic_id===a.clinic_id) return dose;
      // Keep dose sequencing on the server without exposing another clinic's records.
      return {dose_number:dose.dose_number,status:'Completed',actual_administration_date:true,recommended_date:null,appointment_date:null,administering_clinic:null,vaccine_used:null};
    });
    return {clinic_id:a.clinic_id,doses,next:next||null,history,stock_reservation:a.stock_reservation||null,documents:docs.docs.map(d=>({...d.data(),id:d.id})).filter(d=>d.clinic_id===a.clinic_id&&(d.vaccination_session_id||'legacy')===(a.vaccination_session_id||'legacy'))};
   }
   if(data.action==='schedule'){
    if(data.confirmed!==true||typeof data.reason!=='string'||!data.reason.trim()||!Array.isArray(data.dates)||!data.dates.length) fail('Confirm clinical review and give a reason and dates.');
    const updated=treatment.doses.map(d=>({...d}));
    for(const change of data.dates){
     const d=updated.find(d=>d.dose_number===change.dose_number);
     if(!d||d.actual_administration_date||!next||d.dose_number<next.dose_number||!validDate(change.recommended_date)) fail('Only succeeding incomplete doses can be adjusted.');
     d.recommended_date=change.recommended_date;
    }
    for(let i=1;i<updated.length;i++) if(updated[i].recommended_date&&updated[i-1].recommended_date&&updated[i].recommended_date<updated[i-1].recommended_date) fail('Dates must remain in dose order.');
    tx.set(ref,{...treatment,doses:dosesFrom(records,updated),updated_at:timestamp()});
    tx.set(db.collection('treatment_schedule_reviews').doc(),{treatment_id:ref.id,previous:treatment.doses,dates:data.dates,reason:data.reason.trim(),reviewed_by:request.auth.uid,clinic_id:a.clinic_id,reviewed_at:timestamp()});
    const schedule=updated.filter(d=>!d.actual_administration_date).map(d=>({dose_number:d.dose_number,recommended_date:d.recommended_date}));
    const scheduleText=schedule.filter(d=>d.recommended_date).map(d=>`Dose ${d.dose_number}: ${d.recommended_date}`).join(', ');
    tx.set(db.collection('notifications').doc(),{
     recipient_uid:a.resident_uid,user_id:a.resident_uid,type:'vaccine',
     title:'Clinic recommended vaccination dates',
     message:`${a.clinic_name||'Your clinic'} recommended your vaccination dates${scheduleText?`: ${scheduleText}`:'.'}`,
     schedule,action:'review_schedule',clinic_id:a.clinic_id,clinic_name:a.clinic_name||'',
     treatment_id:ref.id,vaccination_session_id:a.vaccination_session_id||'legacy',
     push:true,read:false,created_at:timestamp()
    });
    return {ok:true};
   }
   if(!next||Number(data.dose_number)!==next.dose_number||data.confirmed!==true) fail('Review and confirm the next incomplete dose. Refresh the history.');
   if(data.action==='verify_external' && data.selected_dose_number!=null && (!Number.isInteger(data.selected_dose_number)||data.selected_dose_number>5||data.selected_dose_number<=Number(data.dose_number)||treatment.doses[data.selected_dose_number-1]?.actual_administration_date)) fail('Select an incomplete succeeding dose before verifying previous records.');
   if(!validDate(data.date)||data.date>today()||records.some(r=>Number(r.dose_number)<next.dose_number?r.date_given>data.date:r.date_given<data.date)) fail('Enter an actual date no earlier than prior doses and no later than today.');
   let record;
   if(data.action==='verify_external'){
    if(data.document_id && (typeof data.document_id!=='string'||data.document_id.includes('/'))) fail('Select valid supporting documentation.');
    const staffRecordReview=data.verification_method==='staff_record_review';
    if(staffRecordReview && ['vaccine','vaccine_type','vaccine_batch','external_clinic'].some(field=>typeof data[field]!=='string'||!data[field].trim()||data[field].length>200)) fail('Enter the vaccine brand, generic name, batch number, and administering facility.');
    if(data.vaccinator_name!=null&&(typeof data.vaccinator_name!=='string'||data.vaccinator_name.length>200)) fail('Enter a valid vaccinator name.');
    if(!staffRecordReview && !data.document_id && (typeof data.verification_basis!=='string'||!data.verification_basis.trim())) fail('Document the clinical verification basis; a patient statement alone is insufficient.');
    const document=data.document_id?(await tx.get(db.collection('vaccination_documents').doc(data.document_id))).data():null;
    if(data.document_id&&(!document||document.resident_uid!==a.resident_uid||(document.vaccination_session_id||'legacy')!==(a.vaccination_session_id||'legacy')||!document.storage_path?.startsWith('vaccination-documents/'+a.resident_uid+'/')||!document.download_url)) fail('A vaccination card for this treatment is required.');
    if(document && verifyDocument && !await verifyDocument(document.storage_path)) fail('The supporting vaccination card could not be found. Upload it again.');
    if(typeof data.external_clinic!=='string'||!data.external_clinic.trim()) fail('Record the previous clinic or vaccination location.');
    if(data.vaccine!=null&&typeof data.vaccine!=='string') fail('Enter valid vaccine information.');
    record={source:'external',verification_method:staffRecordReview?'staff_record_review':'legacy',vaccinator_name:String(data.vaccinator_name||'').trim(),brand_name:(data.vaccine||'').trim(),generic_name:String(data.vaccine_type||'').trim(),vaccine_name:(data.vaccine||'').trim(),vaccine_type:String(data.vaccine_type||'').slice(0,200),vaccine_batch:String(data.vaccine_batch||'').slice(0,200),verification_basis:String(data.verification_basis||(staffRecordReview?'Previous dose details reviewed and confirmed by clinic staff':'Supporting vaccination documentation reviewed')).slice(0,2000),clinic_id:null,clinic_name:data.external_clinic.trim(),document_id:data.document_id||null,document_snapshot:document,verified_by:request.auth.uid,verified_at:timestamp(),verifying_clinic:a.clinic_id};
   }else if(data.action==='complete'){
    if(a.status!=='in_progress'||!a.intake_completed_at) fail('Record arrival and complete intake first.');
    if(typeof data.stock_id!=='string'||!data.stock_id||data.stock_id.includes('/')) fail('Select vaccine stock.');
    const reservation=a.stock_reservation?.status==='reserved'?a.stock_reservation:null;
    if(reservation && data.stock_id!==reservation.inventory_id) fail('Use the vaccine batch reserved at confirmation.');
    const sr=db.collection('inventory').doc(data.stock_id),stock=(await tx.get(sr)).data();
    const inventory = await readStock(tx,db,a.clinic_id);
    if(!stock||stock.clinic_id!==a.clinic_id||stock.archived||!validDate(stock.expiry)||stock.expiry<=today()||!Number.isInteger(Number(stock.quantity))||(reservation?Number(stock.quantity)<0:availableQuantity(stock)<1)||!stock.type) fail('Vaccine stock is unavailable.');
    if(reservation && (!Number.isInteger(Number(stock.reserved_count)) || Number(stock.reserved_count)<1 ||
      (stock.quantity_mode==='on_hand' && Number(stock.quantity)<Number(stock.reserved_count)))) fail('Reserved vaccine stock is unavailable.');
    record={source:'system',vaccine_name:stock.brand_name||stock.type,vaccine_type:stock.generic_name||stock.type,brand_name:stock.brand_name||'',generic_name:stock.generic_name||'',vaccine_batch:stock.batch||'',inventory_id:data.stock_id,clinic_id:a.clinic_id,clinic_name:a.clinic_name||'',administered_by:request.auth.uid,administered_by_name:staff.full_name||'',clinic_location:String(data.location||'')};
    if (!reservation) {
     tx.update(sr,{quantity:Number(stock.quantity)-1,updated_at:timestamp()});
     inventory.items.find(item=>item.id===data.stock_id).quantity=Number(stock.quantity)-1;
     publishStock(tx,db,a.clinic_id,inventory.items,timestamp);
    } else {
     const quantity = Number(stock.quantity) - (stock.quantity_mode === 'on_hand' ? 1 : 0);
     if (quantity < 0) fail('Reserved vaccine stock is unavailable.');
     const reserved_count = Math.max(0,Number(stock.reserved_count||0)-1);
     tx.update(sr,{quantity,reserved_count,updated_at:timestamp()});
     Object.assign(inventory.items.find(item=>item.id===data.stock_id), {quantity,reserved_count});
     publishStock(tx,db,a.clinic_id,inventory.items,timestamp);
    }
    tx.update(ar,{...(reservation?{stock_reservation:{...reservation,status:'consumed',consumed_at:timestamp()}}:{}),status:'completed',completed_at:timestamp(),completed_dose_number:next.dose_number,completed_vaccine_name:record.vaccine_name});
   }else fail('Unsupported action.');
   record={...record,resident_uid:a.resident_uid,resident_name:a.resident_name||'',vaccination_session_id:a.vaccination_session_id||'legacy',treatment_id:ref.id,dose_number:next.dose_number,recommended_date:next.recommended_date,appointment_date:a.preferred_date,appointment_id:data.appointment_id,date_given:data.date,actual_administration_date:data.date,verification_status:'Verified',remarks:String(data.remarks||'').slice(0,2000),recorded_at:timestamp(),status:data.action==='verify_external'?'Completed \u2013 Verified Previous Record':next.recommended_date&&data.date>next.recommended_date?'Completed?Delayed':'Completed'};
   tx.set(db.collection('vaccination_records').doc(ref.id+'-dose-'+next.dose_number),record);
   next.appointment_date=a.preferred_date;
   const updatedDoses=dosesFrom([...records,record],treatment.doses);
   tx.set(ref,{...treatment,doses:updatedDoses,updated_at:timestamp()});
   if(data.action==='verify_external'){
    const following=updatedDoses.find(d=>!d.actual_administration_date);
    if(following) tx.update(ar,{dose_number:following.dose_number,dose_label:'Dose '+following.dose_number,recommended_date:following.recommended_date});
   }
   tx.set(db.collection('notifications').doc(),{recipient_uid:a.resident_uid,user_id:a.resident_uid,type:'vaccine',title:'Dose '+next.dose_number+' '+record.status,message:'Your vaccination history was updated by '+(a.clinic_name||'your clinic')+'.',read:false,created_at:timestamp()});
   return {ok:true};
  });
 };
}
async function refreshOverdue(db){
 let cursor;
 do{
  let q=db.collection('treatments').orderBy('__name__').limit(200);if(cursor)q=q.startAfter(cursor);
  const page=await q.get();
  for(const item of page.docs) await db.runTransaction(async tx=>{
   const t=(await tx.get(item.ref)).data(),doses=t.doses.map(d=>d.actual_administration_date?d:{...d,status:d.recommended_date&&d.recommended_date<today()?'Overdue':'Pending'});
   if(JSON.stringify(doses)!==JSON.stringify(t.doses))tx.update(item.ref,{doses});
  });
  cursor=page.size===200?page.docs[page.docs.length-1]:null;
 }while(cursor);
}
module.exports={dosesFrom,loadTreatment,treatmentHandler,refreshOverdue,key,needsSeparateTreatment};
