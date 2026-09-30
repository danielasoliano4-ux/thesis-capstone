// Keep the browser and Cloud Functions copies identical; clinic-hours.test.js checks parity.
const SLOT_MINUTES = 30;
function clockMinutes(value) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(value).trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (match[3]) hour = hour % 12 + (match[3].toLowerCase() === 'pm' ? 12 : 0);
  return hour * 60 + minute;
}
function formatSlot(minute) {
  const hour = Math.floor(minute / 60);
  return (hour % 12 || 12) + ':' + String(minute % 60).padStart(2, '0') + (hour >= 12 ? ' PM' : ' AM');
}
function dateStart(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return NaN;
  const day = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date) return NaN;
  return Date.parse(date + 'T00:00:00+08:00');
}
function parseHours(value) {
  const text = String(value || '').trim().toLowerCase().replace(/\./g, '')
    .replace(/[??]/g, '-').replace(/\([^)]*\)/g, '').trim();
  if (/^(?:open\s*)?(?:24\s*\/\s*7|24\s*(?:hours?|hrs?))(?:\s*(?:daily|every day))?$/.test(text))
    return { known: true, ranges: [[0, 1440]] };
  if (/^(?:closed|not open)$/.test(text)) return { known: true, ranges: [] };
  const ranges = [];
  for (const part of text.replace(/^open\s+/, '').split(/\s*[,;]\s*/)) {
    const pair = part.split(/\s*(?:-|\bto\b)\s*/);
    if (pair.length !== 2) return { known: false, ranges: [] };
    const start = clockMinutes(pair[0]);
    const end = pair[1] === '24:00' ? 1440 : clockMinutes(pair[1]);
    if (start === null || end === null || start === end) return { known: false, ranges: [] };
    ranges.push([start, end < start ? end + 1440 : end]);
  }
  return { known: true, ranges };
}
function hoursForDate(clinic, date) {
  clinic = clinic?.operatingHours || clinic;
  const day = new Date(date + 'T12:00:00+08:00').getUTCDay();
  // An explicitly configured weekend schedule takes priority, including Closed.
  const key = day === 0 || day === 6 ? 'weekendHours' : 'weekdayHours';
  const specific = String(clinic?.[key] || '').trim();
  if (specific) return specific;
  // Legacy clinics may have only the general hours field.
  return String(clinic?.hours || '').trim();
}
function scheduleForDate(clinic, date) {
  const start = dateStart(date);
  if (!Number.isFinite(start)) return { known: false, ranges: [], hours: '' };
  const hours = hoursForDate(clinic, date);
  const current = parseHours(hours);
  const previousDate = new Date(Date.parse(date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const previous = parseHours(hoursForDate(clinic, previousDate));
  const ranges = current.ranges.map(([a,b]) => [a, Math.min(b,1440)]);
  // A shift starting the previous day can continue after midnight.
  for (const [,end] of previous.ranges) if (end > 1440) ranges.push([0,end-1440]);
  return { known: current.known || ranges.length > 0, ranges, hours };
}
function operatingSlots(clinic, date) {
  const schedule = scheduleForDate(clinic, date);
  const minutes = new Set();
  for (const [start,end] of schedule.ranges) {
    // The final start time is strictly before closing. No extra closing buffer.
    for (let minute = start; minute < end; minute += SLOT_MINUTES) minutes.add(minute);
  }
  return { ...schedule, minutes: [...minutes].sort((a,b)=>a-b) };
}
function availableSlots(clinic, date, now = Date.now()) {
  const schedule = operatingSlots(clinic, date);
  const start = dateStart(date);
  return { ...schedule, slots: schedule.minutes.filter(minute => start + minute * 60000 > +now).map(formatSlot) };
}
function bookingTimeError(clinic, date, time, now = Date.now()) {
  const start = dateStart(date), minute = clockMinutes(time);
  if (!Number.isFinite(start) || minute === null) return 'Choose a valid appointment date and time.';
  if (start + minute * 60000 <= +now) return 'Choose a future appointment time.';
  const schedule = operatingSlots(clinic, date);
  if (!schedule.known) return 'Operating hours are unavailable for this date. Please contact the clinic.';
  if (!schedule.minutes.length) return 'The clinic is closed on this date. Choose another date.';
  if (!schedule.minutes.includes(minute)) return 'Choose an available 30-minute slot within the clinic operating hours.';
  return '';
}

module.exports = { SLOT_MINUTES, clockMinutes, formatSlot, dateStart, parseHours, hoursForDate, scheduleForDate, operatingSlots, availableSlots, bookingTimeError };
