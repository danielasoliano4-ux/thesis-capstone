import { auth, db, onAuthStateChanged, fetchUserProfile } from './firebase.js';
import { collection, query, where, onSnapshot } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { expiryReminders } from './expiry-reminders.mjs';
import { shortVaccineName } from './stock-summary.mjs';
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const list = document.getElementById('expiryReminders');
const status = document.getElementById('expiryStatus');
let rows = [], clinicId, unsubscribe, generation = 0, filter = 'all', currentDay = today(), loaded = false;
function render() {
  if (!loaded) return;
  const reminders = expiryReminders(rows, clinicId, today());
  document.querySelectorAll('[data-expiry-count]').forEach(badge => { badge.textContent = reminders.length ? ' (' + reminders.length + ')' : ''; });
  if (!list) return;
  const visible = reminders.filter(item => filter === 'all' || (filter === 'expired' ? item.expired : !item.expired));
  status.textContent = visible.length ? visible.length + ' vaccine batch reminder' + (visible.length === 1 ? '' : 's') : 'No vaccine batches need attention in this category.';
  list.replaceChildren();
  for (const item of visible) {
    const card = document.createElement('article'); card.className = 'expiry-reminder' + (item.expired ? ' expired' : '');
    const badge = document.createElement('span'); badge.className = 'expiry-badge';
    badge.textContent = item.expired ? (item.daysRemaining === 0 ? 'Expired today' : 'Expired') : 'Expires in ' + item.daysRemaining + ' day' + (item.daysRemaining === 1 ? '' : 's');
    const heading = document.createElement('h3'); heading.textContent = shortVaccineName(item.type) + ' - Batch ' + (item.batch || 'Unspecified');
    const details = document.createElement('p'); details.textContent = 'Expiration date: ' + item.expiry + ' | Remaining stock: ' + item.quantity + ' doses';
    const note = document.createElement('p'); note.textContent = item.expired ? 'This batch has expired and is unavailable for dose completion.' : 'Review this batch before its expiration date.';
    const link = document.createElement('a'); link.href = 'staff.html'; link.textContent = 'View vaccine inventory';
    card.append(badge, heading, details, note, link); list.append(card);
  }
}
document.querySelectorAll('[data-expiry-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.expiryFilter;
  document.querySelectorAll('[data-expiry-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  render();
}));
onAuthStateChanged(auth, async user => {
  const run = ++generation; unsubscribe?.(); loaded = false; rows = []; list?.replaceChildren();
  if (!user) { if (list) location.href = 'login.html'; return; }
  const profile = await fetchUserProfile(user.uid);
  if (run !== generation) return;
  if (profile?.role !== 'clinic_staff' || profile.is_active !== true || (profile.approval_status || 'approved') !== 'approved') {
    if (status) status.textContent = 'An approved clinic staff account is required.';
    return;
  }
  clinicId = profile.clinic_id || user.uid;
  unsubscribe = onSnapshot(query(collection(db,'inventory'),where('clinic_id','==',clinicId)), snapshot => {
    rows = snapshot.docs.map(item => ({...item.data(),id:item.id})); loaded = true; render();
  }, () => { loaded = false; list?.replaceChildren(); if (status) status.textContent = 'Could not load reminders. Check your connection and reload.'; });
});
setInterval(() => { const day = today(); if (day !== currentDay) { currentDay = day; render(); } }, 1000);
