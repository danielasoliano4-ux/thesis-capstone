const test = require('node:test');
const assert = require('node:assert/strict');
const core = import('../scripts/dose-stock.mjs');
const stock = { clinic_id:'clinic', type:'Verorab', batch:'B1', expiry:'2026-12-01', quantity:2 };
const appointment = { clinic_id:'clinic', status:'in_progress', intake_completed_at:'saved', resident_uid:'resident', dose_label:'Dose 2' };
const values = { clinicId:'clinic', today:'2026-09-26', date:'2026-09-26', doseNumber:2, location:'Clinic address', uid:'staff', timestamp:'server' };
const refs = Object.fromEntries(['appointment','stock','record','notification'].map(id=>[id,{id}]));
function fixture(overrides={}) {
 const rows = new Map(Object.entries({appointment:{...appointment},stock:{...stock},...overrides}));
 return {rows, async run(input=values, fail=false) {
   const {commitDose}=await core;
   const writes=[];
   await commitDose({get:async ref=>({data:()=>rows.get(ref.id),exists:()=>rows.has(ref.id)}),
     set:(ref,data)=>writes.push([ref.id,data]), update:(ref,data)=>writes.push([ref.id,{...rows.get(ref.id),...data}])},refs,input);
   if(fail) throw Error('Simulated commit failure');
   for(const [id,data] of writes) rows.set(id,data);
 }};
}
test('stock choices exclude other clinics, expired, empty, archived and malformed quantities; earliest expiry first',async()=>{
 const {availableStock}=await core;
 const early={...stock,batch:'early',expiry:'2026-09-26'};
 const rows=[stock,early,...[{clinic_id:'other'},{expiry:'2026-09-25'},{expiry:''},{quantity:0},{quantity:-1},{quantity:'invalid'},{quantity:0.5},{archived:true}].map(change=>({...stock,...change}))];
 assert.deepEqual(availableStock(rows,'clinic',values.today).map(item=>item.batch),['early','B1']);
});
test('completion deducts one dose and saves matching batch, record, appointment and notification',async()=>{
 const f=fixture();await f.run();
 assert.equal(f.rows.get('stock').quantity,1);
 assert.equal(f.rows.get('record').vaccine_batch,'B1');
 assert.equal(f.rows.get('record').inventory_id,'stock');
 assert.equal(f.rows.get('record').vaccine_name,'Verorab');
 assert.equal(f.rows.get('appointment').status,'completed');
 assert.equal(f.rows.get('notification').recipient_uid,'resident');
});
test('repeat completion cannot deduct stock again',async()=>{
 const f=fixture();await f.run();await assert.rejects(f.run(),/already/);
 assert.equal(f.rows.get('stock').quantity,1);
});
test('retries after another completion see committed appointment and cannot double deduct',async()=>{
 const f=fixture();await f.run();await assert.rejects(f.run(),/already/);
 assert.equal(f.rows.get('stock').quantity,1);
});
test('unavailable or changed stock is rejected before any writes',async()=>{
 for(const change of [{quantity:0},{archived:true},{expiry:'2026-09-25'},{expiry:''},{clinic_id:'other'}]) {
  const f=fixture({stock:{...stock,...change}});await assert.rejects(f.run(),/no longer available/);
  assert.equal(f.rows.has('record'),false);assert.equal(f.rows.get('appointment').status,'in_progress');
 }
});
test('wrong clinic, incomplete intake, changed dose, future date and missing location are rejected',async()=>{
 for(const change of [{clinic_id:'other'},{status:'confirmed'},{intake_completed_at:null}]) {
  const f=fixture({appointment:{...appointment,...change}});await assert.rejects(f.run());assert.equal(f.rows.get('stock').quantity,2);
 }
 for(const change of [{doseNumber:3},{doseNumber:0},{date:'2026-09-27'},{date:'2026-02-30'},{location:' '}]) {
  const f=fixture();await assert.rejects(f.run({...values,...change}));assert.equal(f.rows.get('stock').quantity,2);
 }
});
test('failed transaction commits no stock or patient changes and can be retried',async()=>{
 const f=fixture();await assert.rejects(f.run(values,true),/commit failure/);
 assert.equal(f.rows.get('stock').quantity,2);assert.equal(f.rows.has('record'),false);
 await f.run();assert.equal(f.rows.get('stock').quantity,1);
});
