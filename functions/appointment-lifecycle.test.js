const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduledTime, deadline, isNoShow, lifecycleHandler, deleteNoShow, cleanupAppointments } = require('./appointment-lifecycle');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const base = { clinic_id:'clinic', resident_uid:'resident', resident_name:'Resident', clinic_name:'Clinic', preferred_date:'2026-09-24', preferred_time:'9:00 AM', status:'pending' };
const intake = { bite_type:'Scratch', wound_washed:'Yes', animal_type:'Dog', bite_body_part:'Left leg', bite_date:'2026-09-23', patient_age:24, patient_sex:'Female', patient_category:'Category II' };
function fixture(item = base) {
  let clock = new Date('2026-09-24T00:00:00Z'), sequence=0, queue=Promise.resolve();
  const rows=new Map([['users/staff',{role:'clinic_staff',is_active:true,clinic_id:'clinic'}],['appointments/a',{...item}]]);
  const db={collection:name=>({path:name,doc:id=>({path:name+'/'+(id || ++sequence)})}),
    runTransaction:fn=>{
      const result=queue.then(async()=>{
        const writes=[];
        const tx={
          get:async ref=>ref.path === 'patient_records' ? {docs:[...rows.entries()].filter(([key])=>key.startsWith('patient_records/')).map(([key,value])=>({id:key.split('/')[1],data:()=>value}))} : ({exists:rows.has(ref.path),data:()=>rows.get(ref.path)}),
          update:(ref,data)=>writes.push(()=>rows.set(ref.path,{...rows.get(ref.path),...data})),
          set:(ref,data)=>writes.push(()=>rows.set(ref.path,data)),
          delete:ref=>writes.push(()=>rows.delete(ref.path))
        };
        const value=await fn(tx); writes.forEach(write=>write());return value;
      });
      queue=result.catch(()=>{});return result;
    }};
  const now=()=>clock;
  const handler=lifecycleHandler({db,HttpsError,timestamp:()=>clock.toISOString(),now});
  const auth={uid:'staff',token:{secure_login:true,email_verified:true,firebase:{sign_in_provider:'custom'}}};
  return {rows,db,now,at:value=>{clock=new Date(value)},call:(action,extra={},identity=auth)=>handler({auth:identity,data:{appointment_id:'a',action,...extra}}),clean:()=>deleteNoShow(db,{path:'appointments/a'},now)};
}
test('Manila time parsing, noon/midnight, invalid dates and 90-minute boundary',()=>{
 assert.equal(scheduledTime('2026-09-24','9:00 AM'),Date.parse('2026-09-24T01:00:00Z'));
 assert.equal(scheduledTime('2026-09-24','12:00 AM'),Date.parse('2026-09-23T16:00:00Z'));
 assert.equal(scheduledTime('2026-09-24','12:00 PM'),Date.parse('2026-09-24T04:00:00Z'));
 for(const [d,t] of [['2026-02-30','9:00 AM'],['2026-09-24','13:00 PM'],['2026-09-24','09:61'],['2026-09-24','abc']]) assert.ok(Number.isNaN(scheduledTime(d,t)));
 assert.equal(deadline(base),Date.parse('2026-09-24T02:30:00Z'));
 assert.equal(isNoShow({...base,status:'confirmed'},new Date('2026-09-24T02:29:59Z')),false);
 assert.equal(isNoShow({...base,status:'confirmed'},new Date('2026-09-24T02:30:00Z')),true);
});
test('confirmation uses scheduled time, never time of staff confirmation',async()=>{
 const f=fixture();await f.call('confirm');
 assert.equal(f.rows.get('appointments/a').arrival_deadline_ms,Date.parse('2026-09-24T02:30:00Z'));
 assert.equal(f.rows.get('appointments/a').status,'confirmed');
 assert.equal([...f.rows.keys()].filter(k=>k.startsWith('notifications/')).length,1);
});
test('arrival is disallowed before the Manila appointment date and at/after deadline',async()=>{
 for(const time of ['2026-09-23T15:59:59.999Z','2026-09-24T02:30:00Z','2026-09-24T03:00:00Z']){
  const f=fixture();await f.call('confirm');f.at(time);
  await assert.rejects(f.call('arrive'),{code:'failed-precondition'});
  assert.equal(f.rows.get('appointments/a').status,'confirmed');
 }
});
test('early arrival on the Manila appointment date, scheduled arrival and arrival before deadline are accepted',async()=>{
 for(const time of ['2026-09-23T16:00:00Z','2026-09-24T00:00:00Z','2026-09-24T00:59:59Z','2026-09-24T01:00:00Z','2026-09-24T02:29:59.999Z']){
  const f=fixture();await f.call('confirm');f.at(time);await f.call('arrive');
  assert.equal(f.rows.get('appointments/a').status,'in_progress');
  assert.equal(f.rows.get('appointments/a').arrived_at,new Date(time).toISOString());
  assert.equal(f.rows.get('appointments/a').arrived_by,'staff');
  f.at('2026-09-25T10:00:00Z');assert.equal(await f.clean(),false);
  await f.call('arrive'); // idempotent retry after the window
 }
});
test('cleanup archives only confirmed no-shows; preserves pending/arrived/completed',async()=>{
 for(const status of ['pending','in_progress','completed','cancelled','declined']){
  const f=fixture({...base,status});f.at('2026-09-25T00:00:00Z');assert.equal(await f.clean(),false);assert.ok(f.rows.has('appointments/a'));
 }
 const f=fixture({...base,status:'confirmed'});f.at('2026-09-24T02:30:00Z');
 assert.equal(await f.clean(),true);assert.equal(f.rows.get('appointments/a').status,'expired');assert.equal(f.rows.get('appointments/a').archived,true);assert.equal(await f.clean(),false);
});
test('arrival and cleanup serialize so recorded arrivals cannot be removed',async()=>{
 const f=fixture({...base,status:'confirmed'});f.at('2026-09-24T02:29:59Z');
 await Promise.all([f.call('arrive'),f.clean()]);
 f.at('2026-09-24T02:31:00Z');await f.clean();assert.ok(f.rows.get('appointments/a').arrived_at);
 const late=fixture({...base,status:'confirmed'});late.at('2026-09-24T02:30:00Z');
 const results=await Promise.allSettled([late.clean(),late.call('arrive')]);
 assert.equal(results[1].status,'rejected');assert.equal(late.rows.get('appointments/a').status,'expired');
});
test('intake requires arrival and creates a permanent record atomically; retries do not overwrite',async()=>{
 const f=fixture();await assert.rejects(f.call('intake',{intake}),{code:'failed-precondition'});
 await f.call('confirm');f.at('2026-09-24T01:00:00Z');await f.call('arrive');
 f.at('2026-09-24T04:00:00Z');await f.call('intake',{intake});
 const record=f.rows.get('patient_records/a');
 assert.equal(record.patient_category,'Category II');
 assert.equal(f.rows.get('appointments/a').patient_category,'Category II');
 assert.equal(f.rows.get('appointments/a').course_intake_data.patient_category,'Category II');
 assert.equal(record.patient_age,24);assert.equal(record.resident_uid,'resident');assert.equal(record.clinic_id,'clinic');
 assert.equal(f.rows.get('appointments/a').patient_record_id,'a');
 await f.call('intake',{intake:{...intake,patient_age:99}});assert.equal(f.rows.get('patient_records/a').patient_age,24);
 await f.clean();assert.ok(f.rows.has('patient_records/a'));
});
test('intake rejects missing/invalid medical fields without partial writes',async()=>{
 for(const changes of [{patient_category:undefined},{patient_category:''},{bite_type:''},{wound_washed:'Maybe'},{patient_age:-1},{patient_age:1.5},{patient_age:'24'},{patient_sex:''},{bite_date:'2026-09-25'},{bite_date:'2026-02-30'}]){
  const f=fixture({...base,status:'in_progress',arrived_at:'server'});f.at('2026-09-24T01:00:00Z');
  await assert.rejects(f.call('intake',{intake:{...intake,...changes}}),{code:'invalid-argument'});
  assert.equal(f.rows.has('patient_records/a'),false);assert.equal(f.rows.get('appointments/a').intake_completed_at,undefined);
 }
});
test('unauthenticated, inactive and wrong-clinic staff cannot mutate appointments',async()=>{
 const f=fixture();await assert.rejects(f.call('confirm',{},null),{code:'unauthenticated'});
 for(const profile of [{role:'resident',is_active:true,clinic_id:'clinic'},{role:'clinic_staff',is_active:false,clinic_id:'clinic'},{role:'clinic_staff',is_active:true,clinic_id:'other'},{role:'clinic_staff',is_active:true,clinic_id:'clinic',approval_status:'pending'}]){
  f.rows.set('users/staff',profile);await assert.rejects(f.call('confirm'),{code:'permission-denied'});
 }
});
test('late confirmation is rejected and malformed schedules are not deleted',async()=>{
 const f=fixture();f.at('2026-09-24T02:30:00Z');await assert.rejects(f.call('confirm'),{code:'failed-precondition'});
 const bad=fixture({...base,status:'confirmed',preferred_time:'unknown'});bad.at('2026-09-25T00:00:00Z');assert.equal(await bad.clean(),false);
});
test('cleanup scans beyond its first page',async()=>{
 const rows=Array.from({length:205},(_,i)=>({id:String(i).padStart(3,'0'),ref:{id:String(i)},data:()=>({...base,status:'confirmed'})}));
 let calls=0, removed=0;
 const db={collection:()=>({doc:id=>({id}),where:()=>({orderBy:()=>({limit:()=>({
   startAfter(cursor){this.cursor=cursor;return this}, async get(){calls++;const start=this.cursor?Number(this.cursor.id)+1:0;const docs=rows.slice(start,start+200);return{docs,size:docs.length}}
 })})})}),runTransaction:async fn=>fn({get:async()=>({data:()=>({...base,status:'confirmed'})}),update:()=>removed++,set:()=>{}})};
 assert.equal(await cleanupAppointments(db,()=>new Date('2026-09-24T02:30:00Z')),205);
 assert.equal(removed,205);assert.equal(calls,2);
});

test('Other requires text and saves the animal name with live aggregate totals', async()=>{
 const f=fixture({...base,status:'in_progress',arrived_at:'server'});
 for (const animal_other of ['', '   ', 'x'.repeat(161)])
  await assert.rejects(f.call('intake',{intake:{...intake,animal_type:'Other',animal_other}}),{code:'invalid-argument'});
 await f.call('intake',{intake:{...intake,animal_type:'Other',animal_other:'  Monkey  '}});
 assert.equal(f.rows.get('patient_records/a').animal_type,'Monkey');
 assert.deepEqual(f.rows.get('system_settings/animal_exposure').animals,[{name:'Other',count:1,percent:100}]);
});
test('animal totals use recorded cases, group other animals and avoid repeat-dose duplicates',()=>{
 const {animalExposureSummary}=require('./appointment-lifecycle');
 assert.deepEqual(animalExposureSummary([]),[]);
 const records=[{resident_uid:'a',animal_type:'Dog'},{resident_uid:'a',animal_type:'Dog'},
 {resident_uid:'b',animal_type:'Cat'},{resident_uid:'c',animal_type:'Monkey'},
 {resident_uid:'d',animal_type:''}];
 assert.deepEqual(animalExposureSummary(records),['Dog','Cat','Other'].map(name=>({name,count:1,percent:33})));
});

test('intake rejects unsupported dropdown values',async()=>{
 for(const changes of [{patient_category:'Category IV'},{bite_type:'Invalid'},{animal_type:'Monkey'}]){
  const f=fixture({...base,status:'in_progress',arrived_at:'server'});
  await assert.rejects(f.call('intake',{intake:{...intake,...changes}}),{code:'invalid-argument'});
  assert.equal(f.rows.has('patient_records/a'),false);
 }
});

test('pending requests expire exactly at scheduled time and retain their record', async () => {
 const { expirePendingAppointment } = require('./appointment-lifecycle');
 const f = fixture();
 const expire = () => expirePendingAppointment(f.db, {path:'appointments/a'}, f.now);
 f.at('2026-09-24T00:59:59.999Z'); assert.equal(await expire(),false);
 f.at('2026-09-24T01:00:00Z'); assert.equal(await expire(),true);
 const record=f.rows.get('appointments/a');
 assert.equal(record.status,'expired'); assert.equal(record.resident_uid,'resident');
 assert.equal(record.expiration_reason,'not_confirmed_before_scheduled_time');
 assert.equal(await expire(),false);
 await assert.rejects(f.call('confirm'), {code:'failed-precondition'});
});
test('confirmation at scheduled time is rejected even before the expiry sweep',async()=>{
 const f=fixture();f.at('2026-09-24T01:00:00Z');
 await assert.rejects(f.call('confirm'),{code:'failed-precondition'});
});
test('expiry cannot change confirmed, arrived, completed or malformed requests', async()=>{
 const { expirePendingAppointment } = require('./appointment-lifecycle');
 for(const changes of [{status:'confirmed'}, {status:'in_progress',arrived_at:'saved'}, {status:'completed'}, {preferred_time:'unknown'}]) {
  const f=fixture({...base,...changes}); f.at('2026-09-25T00:00:00Z');
  assert.equal(await expirePendingAppointment(f.db,{path:'appointments/a'},f.now),false);
  assert.deepEqual(f.rows.get('appointments/a'),{...base,...changes});
 }
});
test('concurrent expiry and acceptance at cutoff leave a retained expired record',async()=>{
 const { expirePendingAppointment } = require('./appointment-lifecycle');
 const f=fixture();f.at('2026-09-24T01:00:00Z');
 const result=await Promise.allSettled([f.call('confirm'),expirePendingAppointment(f.db,{path:'appointments/a'},f.now)]);
 assert.equal(result[0].status,'rejected');assert.equal(f.rows.get('appointments/a').status,'expired');
});
test('past pending requests stop blocking new bookings in server and browser',()=>{
 const {activeBooking}=require('./booking');
 const fs=require('node:fs'),vm=require('node:vm');
 const source=fs.readFileSync(require('node:path').join(__dirname,'../scripts/booking-status.js'),'utf8').replaceAll('export function','function');
 const context={};vm.createContext(context);vm.runInContext(source,context);
 const time=Date.parse('2026-09-24T01:00:00Z');
 assert.equal(activeBooking(base,'2026-09-24',new Date(time)),false);
 assert.equal(context.clinicBooking([base],'clinic','2026-09-24',time),null);
 assert.equal(activeBooking(base,'2026-09-24',new Date(time-1)),true);
 assert.ok(context.clinicBooking([base],'clinic','2026-09-24',time-1));
});

test('expiry writes audit history and resident rebooking notification once',async()=>{
 const {expirePendingAppointment}=require('./appointment-lifecycle');
 for(const status of ['pending','confirmed']) {
  const f=fixture({...base,status});f.at('2026-09-24T03:00:00Z');
  const expire=()=>status==='pending'?expirePendingAppointment(f.db,{path:'appointments/a'},f.now):f.clean();
  await expire();const size=f.rows.size;await expire();assert.equal(f.rows.size,size);
  assert.equal(f.rows.get('history/appointment-expired-a').action,'expired');
  assert.equal(f.rows.get('notifications/appointment-expired-a').action,'rebook');
  assert.equal(f.rows.get('appointments/a').resident_uid,'resident');
 }
});

test('legacy appointments missing clinic assignment do not abort expiry',async()=>{
 const {expirePendingAppointment}=require('./appointment-lifecycle');
 for(const status of ['pending','confirmed','expired']) {
  const item={...base,status};delete item.clinic_id;const f=fixture(item);f.at('2026-09-25T00:00:00Z');
  assert.equal(await (status==='confirmed'?f.clean():expirePendingAppointment(f.db,{path:'appointments/a'},f.now)),false);
  assert.deepEqual(f.rows.get('appointments/a'),item);
 }
});
test('legacy expired records can be archived without an undefined resident or schedule',async()=>{
 const {expirePendingAppointment}=require('./appointment-lifecycle');
 const f=fixture({clinic_id:'clinic',status:'expired'});await expirePendingAppointment(f.db,{path:'appointments/a'},f.now);
 const history=f.rows.get('history/appointment-expired-a');assert.ok(history);assert.ok(Object.values(history).every(value=>value!==undefined));
 assert.equal(f.rows.has('notifications/appointment-expired-a'),false);
});
