const {createHash}=require('node:crypto');
const {scheduledTime}=require('./appointment-lifecycle');
const CAPACITY=5;
const occupiesSlot=item=>['pending','confirmed','accepted','approved','in_progress','completed'].includes(item.status);
async function checkSlotCapacity(tx,db,clinicId,date,time,excludeId,HttpsError){
 const scheduled=scheduledTime(date,time);
 const lock=db.collection('_slot_locks').doc(createHash('sha256').update(clinicId+':'+scheduled).digest('hex'));
 await tx.get(lock);
 const rows=await tx.get(db.collection('appointments').where('clinic_id','==',clinicId));
 const count=rows.docs.filter(doc=>doc.id!==excludeId && occupiesSlot(doc.data()) && scheduledTime(doc.data().preferred_date,doc.data().preferred_time)===scheduled).length;
 if(count>=CAPACITY)throw new HttpsError('resource-exhausted','This time slot is fully booked (5 appointments). Please choose the next available time.');
 return lock;
}
function slotAvailabilityHandler({db,HttpsError}){return async request=>{
 if(!request.auth || request.auth.token?.secure_login!==true)throw new HttpsError('unauthenticated','Please sign in again.');
 const {clinic_id,date}=request.data||{};
 if(typeof clinic_id!=='string'||!clinic_id||clinic_id.includes('/')||!Number.isFinite(scheduledTime(date,'00:00')))throw new HttpsError('invalid-argument','Choose a clinic and date.');
 const rows=await db.collection('appointments').where('clinic_id','==',clinic_id).get();
 const counts={};
 for(const doc of rows.docs){const item=doc.data();if(item.preferred_date!==date||!occupiesSlot(item))continue;const key=scheduledTime(date,item.preferred_time);if(Number.isFinite(key))counts[key]=(counts[key]||0)+1;}
 return {capacity:CAPACITY,counts};
};}
module.exports={checkSlotCapacity,slotAvailabilityHandler,occupiesSlot};
