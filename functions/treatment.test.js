
const test=require('node:test');const assert=require('node:assert/strict');
const {dosesFrom,treatmentHandler,key}=require('./treatment');
const {createBookingHandler}=require('./booking');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
function fixture(){
 const data=new Map();let sequence=0,queue=Promise.resolve();
 const collection=name=>({doc:(id='new-'+(++sequence))=>({name,id,path:name+'/'+id}),where:(k,o,v)=>{const q={name,filters:[[k,v]],where(k,o,v){this.filters.push([k,v]);return this;}};return q;}});
 const db={collection,runTransaction:fn=>{const result=queue.then(async()=>{
  const writes=[];let writing=false;
  const result=await fn({get:async ref=>{assert.equal(writing,false,'Firestore reads must precede writes');if(ref.filters)return {docs:[...data].filter(([path,value])=>path.startsWith(ref.name+'/')&&ref.filters.every(([k,v])=>value[k]===v)).map(([path,value])=>({id:path.split('/')[1],data:()=>structuredClone(value)}))};return {data:()=>data.has(ref.path)?structuredClone(data.get(ref.path)):undefined};},set:(ref,value)=>{writing=true;writes.push([ref.path,value]);},update:(ref,value)=>{writing=true;writes.push([ref.path,{...data.get(ref.path),...value}]);}});
  writes.forEach(([path,value])=>data.set(path,value));return result;
 });queue=result.catch(()=>{});return result;}};
 const token={secure_login:true,email_verified:true,firebase:{sign_in_provider:'custom'}};
 data.set('users/staff',{role:'clinic_staff',is_active:true,clinic_id:'b'});
 data.set('users/patient',{role:'resident',is_active:true});
 data.set('clinics/b',{name:'Clinic B',hours:'24 hours'});
 data.set('appointments/visit',{resident_uid:'patient',clinic_id:'b',clinic_name:'Clinic B',vaccination_session_id:'course',preferred_date:'2026-09-22',status:'in_progress',intake_completed_at:'timestamp'});
 data.set('vaccination_records/first',{resident_uid:'patient',vaccination_session_id:'course',dose_number:1,date_given:'2026-09-01',clinic_id:'a',clinic_name:'Clinic A',vaccine_name:'Vaccine A'});
 data.set('inventory/batch',{clinic_id:'b',type:'Vaccine B',expiry:'2099-01-01',quantity:10});
 const handler=treatmentHandler({db,HttpsError,timestamp:()=> 'timestamp'});
 const call=(body,uid='staff')=>handler({auth:{uid,token},data:{appointment_id:'visit',...body}});
 const book=createBookingHandler({db,HttpsError,timestamp:()=> 'timestamp',now:()=>new Date('2026-09-21T04:00:00Z')});
 return {data,call,book:body=>book({auth:{uid:'patient',token},data:{clinic_id:'b',preferred_date:'2026-09-22',preferred_time:'09:00',...body}})};
}
test('overdue is independent of a later appointment; gaps select first incomplete dose',()=>{
 const doses=dosesFrom([{dose_number:1,date_given:'2026-09-01'},{dose_number:3,date_given:'2026-09-08'}],[{dose_number:2,appointment_date:'2026-10-10'}],'2026-10-01');
 assert.equal(doses.find(d=>!d.actual_administration_date).dose_number,2);assert.equal(doses[1].status,'Overdue');assert.equal(doses[1].appointment_date,'2026-10-10');
});
test('unverified external doses never count',()=>{assert.equal(dosesFrom([{dose_number:1,date_given:'2026-09-01',source:'external'}])[0].actual_administration_date,null);});
test('receiving staff review verified history and complete delayed next dose atomically',async()=>{
 const f=fixture(),review=await f.call({action:'review'});assert.equal(review.next.dose_number,2);assert.equal(review.next.status,'Overdue');assert.deepEqual(review.history,[]);assert.equal(review.doses[0].actual_administration_date,true);assert.equal(review.doses[0].administering_clinic,null);assert.equal(review.doses[0].vaccine_used,null);
 await f.call({action:'complete',dose_number:2,confirmed:true,date:'2026-09-22',stock_id:'batch',remarks:'Reviewed'});
 const record=f.data.get('vaccination_records/'+key('patient','course')+'-dose-2');assert.equal(record.status,'Completed?Delayed');assert.equal(record.clinic_id,'b');assert.equal(record.administered_by,'staff');assert.equal(record.verification_status,'Verified');assert.equal(f.data.get('inventory/batch').quantity,9);
 assert.equal(f.data.get('treatments/'+key('patient','course')).doses[2].recommended_date,'2026-09-08');
 await assert.rejects(f.call({action:'complete',dose_number:2,confirmed:true,date:'2026-09-22',stock_id:'batch'}));assert.equal(f.data.get('inventory/batch').quantity,9);
});
test('skip, missing confirmation, wrong clinic and resident writes are rejected',async()=>{
 const f=fixture();for(const body of [{dose_number:3,confirmed:true},{dose_number:2,confirmed:false}])await assert.rejects(f.call({action:'complete',date:'2026-09-22',stock_id:'batch',...body}));
 await assert.rejects(f.call({action:'review'},'patient'),{code:'permission-denied'});
 f.data.set('users/staff',{role:'clinic_staff',is_active:true,clinic_id:'a'});await assert.rejects(f.call({action:'review'}),{code:'permission-denied'});
});
test('external history requires a matching uploaded card and staff verification',async()=>{
 const f=fixture(),body={action:'verify_external',dose_number:2,confirmed:true,date:'2026-09-04',external_clinic:'External clinic',vaccine:'Vaccine',document_id:'card'};
 await assert.rejects(f.call(body));
 f.data.set('vaccination_documents/card',{resident_uid:'patient',vaccination_session_id:'course',storage_path:'vaccination-documents/patient/card.png',download_url:'https://example.test/card'});
 await f.call(body);assert.equal((await f.call({action:'review'})).next.dose_number,3);assert.equal(f.data.get('inventory/batch').quantity,10);
});
test('schedule review preserves completed dates and records an audit',async()=>{
 const f=fixture();await assert.rejects(f.call({action:'schedule',confirmed:true,reason:'review',dates:[{dose_number:1,recommended_date:'2026-09-03'}]}));
 await f.call({action:'schedule',confirmed:true,reason:'Clinical review',dates:[{dose_number:2,recommended_date:'2026-09-05'}]});
 assert.equal((await f.call({action:'review'})).doses[1].recommended_date,'2026-09-05');assert.ok([...f.data.keys()].some(k=>k.startsWith('treatment_schedule_reviews/')));
 const notification=[...f.data.entries()].find(([key])=>key.startsWith('notifications/'))?.[1];
 assert.equal(notification.recipient_uid,'patient');assert.equal(notification.push,true);assert.equal(notification.action,'review_schedule');assert.match(notification.message,/Dose 2: 2026-09-05/);
});
test('rebooking at another clinic ignores forged dose/session and retains overdue dose',async()=>{
 const f=fixture();f.data.get('inventory/batch').quantity=20;f.data.get('appointments/visit').status='expired';
 const result=await f.book({dose_label:'Dose 5',vaccination_session_id:'forged'}),a=f.data.get('appointments/'+result.id);
 assert.equal(a.dose_number,2);assert.equal(a.vaccination_session_id,'course');assert.equal(a.recommended_date,'2026-09-04');assert.equal(f.data.get('treatments/'+a.treatment_id).doses[1].status,'Overdue');
});
test('concurrent dose completion decrements inventory once',async()=>{
 const f=fixture(),body={action:'complete',dose_number:2,confirmed:true,date:'2026-09-22',stock_id:'batch'};
 const results=await Promise.allSettled([f.call(body),f.call(body)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.data.get('inventory/batch').quantity,9);
});

test('completed treatment starts a separate server-owned course and preserves previous history',async()=>{
 const f=fixture();f.data.get('appointments/visit').status='completed';
 f.data.get('inventory/batch').quantity=20;
 for(let n=2;n<=5;n++)f.data.set('vaccination_records/d'+n,{resident_uid:'patient',vaccination_session_id:'course',dose_number:n,date_given:'2026-09-20'});
 const before=[...f.data].filter(([path])=>path.startsWith('vaccination_records/'));
 const oldTreatment={resident_uid:'patient',vaccination_session_id:'course',doses:dosesFrom(before.map(([,record])=>record))};
 f.data.set('treatments/'+key('patient','course'),oldTreatment);
 const result=await f.book({vaccination_session_id:'forged-course',dose_label:'Dose 5'});
 const appointment=f.data.get('appointments/'+result.id);
 assert.equal(appointment.vaccination_session_id,result.id);
 assert.equal(result.vaccination_session_id,result.id);
 assert.equal(appointment.dose_number,1);
 assert.deepEqual(appointment.course_vaccination_history,[]);
 assert.equal(appointment.recommended_date,null);
 assert.equal(appointment.status,'pending');
 assert.deepEqual(f.data.get('treatments/'+key('patient','course')),oldTreatment);
 assert.deepEqual([...f.data].filter(([path])=>path.startsWith('vaccination_records/')),before);
 const newTreatment=f.data.get('treatments/'+key('patient',result.id));
 assert.ok(newTreatment.doses.every(dose=>!dose.actual_administration_date));
 await assert.rejects(f.book(),{code:'already-exists'});
 appointment.status='cancelled';
 const retry=await f.book();
 assert.equal(retry.vaccination_session_id,result.vaccination_session_id);
 assert.equal(f.data.get('appointments/'+retry.id).dose_number,1);
});

test('review repairs an existing new Dose 1 appointment linked to a completed course',async()=>{
 const f=fixture();
 const appointment=f.data.get('appointments/visit');
 Object.assign(appointment,{dose_number:1,dose_label:'Dose 1 (Day 0)',patient_record_id:'visit'});
 f.data.set('patient_records/visit',{resident_uid:'patient',clinic_id:'b',vaccination_session_id:'course',bite_body_part:'Left hand'});
 f.data.get('vaccination_records/first').appointment_id='previous-visit';
 for(let n=2;n<=5;n++)f.data.set('vaccination_records/d'+n,{resident_uid:'patient',vaccination_session_id:'course',appointment_id:'previous-'+n,dose_number:n,date_given:'2026-09-20',clinic_id:'b'});
 const history=[...f.data].filter(([path])=>path.startsWith('vaccination_records/'));
 const original={resident_uid:'patient',vaccination_session_id:'course',doses:dosesFrom(history.map(([,record])=>record))};
 f.data.set('treatments/'+key('patient','course'),original);
 const review=await f.call({action:'review'});
 assert.equal(review.next.dose_number,1);
 assert.deepEqual(review.history,[]);
 assert.ok(review.doses.every(dose=>!dose.actual_administration_date));
 assert.equal(f.data.get('appointments/visit').vaccination_session_id,'renewal-visit');
 assert.equal(f.data.get('patient_records/visit').vaccination_session_id,'renewal-visit');
 assert.equal(f.data.get('patient_records/visit').bite_body_part,'Left hand');
 assert.deepEqual(f.data.get('treatments/'+key('patient','course')),original);
 assert.deepEqual([...f.data].filter(([path])=>path.startsWith('vaccination_records/')),history);
 const retry=await f.call({action:'review'});
 assert.equal(retry.next.dose_number,1);
 assert.equal([...f.data.keys()].filter(path=>path.startsWith('treatments/')).length,2);
});

test('completed appointments and visits with recorded doses cannot be reset as new treatment',()=>{
 const {needsSeparateTreatment}=require('./treatment');
 const records=[1,2,3,4,5].map(n=>({dose_number:n,date_given:'2026-09-20',appointment_id:'old-'+n}));
 const appointment={dose_number:1,status:'in_progress',preferred_date:'2026-09-22'};
 assert.equal(needsSeparateTreatment(appointment,records,'new-visit'),true);
 assert.equal(needsSeparateTreatment({...appointment,status:'completed'},records,'new-visit'),false);
 assert.equal(needsSeparateTreatment({...appointment,dose_number:2},records,'new-visit'),false);
 assert.equal(needsSeparateTreatment(appointment,records,'old-1'),false);
 assert.equal(needsSeparateTreatment({...appointment,preferred_date:'2026-09-01'},records,'new-visit'),false);
 assert.equal(needsSeparateTreatment(appointment,records.slice(0,4),'new-visit'),false);
 assert.equal(needsSeparateTreatment({...appointment,created_at:{toMillis:()=>10}},records.map(record=>({...record,recorded_at:{toMillis:()=>20}})),'new-visit'),false);
});
test('future and invalid administration dates do not consume stock',async()=>{
 const f=fixture();for(const date of ['2099-01-01','2026-02-30','2026-08-01'])await assert.rejects(f.call({action:'complete',dose_number:2,confirmed:true,date,stock_id:'batch'}));
 assert.equal(f.data.get('inventory/batch').quantity,10);
});

test('previous Dose 1 and 2 without cards advance the continuous course with scheduled next dates',async()=>{
 const f=fixture();f.data.delete('vaccination_records/first');
 await assert.rejects(f.call({action:'verify_external',dose_number:1,confirmed:true,date:'2026-09-01',external_clinic:'Clinic A'}));
 for(const n of [1,2]){
  await f.call({action:'verify_external',dose_number:n,confirmed:true,date:n===1?'2026-09-01':'2026-09-04',external_clinic:'Clinic A',verification_basis:'Prior clinic confirmed its administration register'});
  const review=await f.call({action:'review'});
  assert.equal(review.next.dose_number,n+1);
  assert.equal(review.next.recommended_date,n===1?'2026-09-04':'2026-09-08');
  assert.equal(review.doses[n-1].status,'Completed');
  assert.equal(f.data.get('appointments/visit').dose_number,n+1);
 }
 assert.equal(f.data.get('inventory/batch').quantity,10);
 await f.call({action:'schedule',confirmed:true,reason:'Dates confirmed against approved clinic protocol',dates:[{dose_number:3,recommended_date:'2026-09-08'}]});
 await f.call({action:'complete',dose_number:3,confirmed:true,date:'2026-09-08',stock_id:'batch'});
 const review=await f.call({action:'review'});assert.equal(review.next.dose_number,4);assert.equal(review.history.length,1);assert.ok(review.history.every(record=>record.clinic_id==='b'));
 assert.equal(new Set(review.history.map(r=>r.treatment_id)).size,1);
});
test('external verification rejects a card from another course and duplicate verification',async()=>{
 const f=fixture();const body={action:'verify_external',dose_number:2,confirmed:true,date:'2026-09-04',external_clinic:'Clinic A',document_id:'wrong'};
 f.data.set('vaccination_documents/wrong',{resident_uid:'patient',vaccination_session_id:'another',storage_path:'vaccination-documents/patient/card.png',download_url:'https://example.test/card'});
 await assert.rejects(f.call(body));
 await f.call({...body,document_id:'',verification_basis:'Confirmed clinic register'});
 await assert.rejects(f.call({...body,document_id:'',verification_basis:'Confirmed clinic register'}));
});


test('Dose 2 through 5 require every previous record before completion',async()=>{
 for(const selected of [2,3,4,5]){
  const f=fixture();f.data.delete('vaccination_records/first');
  const complete={action:'complete',dose_number:selected,confirmed:true,date:'2026-09-10',stock_id:'batch'};
  for(let previous=1;previous<selected;previous++){
   await assert.rejects(f.call(complete));
   assert.equal(f.data.get('inventory/batch').quantity,10);
   await f.call({action:'verify_external',dose_number:previous,selected_dose_number:selected,confirmed:true,date:'2026-09-0'+previous,external_clinic:'Previous clinic',verification_basis:'Clinic register reviewed'});
   const review=await f.call({action:'review'});
   assert.equal(review.doses[previous-1].status,'Completed');
   assert.equal(review.next.dose_number,previous+1);
  }
  await f.call(complete);
  assert.equal(f.data.get('inventory/batch').quantity,9);
  assert.equal((await f.call({action:'review'})).doses[selected-1].actual_administration_date,'2026-09-10');
 }
});

test('verifying a gap respects administration dates of earlier and later records',async()=>{
 const f=fixture();f.data.set('vaccination_records/later',{resident_uid:'patient',vaccination_session_id:'course',dose_number:3,date_given:'2026-09-08'});
 const body={action:'verify_external',dose_number:2,selected_dose_number:4,confirmed:true,external_clinic:'Previous clinic',verification_basis:'Register reviewed'};
 await assert.rejects(f.call({...body,date:'2026-09-09'}));
 await f.call({...body,date:'2026-09-04'});
 assert.equal((await f.call({action:'review'})).next.dose_number,4);
});

test('staff record review saves essential vaccine details and optional vaccinator',async()=>{
 const f=fixture(),body={action:'verify_external',dose_number:2,selected_dose_number:3,confirmed:true,date:'2026-09-04',verification_method:'staff_record_review',external_clinic:'Clinic A',vaccine:'Brand A',vaccine_type:'Rabies vaccine',vaccine_batch:'LOT-123',vaccinator_name:'Nurse A'};
 for(const field of ['vaccine','vaccine_type','vaccine_batch','external_clinic'])await assert.rejects(f.call({...body,[field]:''}));
 await f.call(body);
 const record=f.data.get('vaccination_records/'+key('patient','course')+'-dose-2');
 assert.equal(record.brand_name,'Brand A');assert.equal(record.generic_name,'Rabies vaccine');assert.equal(record.vaccine_batch,'LOT-123');assert.equal(record.vaccinator_name,'Nurse A');assert.equal(record.verification_method,'staff_record_review');assert.equal(record.verified_by,'staff');assert.equal(f.data.get('inventory/batch').quantity,10);
 const optional=fixture();await optional.call({...body,vaccinator_name:''});
 assert.equal(optional.data.get('vaccination_records/'+key('patient','course')+'-dose-2').vaccinator_name,'');
});

test('verified external Dose 1 schedules Dose 3 on Day 7 and retains staff overrides',()=>{
 const records=[{dose_number:1,date_given:'2026-09-30',source:'external',verification_status:'Verified'},{dose_number:2,date_given:'2026-10-03'}];
 assert.equal(dosesFrom(records,[],'2026-10-03')[2].recommended_date,'2026-10-07');
 assert.equal(dosesFrom(records,[{dose_number:3,recommended_date:'2026-10-08'}])[2].recommended_date,'2026-10-08');
});

test('reserved dose completes with zero unreserved stock and does not deduct twice',async()=>{
 const f=fixture();f.data.get('inventory/batch').quantity=0;f.data.get('inventory/batch').reserved_count=1;
 f.data.get('appointments/visit').stock_reservation={status:'reserved',inventory_id:'batch',quantity:1};
 const review=await f.call({action:'review'});
 assert.equal(review.clinic_id,'b');
 assert.equal(review.stock_reservation.inventory_id,'batch');
 await f.call({action:'complete',dose_number:2,confirmed:true,date:'2026-09-22',stock_id:'batch'});
 assert.equal(f.data.get('inventory/batch').quantity,0);
 assert.equal(f.data.get('inventory/batch').reserved_count,0);
 assert.equal(f.data.get('appointments/visit').stock_reservation.status,'consumed');
 assert.equal(f.data.get('appointments/visit').status,'completed');
});

test('completion consumes physical stock once and keeps availability at 49',async()=>{
 const f=fixture();Object.assign(f.data.get('inventory/batch'),{quantity:50,reserved_count:1,quantity_mode:'on_hand'});
 f.data.get('appointments/visit').stock_reservation={status:'reserved',inventory_id:'batch',quantity:1};
 await f.call({action:'complete',dose_number:2,confirmed:true,date:'2026-09-22',stock_id:'batch'});
 assert.equal(f.data.get('inventory/batch').quantity,49);
 assert.equal(f.data.get('inventory/batch').reserved_count,0);
 assert.equal(f.data.get('clinics/b').stock_total,49);
 await assert.rejects(f.call({action:'complete',dose_number:2,confirmed:true,date:'2026-09-22',stock_id:'batch'}));
 assert.equal(f.data.get('inventory/batch').quantity,49);
});

test('missing or inconsistent reservation counts cannot consume physical stock',async()=>{
 for(const changes of [{reserved_count:0},{reserved_count:undefined},{reserved_count:0.5},{quantity:0},{quantity:1,reserved_count:2}]) {
  const f=fixture();
  Object.assign(f.data.get('inventory/batch'),{quantity:50,reserved_count:1,quantity_mode:'on_hand'},changes);
  f.data.get('appointments/visit').stock_reservation={status:'reserved',inventory_id:'batch',quantity:1};
  const before=structuredClone(f.data.get('inventory/batch'));
  await assert.rejects(f.call({action:'complete',dose_number:2,confirmed:true,date:'2026-09-22',stock_id:'batch'}),{code:'failed-precondition'});
  assert.deepEqual(f.data.get('inventory/batch'),before);
  assert.equal(f.data.get('appointments/visit').status,'in_progress');
  assert.equal(f.data.has('vaccination_records/'+key('patient','course')+'-dose-2'),false);
 }
});
