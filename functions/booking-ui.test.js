const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
test('resident books with only date and time, no ID or medical controls', async () => {
 const source=fs.readFileSync(path.join(__dirname,'../scripts/residents.js'),'utf8');
 const elements={
  confirmBookingBtn:{disabled:false},bookingMsg:{style:{}},
  modalDate:{value:'2026-09-25'},modalTime:{value:'9:00 AM'}
 };
 const calls=[];
 const context={
  window: {},
  document:{getElementById:id=>{assert.ok(elements[id],'Unexpected required input: '+id);return elements[id]}},
  currentUid:'resident',selectedClinic:{id:'clinic',status:'available'},selectedDose:'Dose 1 (Day 0)',
  latestVaccineBrand:'',currentVaccinationSessionId:'course',
  getPrimaryClinicId:()=>'',earliestBookingDate:()=>'2026-09-24',doseLevelFromLabel:()=>1,
  timeSlotError:()=>'',withBookingTimeout:p=>p,
  createBooking:async data=>{calls.push(data);return{data:{id:'a'}}},
  setTimeout:()=>{},closeBookingModal:()=>{}
 };
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('async function confirmBooking()'),source.indexOf('function filterMap(')),context);
 await context.confirmBooking();
 await context.confirmBooking();
 assert.equal(calls.length,1);
 assert.equal(calls[0].preferred_date,'2026-09-25');
 assert.equal(calls[0].preferred_time,'9:00 AM');
 assert.equal(calls[0].clinic_id,'clinic');
 assert.equal(calls[0].valid_id_url,undefined);
 assert.match(elements.bookingMsg.textContent,/sent to the clinic/);
});
test('deadline selection permits rebooking a lapsed no-show, but never an arrived appointment', async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../scripts/booking-status.js'),'utf8');
 const {clinicBooking}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const row={clinic_id:'clinic',status:'confirmed',preferred_date:'2026-09-24',preferred_time:'9:00 AM'};
 assert.ok(clinicBooking([row],'clinic','2026-09-24',Date.parse('2026-09-24T02:29:59Z')));
 assert.equal(clinicBooking([row],'clinic','2026-09-24',Date.parse('2026-09-24T02:30:00Z')),null);
 assert.ok(clinicBooking([{...row,status:'in_progress'}],'clinic','2026-09-25',Date.parse('2026-09-25T02:30:00Z')));
});

test('time dropdown rebuilds when clinic/date/time changes and preserves valid selections', () => {
 const {availableSlots,clockMinutes,dateStart}=require('./clinic-hours');
 let counts = {};
 const source=fs.readFileSync(path.join(__dirname,'../scripts/residents.js'),'utf8');
 let clock=Date.parse('2026-09-24T00:00:00Z');
 let rebuilds=0;
 const select={value:'',dataset:{},options:[],replaceChildren(){this.options=[];this.value='';rebuilds++},appendChild(option){this.options.push(option);if(this.options.length===1)this.value=option.value}};
 Object.defineProperty(select,'selectedOptions',{get:()=>select.options.filter(option=>option.value===select.value)});
 const elements={time:select,date:{value:'2026-09-24'},hint:{}};
 const context={
  requestSlotCapacity:()=>({data:{counts}}), clockMinutes, dateStart,
  availableSlots:(clinic,date)=>availableSlots(clinic,date,clock),
  document:{getElementById:id=>elements[id],createElement:()=>({})}
 };
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('function updateTimeSelect('),source.indexOf('function refreshTimeSlots(')),context);
 context.updateTimeSelect('time','date',{hours:'24 hours'},'hint');
 assert.equal(select.options[0].value,'8:30 AM');
 select.value='9:00 AM';
 context.updateTimeSelect('time','date',{hours:'24 hours'},'hint');
 assert.equal(rebuilds,1);assert.equal(select.value,'9:00 AM');
 clock=Date.parse('2026-09-24T01:00:00Z');
 context.updateTimeSelect('time','date',{hours:'24 hours'},'hint');
 assert.equal(select.value,'9:30 AM');
 context.updateTimeSelect('time','date',{hours:'Closed'},'hint');
 assert.equal(select.disabled,true);assert.equal(select.value,'');
 elements.date.value='2026-09-25';
 context.updateTimeSelect('time','date',{hours:'5 AM - 5 PM'},'hint');
 assert.equal(select.disabled,false);assert.equal(select.options.length,24);
 assert.equal(select.value,'5:00 AM');
 counts = {[dateStart('2026-09-25')+clockMinutes('5:00 AM')*60000]:5};
 context.updateTimeSelect('time','date',{hours:'5 AM - 5 PM'},'hint');
 assert.equal(select.options[0].disabled,true);
 assert.equal(select.value,'5:30 AM');
});
