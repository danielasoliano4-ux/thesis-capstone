const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
test('new appointment defaults to course history instead of the hidden clinic selection', () => {
 const source = fs.readFileSync(path.join(__dirname, '../scripts/residents.js'), 'utf8');
 const elements = {
  modalClinic: { value: 'other' }, bookingClinicName: {}, modalDate: {},
  bookingMsg: { style: {} }, confirmBookingBtn: {},
  bookingModal: { classList: { add() {} } }
 };
 const messages = [];
 const context = {
  residentVaccinationRecords: [{ dose_number: 2, clinic_id: 'abc2', date_given: '2026-09-20' }],
  residentAppointments: [], currentVaccinationSessionId: 'course',
  window: { clinicDirectory: [{ id: 'other', name: 'Other' }, { id: 'abc2', name: 'ABC 2' }] },
  document: { getElementById: id => elements[id] },
  notifyDialog: message => messages.push(message), doseDayOffsets: [0, 3, 7, 14, 28],
  earliestBookingDate: () => '2026-10-05', refreshTimeSlots() {}
 };
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('function getPrimaryClinicId('), source.indexOf('function courseBookingContext(')), context);
 vm.runInContext(source.slice(source.indexOf('function openBookingModal('), source.indexOf('function closeBookingModal(')), context);
 context.openBookingModal('');
 assert.equal(context.selectedClinic.id, 'abc2');
 assert.equal(elements.bookingClinicName.textContent, 'ABC 2');
 context.openBookingModal('Other', 'other');
 assert.equal(context.selectedClinic.id, 'other');
 context.window.clinicDirectory = [{ id: 'other', name: 'Other' }];
 context.openBookingModal('');
 assert.match(messages.pop(), /previous clinic.*unavailable/);
 context.residentVaccinationRecords = [];
 context.residentAppointments = [
  { clinic_id: 'other', status: 'completed', vaccination_session_id: 'old' },
  { clinic_id: 'other', status: 'cancelled', vaccination_session_id: 'course' },
  { clinic_id: 'abc2', status: 'completed', vaccination_session_id: 'course' }
 ];
 assert.equal(context.getPrimaryClinicId(), 'abc2');
 context.currentVaccinationSessionId = 'legacy';
 context.residentAppointments = [{ clinic_id: 'abc2', status: 'completed' }];
 assert.equal(context.getPrimaryClinicId(), 'abc2');
 context.residentAppointments = [];
 elements.modalClinic.value = 'other';
 context.openBookingModal('');
 assert.equal(context.selectedClinic.id, 'other');
});
test('different clinic confirmation uses dose or booking history and honors cancellation', async () => {
 const source=fs.readFileSync(path.join(__dirname,'../scripts/residents.js'),'utf8');
 const prompts=[];
 const context={residentVaccinationRecords:[],allResidentVaccinationRecords:[],residentAppointments:[],
  window:{clinicDirectory:[{id:'first',name:'First Clinic'}]},
  confirmDialog:async(message,options)=>{prompts.push({message,options});return false;}};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('async function confirmClinicWithHistory('),source.indexOf('function getPrimaryClinicId(')),context);
 assert.equal(await context.confirmClinicWithHistory({id:'second',name:'Second Clinic'}),true);
 context.residentVaccinationRecords=[{clinic_id:'first',date_given:'2026-09-20'}];
 assert.equal(await context.confirmClinicWithHistory({id:'first'}),true);
 assert.equal(prompts.length,0);
 assert.equal(await context.confirmClinicWithHistory({id:'second',name:'Second Clinic'}),false);
 assert.match(prompts[0].message,/First Clinic.*Second Clinic/);
 context.residentVaccinationRecords=[];
 context.residentAppointments=[{clinic_id:'first',status:'completed'}];
 assert.equal(await context.confirmClinicWithHistory({id:'second'}),false);
 context.confirmDialog=async()=>true;
 assert.equal(await context.confirmClinicWithHistory({id:'second'}),true);
 context.residentAppointments=[{clinic_id:'first',status:'cancelled'}];
 assert.equal(await context.confirmClinicWithHistory({id:'second'}),true);
 context.allResidentVaccinationRecords=[{clinic_id:'first',date_given:'2026-01-01'}];
 context.confirmDialog=async()=>false;
 assert.equal(await context.confirmClinicWithHistory({id:'second'}),false);
});
test('resident books with only date and time, no ID or medical controls', async () => {
 const source=fs.readFileSync(path.join(__dirname,'../scripts/residents.js'),'utf8');
 const elements={
  confirmBookingBtn:{disabled:false},bookingMsg:{style:{}},
  modalDate:{value:'2026-09-25'},modalTime:{value:'9:00 AM'}
 };
 const calls=[];
 const context={
  window: {clinicDirectory:[{id:'clinic',status:'available'}]},
  document:{getElementById:id=>{assert.ok(elements[id],'Unexpected required input: '+id);return elements[id]}},
  currentUid:'resident',selectedClinic:{id:'clinic',status:'available'},selectedDose:'Dose 1 (Day 0)',
  latestVaccineBrand:'',currentVaccinationSessionId:'course',
  getPrimaryClinicId:()=>'',confirmClinicWithHistory:async()=>true,earliestBookingDate:()=>'2026-09-24',doseLevelFromLabel:()=>1,
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
