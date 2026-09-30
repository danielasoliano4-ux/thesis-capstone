const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { availableSlots, bookingTimeError, parseHours } = require('./clinic-hours');
const now = Date.parse('2026-09-23T00:00:00Z');
test('24-hour clinics offer all 48 half-hour slots on a future day', () => {
 for (const hours of ['24 hours','24/7','Open 24 hours','24 hrs']) {
  const {slots}=availableSlots({hours},'2026-09-24',now);
  assert.equal(slots.length,48);assert.equal(slots[0],'12:00 AM');assert.equal(slots.at(-1),'11:30 PM');
 }
});
test('5 AM to 5 PM includes opening, excludes closing and outside hours', () => {
 const clinic={hours:'5:00 AM - 5:00 PM'};
 const {slots}=availableSlots(clinic,'2026-09-24',now);
 assert.equal(slots.length,24);assert.equal(slots[0],'5:00 AM');assert.equal(slots.at(-1),'4:30 PM');
 assert.equal(bookingTimeError(clinic,'2026-09-24','5:00 AM',now),'');
 for(const time of ['4:30 AM','5:00 PM','11:30 PM','5:10 AM']) assert.ok(bookingTimeError(clinic,'2026-09-24',time,now));
});
test('same-day slots must be strictly in the future, with no one-hour lead restriction', () => {
 const clinic={hours:'24 hours'};
 assert.equal(availableSlots(clinic,'2026-09-24',Date.parse('2026-09-24T01:00:00Z')).slots[0],'9:30 AM');
 assert.equal(availableSlots(clinic,'2026-09-24',Date.parse('2026-09-24T01:29:59Z')).slots[0],'9:30 AM');
 assert.equal(availableSlots(clinic,'2026-09-24',Date.parse('2026-09-24T01:30:00Z')).slots[0],'10:00 AM');
 assert.ok(bookingTimeError(clinic,'2026-09-24','9:00 AM',Date.parse('2026-09-24T01:00:00Z')));
 assert.equal(availableSlots(clinic,'2026-09-24',Date.parse('2026-09-24T15:30:00Z')).slots.length,0);
 assert.equal(availableSlots(clinic,'2026-09-25',Date.parse('2026-09-24T15:30:00Z')).slots.length,48);
});
test('weekday and weekend schedules use the appointment date in Manila', () => {
 const clinic={weekdayHours:'5 AM - 5 PM',weekendHours:'10 AM - 2 PM'};
 assert.equal(availableSlots(clinic,'2026-09-25',now).slots[0],'5:00 AM'); // Friday
 assert.equal(availableSlots(clinic,'2026-09-26',now).slots[0],'10:00 AM');
 assert.equal(availableSlots(clinic,'2026-09-27',now).slots.at(-1),'1:30 PM');
 assert.equal(availableSlots({...clinic,weekendHours:'Closed'},'2026-09-26',now).slots.length,0);
});
test('overnight shifts carry over from the preceding day only', () => {
 const clinic={weekdayHours:'10 PM - 6 AM',weekendHours:'Closed'};
 const saturday=availableSlots(clinic,'2026-09-26',now).slots;
 assert.equal(saturday.length,12);assert.equal(saturday[0],'12:00 AM');assert.equal(saturday.at(-1),'5:30 AM');
 assert.equal(availableSlots(clinic,'2026-09-27',now).slots.length,0);
 const monday=availableSlots(clinic,'2026-09-28',now).slots;
 assert.deepEqual(monday,['10:00 PM','10:30 PM','11:00 PM','11:30 PM']);
});
test('split hours exclude breaks and support 24-hour notation and typographic dashes', () => {
 const clinic={hours:'05:00 ? 12:00; 13:00 to 17:00'};
 const {slots}=availableSlots(clinic,'2026-09-24',now);
 assert.ok(slots.includes('5:00 AM'));assert.ok(slots.includes('1:00 PM'));assert.ok(!slots.includes('12:00 PM'));
 assert.ok(!slots.includes('12:30 PM'));
 assert.deepEqual(parseHours('13:00 PM - 17:00 PM'),{known:false,ranges:[]});
});
test('missing, malformed and closed hours never invent a booking schedule', () => {
 for(const hours of ['', 'Contact clinic','unknown','Closed','5 AM - unknown','9:70 AM - 5 PM']) {
  assert.equal(availableSlots({hours},'2026-09-24',now).slots.length,0);
  assert.ok(bookingTimeError({hours},'2026-09-24','9:00 AM',now));
 }
 assert.equal(availableSlots({hours:'24 hours'},'2026-02-30',now).slots.length,0);
});
test('map display hours cannot accidentally supply weekday hours on weekends', () => {
 const clinic={hours:'5 AM - 5 PM',operatingHours:{weekdayHours:'5 AM - 5 PM',weekendHours:'',hours:''}};
 assert.equal(availableSlots(clinic,'2026-09-26',now).slots.length,0);
});
test('browser and server use identical scheduling logic', () => {
 const browser=fs.readFileSync(path.join(__dirname,'../scripts/clinic-hours.js'),'utf8').split('\nexport ')[0];
 const server=fs.readFileSync(path.join(__dirname,'clinic-hours.js'),'utf8').split('\nmodule.exports = ')[0];
 assert.equal(browser,server);
});
