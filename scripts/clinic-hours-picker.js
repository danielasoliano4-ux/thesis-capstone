import { parseHours, formatSlot } from './clinic-hours.js';

const clockValue = minute => String(Math.floor((minute % 1440) / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
const minutes = value => { const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute; };

export function setHoursPicker(id, value) {
  const hidden = document.getElementById(id);
  const host = hidden.closest('.hours-box');
  const mode = host.querySelector('.hours-mode');
  const opening = host.querySelector('.hours-opening');
  const closing = host.querySelector('.hours-closing');
  const saved = mode.querySelector('[value="saved"]');
  const parsed = parseHours(value);
  hidden.value = value;
  hidden.dataset.savedHours = value;
  opening.setCustomValidity('');
  closing.setCustomValidity('');
  opening.value = '';
  closing.value = '';
  saved.hidden = true;
  if (parsed.known && !parsed.ranges.length) mode.value = 'closed';
  else if (parsed.known && parsed.ranges.length === 1) {
    const [start, end] = parsed.ranges[0];
    if (start === 0 && end === 1440) mode.value = '24';
    else {
      mode.value = 'custom';
      opening.value = clockValue(start);
      closing.value = clockValue(end);
    }
  } else if (value) {
    // Preserve legacy split or unrecognized schedules until staff explicitly change them.
    mode.value = 'saved';
    saved.hidden = false;
  } else mode.value = 'custom';
  updatePicker(host, false);
}

function updatePicker(host, changed) {
  const hidden = host.querySelector('input[type="hidden"]');
  const mode = host.querySelector('.hours-mode').value;
  const opening = host.querySelector('.hours-opening');
  const closing = host.querySelector('.hours-closing');
  const custom = mode === 'custom';
  host.querySelector('.hours-times').hidden = !custom;
  for (const input of [opening, closing]) {
    input.disabled = !custom;
    input.required = custom;
    input.setCustomValidity('');
  }
  let note = '';
  if (custom) {
    if (opening.value && closing.value) {
      if (opening.value === closing.value) {
        closing.setCustomValidity('Choose different opening and closing times, or select Open 24 hours.');
        note = 'For an all-day schedule, select Open 24 hours.';
      } else {
        if (changed) hidden.value = formatSlot(minutes(opening.value)) + ' - ' + formatSlot(minutes(closing.value));
        note = minutes(closing.value) < minutes(opening.value) ? 'Closes the following day.' : 'Residents can book within these hours.';
      }
    } else note = 'Click the clock to choose opening and closing times.';
  } else if (mode === '24') {
    if (changed) hidden.value = '24 hours';
    note = 'Residents can book around the clock.';
  } else if (mode === 'closed') {
    if (changed) hidden.value = 'Closed';
    note = 'No new opening hours for these days.';
  } else {
    if (changed) hidden.value = hidden.dataset.savedHours || '';
    note = 'Saved schedule: ' + hidden.value;
  }
  host.querySelector('.hours-note').textContent = note;
}

export function initializeHoursPickers() {
  document.querySelectorAll('.hours-box[data-hours-picker]').forEach(host => {
    host.querySelector('.hours-mode').addEventListener('change', () => updatePicker(host, true));
    host.querySelectorAll('input[type="time"]').forEach(input => {
      input.addEventListener('input', () => updatePicker(host, true));
      input.addEventListener('change', () => updatePicker(host, true));
    });
    host.querySelectorAll('.hours-clock-button').forEach(button => {
      button.addEventListener('click', () => {
        const input = document.getElementById(button.dataset.timeInput);
        input.focus();
        try { input.showPicker?.(); } catch { /* Native time input remains available. */ }
      });
    });
    const hidden = host.querySelector('input[type="hidden"]');
    setHoursPicker(hidden.id, hidden.value);
  });
}
