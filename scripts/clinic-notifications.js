import { auth, db, onAuthStateChanged, fetchUserProfile } from './firebase.js';
import { protectPage } from './role-guard.js';
import { collection, query, where, onSnapshot, doc, updateDoc } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { notifyDialog } from './app-dialogs.js';
import { expiryReminders } from './expiry-reminders.mjs';
import { shortVaccineName } from './stock-summary.mjs';
protectPage('clinic_staff');
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const list = document.getElementById('expiryReminders');
const status = document.getElementById('expiryStatus');
let rows = [], clinicId, unsubscribe, generation = 0, filter = 'all', currentDay = today(), loaded = false;
let staffUid = '', appointmentNotifications = [], notificationUnsubscribes = [];
const notificationSources = new Map();
const notificationStates = new Map();

function selectClinicAppointmentNotifications(items, clinicId, staffUid) {
  return [...new Map(items.filter(item => item.type === 'appointment' && (
    (item.audience === 'clinic_staff' && item.clinic_id === clinicId)
    || item.recipient_uid === staffUid || item.user_id === staffUid
  )).map(item => [item.id, item])).values()]
    .sort((first, second) => (second.created_at?.toMillis?.() || 0) - (first.created_at?.toMillis?.() || 0));
}

function updateNotificationBadges() {
  const reminders = loaded ? expiryReminders(rows, clinicId, today()).length : 0;
  const unread = appointmentNotifications.filter(item => !item.read).length;
  document.querySelectorAll('[data-expiry-count]').forEach(badge => {
    badge.textContent = reminders + unread ? ' (' + (reminders + unread) + ')' : '';
    badge.title = `${unread} unread appointment updates; ${reminders} vaccine expiry reminders`;
  });
  const count = document.getElementById('clinicAppointmentUnreadCount');
  if (count) count.textContent = unread ? `${unread} unread` : 'All read';
}

async function markClinicNotificationRead(id, button) {
  if (button.disabled || auth.currentUser?.uid !== staffUid) return;
  button.disabled = true;
  try { await updateDoc(doc(db, 'notifications', id), { read: true }); }
  catch (error) {
    console.error('Could not mark clinic notification as read:', error);
    notifyDialog('Could not mark this update as read. Please try again.');
    button.disabled = false;
  }
}

function renderClinicAppointmentNotifications() {
  appointmentNotifications = selectClinicAppointmentNotifications([...notificationSources.values()].flat(), clinicId, staffUid);
  updateNotificationBadges();
  const container = document.getElementById('clinicAppointmentNotifications');
  const message = document.getElementById('clinicAppointmentNotificationStatus');
  if (!container || !message) return;
  const loading = [...notificationStates.values()].includes('loading');
  const failed = [...notificationStates.values()].includes('error');
  message.textContent = loading ? 'Loading appointment updates...' : failed ? 'Some updates could not be loaded. Check your connection and reload.'
    : appointmentNotifications.length ? `${appointmentNotifications.length} appointment update${appointmentNotifications.length === 1 ? '' : 's'}` : 'No appointment updates yet.';
  container.replaceChildren();
  for (const notification of appointmentNotifications) {
    const card = document.createElement('article');
    card.className = 'clinic-appointment-notification' + (notification.read ? '' : ' unread');
    const heading = document.createElement('h3');
    heading.textContent = notification.title || 'Appointment update';
    const detail = document.createElement('p');
    detail.textContent = notification.message || '';
    const date = notification.created_at?.toDate?.();
    const time = document.createElement('time');
    time.textContent = date ? date.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : 'Just now';
    if (date) time.dateTime = date.toISOString();
    const actions = document.createElement('div');
    actions.className = 'clinic-notification-actions';
    if (notification.action === 'rescheduled' || /reschedul/i.test(notification.title || '')) {
      const link = document.createElement('a');
      link.href = 'staff.html#resident-appointments';
      link.textContent = 'Review appointment requests';
      actions.append(link);
    }
    if (!notification.read) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Mark as read';
      button.addEventListener('click', () => markClinicNotificationRead(notification.id, button));
      actions.append(button);
    }
    card.append(heading, time, detail, actions);
    container.append(card);
  }
}

function listenToClinicAppointmentNotifications(user, run) {
  const listen = (key, notificationsQuery) => {
    const unsubscribe = onSnapshot(notificationsQuery, snapshot => {
      if (run !== generation || auth.currentUser?.uid !== user.uid) return;
      notificationSources.set(key, snapshot.docs.map(item => ({ ...item.data(), id: item.id })));
      notificationStates.set(key, 'ready');
      renderClinicAppointmentNotifications();
    }, error => {
      if (run !== generation || auth.currentUser?.uid !== user.uid) return;
      console.error('Could not load clinic appointment updates:', error);
      notificationStates.set(key, 'error');
      notificationSources.set(key, []);
      renderClinicAppointmentNotifications();
    });
    notificationUnsubscribes.push(unsubscribe);
  };
  notificationStates.set('clinic', 'loading');
  notificationStates.set('staff', 'loading');
  renderClinicAppointmentNotifications();
  listen('clinic', query(collection(db, 'notifications'), where('clinic_id', '==', clinicId)));
  // Include older updates that were addressed only to one staff account.
  listen('staff', query(collection(db, 'notifications'), where('recipient_uid', '==', user.uid)));
}

function render() {
  if (!loaded) return;
  const reminders = expiryReminders(rows, clinicId, today());
  updateNotificationBadges();
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
  notificationUnsubscribes.forEach(unsubscribe => unsubscribe());
  notificationUnsubscribes = [];
  notificationSources.clear(); notificationStates.clear(); appointmentNotifications = []; staffUid = '';
  document.getElementById('clinicAppointmentNotifications')?.replaceChildren();
  updateNotificationBadges();
  if (!user) { if (list) location.href = 'login.html'; return; }
  const profile = await fetchUserProfile(user.uid);
  if (run !== generation || auth.currentUser?.uid !== user.uid) return;
  if (profile?.role !== 'clinic_staff' || profile.is_active !== true || (profile.approval_status || 'approved') !== 'approved') {
    if (status) status.textContent = 'An approved clinic staff account is required.';
    return;
  }
  clinicId = profile.clinic_id || user.uid;
  staffUid = user.uid;
  listenToClinicAppointmentNotifications(user, run);
  unsubscribe = onSnapshot(query(collection(db,'inventory'),where('clinic_id','==',clinicId)), snapshot => {
    if (run !== generation || auth.currentUser?.uid !== user.uid) return;
    rows = snapshot.docs.map(item => ({...item.data(),id:item.id})); loaded = true; render();
  }, () => {
    if (run !== generation || auth.currentUser?.uid !== user.uid) return;
    loaded = false; list?.replaceChildren(); updateNotificationBadges();
    if (status) status.textContent = 'Could not load reminders. Check your connection and reload.';
  });
});
setInterval(() => { const day = today(); if (day !== currentDay) { currentDay = day; render(); } }, 1000);
