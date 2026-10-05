const test=require('node:test');const assert=require('node:assert/strict');
const {requireBookingStock,availableQuantity,releaseReservation}=require('./stock-reservations');
class HttpsError extends Error {constructor(code,message){super(message);this.code=code;}}
test('server rejects low and empty inventory regardless of stale clinic summary',async()=>{
 for(const quantity of [0,1,15]){
  const tx={get:async()=>({docs:[{id:'batch',data:()=>({clinic_id:'clinic',type:'Vaccine',quantity,expiry:'2099-01-01'})}]})};
  const db={collection:()=>({where:()=>({})})};
  await assert.rejects(requireBookingStock(tx,db,'clinic',HttpsError,new Date('2026-09-24')),{code:'failed-precondition'});
 }
});
test('sixteen usable doses permit booking; archived and expired batches do not count',async()=>{
 const items=[{type:'Vaccine',quantity:16,expiry:'2099-01-01'},{type:'Vaccine',quantity:100,expiry:'2026-09-24'},{type:'Vaccine',quantity:100,expiry:'2099-01-01',archived:true}];
 const tx={get:async()=>({docs:items.map((data,i)=>({id:String(i),data:()=>data}))})};
 const db={collection:()=>({where:()=>({})})};
 assert.equal((await requireBookingStock(tx,db,'clinic',HttpsError,new Date('2026-09-24'))).total,16);
});

test('browser separates physical inventory and reservations including legacy batches',async()=>{
 const {availableQuantity,physicalQuantity,summarizeStock}=await import('../scripts/stock-summary.mjs');
 const batch={type:'Verorab',quantity:50,reserved_count:1,quantity_mode:'on_hand'};
 assert.equal(physicalQuantity(batch),50);assert.equal(availableQuantity(batch),49);
 assert.equal(summarizeStock([batch]),'Verorab: 49');
 const legacy={type:'Verorab',quantity:49,reserved_count:1};
 assert.equal(physicalQuantity(legacy),50);assert.equal(availableQuantity(legacy),49);
});

test('server and browser exclude invalid quantities and reservation counters from availability',async()=>{
 const browser=await import('../scripts/stock-summary.mjs');
 for(const changes of [{quantity:-1},{quantity:0.5},{quantity:'invalid'},{reserved_count:-1},{reserved_count:0.5},{reserved_count:'invalid'}]) {
  const batch={quantity:50,reserved_count:1,quantity_mode:'on_hand',...changes};
  assert.equal(availableQuantity(batch),0);
  assert.equal(browser.availableQuantity(batch),0);
 }
});

test('release rejects an inconsistent reservation rather than inventing a dose',async()=>{
 for(const changes of [{reserved_count:0},{reserved_count:-1},{reserved_count:0.5},{quantity:-1},{quantity:1,reserved_count:2,quantity_mode:'on_hand'}]) {
  let wrote=false;
  const item={type:'Vaccine',quantity:49,reserved_count:1,expiry:'2099-01-01',...changes};
  const tx={get:async()=>({docs:[{id:'batch',data:()=>item}]}),update:()=>{wrote=true;},set:()=>{wrote=true;}};
  const db={collection:()=>({where:()=>({})})};
  await assert.rejects(releaseReservation(tx,db,{clinic_id:'clinic',stock_reservation:{status:'reserved',inventory_id:'batch'}},()=> 'timestamp'),/inconsistent/);
  assert.equal(wrote,false);
 }
});
