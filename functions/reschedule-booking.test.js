const test = require('node:test');
const assert = require('node:assert/strict');
const {rescheduleBookingHandler}=require('./booking');
class HttpsError extends Error {constructor(code,message){super(message);this.code=code}}
function fixture() {
 let item={resident_uid:'resident',clinic_id:'clinic',status:'confirmed',preferred_date:'2026-09-24',preferred_time:'9:00 AM'};
 let clinic={hours:'5 AM - 5 PM'}, clock=new Date('2026-09-24T00:00:00Z');
 const db={collection:name=>({doc:id=>({name,id}),where:()=>({query:true})}),runTransaction:async fn=>fn({
  get:async ref=>ref.query?{docs:[{id:'a',data:()=>item}]}:({data:()=>ref.name==='users'?{role:'resident',is_active:true}:ref.name==='clinics'?clinic:item}),
  set:()=>{},
  update:(_ref,data)=>{item={...item,...data}}
 })};
 const handler=rescheduleBookingHandler({db,HttpsError,timestamp:()=> 'server',now:()=>clock});
 const auth={uid:'resident',token:{secure_login:true,email_verified:true,firebase:{sign_in_provider:'custom'}}};
 return {call:(date,time)=>handler({auth,data:{appointment_id:'a',preferred_date:date,preferred_time:time}}),
  get:()=>item,at:value=>{clock=new Date(value)},clinic:value=>{clinic=value}};
}
test('reschedule validates current clinic hours and resets approval',async()=>{
 const f=fixture();
 await assert.rejects(f.call('2026-09-24','6:00 PM'),{code:'invalid-argument'});
 await f.call('2026-09-24','10:00 AM');
 assert.equal(f.get().status,'pending');assert.equal(f.get().arrival_deadline_ms,null);
 assert.equal(f.get().scheduled_at_ms,Date.parse('2026-09-24T02:00:00Z'));
});
test('reschedule rejects past times, closed dates, non-slots and dates beyond the next day',async()=>{
 for(const [date,time] of [['2026-09-24','7:00 AM'],['2026-09-24','8:00 AM'],['2026-09-24','10:10 AM'],['2026-09-26','10:00 AM']]) {
  await assert.rejects(fixture().call(date,time),{code:'invalid-argument'});
 }
 const f=fixture();f.clinic({hours:'Closed'});
 await assert.rejects(f.call('2026-09-24','10:00 AM'),{code:'invalid-argument'});
});
test('elapsed arrival window cannot be bypassed by rescheduling',async()=>{
 const f=fixture();f.at('2026-09-24T02:30:00Z');
 await assert.rejects(f.call('2026-09-25','10:00 AM'),{code:'failed-precondition'});
});
