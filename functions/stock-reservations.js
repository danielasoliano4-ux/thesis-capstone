'use strict';
const day = current => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(current);
function availableQuantity(item) {
 const quantity=Number(item.quantity ?? 0),reserved=Number(item.reserved_count ?? 0);
 if(!Number.isInteger(quantity)||quantity<0||!Number.isInteger(reserved)||reserved<0) return 0;
 return Math.max(0,quantity-(item.quantity_mode==='on_hand'?reserved:0));
}
function usable(item, date) {
 return !item.archived && /^\d{4}-\d{2}-\d{2}$/.test(item.expiry || '') && Number.isFinite(Date.parse(item.expiry)) && new Date(item.expiry).toISOString().slice(0,10) === item.expiry && item.expiry > date && Number.isInteger(Number(item.quantity)) && availableQuantity(item) > 0 && Boolean(item.type);
}
async function readStock(tx, db, clinicId, current = new Date()) {
 const snapshot = await tx.get(db.collection('inventory').where('clinic_id','==',clinicId));
 const items = snapshot.docs.map(doc => ({...doc.data(), id:doc.id}));
 const active = items.filter(item => usable(item,day(current)));
 return {items, active, total:active.reduce((sum,item)=>sum+availableQuantity(item),0)};
}
async function requireBookingStock(tx, db, clinicId, HttpsError, current) {
 const stock = await readStock(tx,db,clinicId,current);
 // Low stock (1–15 available doses) is a warning, not a booking restriction.
 // Staff confirmation reserves the dose; pending requests do not consume stock.
 if(stock.total <= 0) throw new HttpsError('failed-precondition', 'This clinic is out of vaccine stock. Choose another clinic.');
 return stock;
}
function publishStock(tx, db, clinicId, items, timestamp, current = new Date()) {
 const active=items.filter(item=>usable(item,day(current)));
 const total=active.reduce((sum,item)=>sum+availableQuantity(item),0);
 tx.set(db.collection('clinics').doc(clinicId), {stock_total:total, stock_status:total<=0?'out':total<=15?'low':'available', stock_summary:active.map(item=>`${item.type}: ${availableQuantity(item)}`).join(' | ')||'0 doses',updated_at:timestamp()}, {merge:true});
}
async function releaseReservation(tx, db, appointment, timestamp, current = new Date()) {
 if(appointment.stock_reservation?.status !== 'reserved') return null;
 const stock=await readStock(tx,db,appointment.clinic_id,current);
 const item=stock.items.find(item=>item.id===appointment.stock_reservation.inventory_id);
 // A deleted batch must not silently discard a resident's reserved dose.
 if(!item) throw new Error('Reserved inventory batch is missing. Restore the batch before releasing this appointment.');
 if(!Number.isInteger(Number(item.quantity)) || Number(item.quantity)<0 || !Number.isInteger(Number(item.reserved_count)) || Number(item.reserved_count)<1 ||
   (item.quantity_mode==='on_hand' && Number(item.quantity)<Number(item.reserved_count))) throw new Error('Reserved inventory count is inconsistent. Correct the batch before releasing this appointment.');
 return () => {
  item.quantity=Number(item.quantity)+(item.quantity_mode === 'on_hand' ? 0 : 1);
  item.reserved_count=Math.max(0,Number(item.reserved_count||0)-1);
  tx.update(db.collection('inventory').doc(item.id),{quantity:item.quantity,reserved_count:item.reserved_count,updated_at:timestamp()});
  publishStock(tx,db,appointment.clinic_id,stock.items,timestamp,current);
 };
}
module.exports={availableQuantity,usable,readStock,requireBookingStock,publishStock,releaseReservation};
