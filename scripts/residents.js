import { renderLiveCaptions } from './live-analytics-view.js';
import { initializeMonthlyChart, updateMonthlyChart } from './monthly-analytics-chart.js';
import { notifyDialog, confirmDialog } from './app-dialogs.js';
import { sessionIsTerminated } from './session-state.js';
import { availableSlots, bookingTimeError, clockMinutes, dateStart } from './clinic-hours.js';
import { openDosePreview, openDoseReportPreview } from './dose-preview.js';
import { app, auth, db, storage, fetchUserProfile, onAuthStateChanged } from './firebase.js';
import { doc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs, addDoc, onSnapshot, serverTimestamp, orderBy } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-storage.js";

import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js';
import { getMessaging, getToken, isSupported, onMessage } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging.js';
import { clinicBooking, appointmentDeadline, pendingAppointmentExpired } from './booking-status.js';
const showTab = (...args) => window.showTab(...args);
const createBooking = httpsCallable(getFunctions(app), 'createBooking');
const createBatchBooking = httpsCallable(getFunctions(app), 'createBatchBooking');
const cancelBooking = httpsCallable(getFunctions(app), 'cancelBooking');
const rescheduleBooking = httpsCallable(getFunctions(app), 'rescheduleBooking');

let currentUid = null;
let currentResidentName = '';
let residentProfile = {};
let residentAppointments = [];
let activeRescheduleAppointment = null;
let selectedClinic = null;
let completedDoseCount = 0;
let firstDoseDate = null;
let latestVaccineBrand = '';
let originalDoseClinicId = '';
let residentVaccinationRecords = [];
let allResidentVaccinationRecords = [];
let livePublicCaseRecords = [];
let residentVaccinationDocuments = [];
let allResidentVaccinationDocuments = [];
let bookingClinicContext = null;
let currentVaccinationSessionId = '';
let selectedDose = 1;
let patientTreatments = [];
let pendingClinicChangeId = '';
let confirmedClinicChangeId = '';
let vaccinationDocumentsUnsubscribe = null;
let vaccinationUploadInProgress = false;
let foregroundPushMessaging = null;
let pushSetupInProgress = false;
const doseDayOffsets = [0, 3, 7, 14, 28];

function manilaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function isReservationExpired(appointment) {
  return pendingAppointmentExpired(appointment) || appointment.status === 'confirmed'
    && Number.isFinite(appointmentDeadline(appointment))
    && Date.now() >= appointmentDeadline(appointment);
}

function appointmentStatus(appointment) {
  return isReservationExpired(appointment) ? 'expired' : appointment.status;
}

// Booking and display must use the same definition of an active appointment.
// A confirmed record whose reservation/date has passed is not an active visit
// and must not prevent the resident from scheduling the next dose.
function isActiveAcceptedAppointment(appointment) {
  const status = String(appointment.status || '').toLowerCase();
  if (!['confirmed', 'in_progress'].includes(status)) return false;
  if (isReservationExpired(appointment)) return false;
  return status === 'in_progress' || !appointment.preferred_date || appointment.preferred_date >= manilaToday();
}

function markAllRead() {
  document.querySelectorAll('.notif-item.unread').forEach(item => {
    item.classList.remove('unread');
    const dot = item.querySelector('.unread-dot');
    if (dot) dot.remove();
  });

  const unread = document.getElementById('unreadCount');
  if (unread) unread.textContent = '0';

    document.querySelectorAll('.notif-item[data-id]').forEach(item => {
      updateDoc(doc(db, 'notifications', item.dataset.id), { read: true })
        .catch(error => console.warn('Could not mark notification as read:', error));
    });
}

function filterNotifs(type, btn) {
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const items = document.querySelectorAll('.notif-item');
  let visible = 0;

  items.forEach(item => {
    if (type === 'all' || item.dataset.type === type) {
      item.style.display = 'flex';
      visible++;
    } else {
      item.style.display = 'none';
    }
  });

  const emptyState = document.getElementById('emptyState');
  if (emptyState) emptyState.style.display = visible === 0 ? 'block' : 'none';

  document.querySelectorAll('.notif-group-label').forEach(g => {
    g.style.display = type === 'all' ? 'block' : 'none';
  });
}

// Renders the clinic's referral as a highlighted callout when the declining
// clinic recommended another facility. Returns '' for ordinary notifications.
function buildReferralCallout(notification) {
  const facility = String(notification.referral_facility || '').trim();
  const contact = String(notification.referral_contact || '').trim();
  const note = String(notification.referral_note || '').trim();
  if (!facility && !note) return '';
  const heading = facility
    ? `<i class="fa-solid fa-hospital"></i> Recommended facility: ${escapeHtml(facility)}`
    : '<i class="fa-solid fa-circle-info"></i> Additional advice';
  return `<div class="notif-referral" style="margin-top:10px;padding:12px 14px;background:#fff7ed;border:1px solid #fed7aa;border-left:4px solid #f97316;border-radius:8px;">
      <p style="margin:0;font-size:13px;font-weight:700;color:#9a3412;line-height:1.5;">${heading}</p>
      ${contact ? `<p style="margin:4px 0 0;font-size:12.5px;color:#7c2d12;line-height:1.5;"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(contact)}</p>` : ''}
      ${note ? `<p style="margin:6px 0 0;font-size:12.5px;color:#7c2d12;line-height:1.5;">${escapeHtml(note)}</p>` : ''}
    </div>`;
}

function loadResidentNotifications(uid) {
  const panel = document.querySelector('#panel-notifications .notif-container');
  if (!panel) return;
  panel.querySelectorAll('.notif-item, .notif-group-label').forEach(item => item.remove());
  let list = document.getElementById('residentNotificationsList');
  if (!list) {
    list = document.createElement('div');
    list.id = 'residentNotificationsList';
    panel.insertBefore(list, document.getElementById('emptyState'));
  }
  onSnapshot(query(collection(db, 'notifications'), where('recipient_uid', '==', uid)), snapshot => {
    const notifications = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
      .sort((first, second) => (second.created_at?.toMillis?.() || 0) - (first.created_at?.toMillis?.() || 0));
    list.innerHTML = notifications.map(notification => {
      const type = notification.type || 'system';
      const createdAt = notification.created_at?.toDate ? notification.created_at.toDate().toLocaleString() : 'Just now';
      const declined = String(notification.title || '').toLowerCase().includes('declined');
      const icon = notification.title?.toLowerCase().includes('reminder') ? 'fa-calendar-check' : type === 'vaccine' ? 'fa-syringe' : declined ? 'fa-circle-xmark' : 'fa-circle-check';
      const iconBg = declined ? '#fee2e2' : '#dbeafe';
      const iconColor = declined ? '#b91c1c' : '#2563eb';
      return `<div class="notif-item${notification.read ? '' : ' unread'}" data-id="${escapeHtml(notification.id)}" data-type="${escapeHtml(type)}" style="background:white;border:1px solid ${declined ? '#fecaca' : '#e5e7eb'};border-radius:10px;padding:16px 20px;margin-bottom:10px;display:flex;gap:14px;align-items:flex-start;position:relative;">
        <div class="notif-icon icon-blue" style="width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${iconBg};color:${iconColor};"><i class="fa-solid ${icon}"></i></div>
        <div class="notif-body" style="flex:1;min-width:0;"><h4 style="font-size:14px;font-weight:600;color:#111827;margin:0 0 4px;">${escapeHtml(notification.title || 'Notification')}</h4><p style="margin:0;font-size:13px;color:#4b5563;line-height:1.5;">${escapeHtml(notification.message || notification.body || '')}</p>${buildReferralCallout(notification)}${notification.action === 'rebook' ? `<button type="button" class="action-btn notification-rebook" data-notification-id="${escapeHtml(notification.id)}">Reschedule visit</button>` : ''}${notification.action === 'review_schedule' ? `<button type="button" class="action-btn notification-review-schedule" data-notification-id="${escapeHtml(notification.id)}">Review and book dates</button>` : ''}<div class="notif-meta" style="display:flex;align-items:center;gap:12px;margin-top:8px;flex-wrap:wrap;"><span class="notif-time" style="font-size:12px;color:#9ca3af;"><i class="fa-regular fa-clock"></i> ${escapeHtml(createdAt)}</span><span class="notif-tag tag-${escapeHtml(type)}">${escapeHtml(type)}</span></div></div>
        ${notification.read ? '' : '<div class="unread-dot" style="position:absolute;top:20px;right:16px;width:8px;height:8px;background:#ef0000;border-radius:50%;"></div>'}</div>`;
    }).join('');
    list.querySelectorAll('.notification-rebook').forEach(button => button.addEventListener('click', () => {
      const notification = notifications.find(item => item.id === button.dataset.notificationId);
      if (notification) openBookingModal(notification.clinic_name, notification.clinic_id);
    }));
    list.querySelectorAll('.notification-review-schedule').forEach(button => button.addEventListener('click', () => {
      const notification = notifications.find(item => item.id === button.dataset.notificationId);
      showTab('records', document.getElementById('nav-records'));
      openBatchBookingModal(notification?.clinic_id || '');
    }));
    const unreadCount = notifications.filter(notification => !notification.read).length;
    const unread = document.getElementById('unreadCount');
    const badge = document.getElementById('notifBadge');
    if (unread) unread.textContent = unreadCount;
    const notificationTotal = document.getElementById('notificationTotal');
    if (notificationTotal) notificationTotal.textContent = unreadCount;
    if (badge) {
      badge.textContent = unreadCount;
      badge.style.display = unreadCount ? 'inline' : 'none';
    }
    const empty = document.getElementById('emptyState');
    if (empty) empty.style.display = notifications.length ? 'none' : 'block';
  }, error => reportResidentDataError('notifications', error));
}

async function registerResidentPushAlerts() {
  const button = document.getElementById('enablePushAlertsBtn');
  const status = document.getElementById('pushAlertsStatus');
  if (!button || pushSetupInProgress) return;
  pushSetupInProgress = true;
  button.disabled = true;
  if (status) status.textContent = 'Enabling push alerts...';
  try {
    if (!currentUid || !window.isSecureContext || !('Notification' in window) || !('serviceWorker' in navigator)) {
      throw new Error('Push alerts require a signed-in account and a supported secure browser.');
    }
    if (!await isSupported()) throw new Error('This browser does not support push alerts.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Push alert permission was not granted. In-app notifications will still be available.');

    const serviceWorkerRegistration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    const messaging = getMessaging(app);
    if (!foregroundPushMessaging) {
      onMessage(messaging, payload => {
        const title = payload.notification?.title || 'Vaccination schedule update';
        const body = payload.notification?.body || '';
        if (Notification.permission === 'granted') {
          serviceWorkerRegistration.showNotification(title, { body, data: { source: 'foreground', url: payload.data?.url || '/residents.html' } });
        }
      });
      foregroundPushMessaging = messaging;
    }
    const token = await getToken(messaging, { serviceWorkerRegistration });
    if (!token) throw new Error('The browser did not provide a push token. Please try again.');
    const tokenSnapshot = await getDocs(query(collection(db, 'resident_push_tokens'), where('resident_uid', '==', currentUid)));
    const savedToken = tokenSnapshot.docs.find(item => item.data().token === token);
    if (savedToken) {
      await updateDoc(doc(db, 'resident_push_tokens', savedToken.id), { updated_at: serverTimestamp() });
    } else {
      await addDoc(collection(db, 'resident_push_tokens'), { resident_uid: currentUid, token, created_at: serverTimestamp(), updated_at: serverTimestamp() });
    }
    if (status) status.textContent = 'Push alerts are enabled on this device.';
    button.innerHTML = '<i class="fa-solid fa-bell"></i> Push alerts enabled';
  } catch (error) {
    console.error('Could not enable resident push alerts:', error);
    if (status) status.textContent = error.message || 'Could not enable push alerts. Please try again.';
  } finally {
    pushSetupInProgress = false;
    button.disabled = false;
  }
}

window.markAllRead = markAllRead;
window.filterNotifs = filterNotifs;

async function loadResidentDashboard(uid, userProfile = {}) {
  currentUid = uid;
  currentResidentName = userProfile.full_name
    || userProfile.name
    || auth.currentUser?.displayName
    || auth.currentUser?.email
    || 'Resident';
  const headerName = document.getElementById('headerName');
  if (headerName) headerName.textContent = currentResidentName;
  loadResidentNotifications(uid);
  if ('Notification' in window && Notification.permission === 'granted') registerResidentPushAlerts();
  onSnapshot(doc(db, 'residents', uid), residentDoc => {
    const residentData = residentDoc.exists() ? residentDoc.data() : {};
    residentProfile = residentData;
    populateResidentProfile(residentData);

    const residentName = [residentData.first_name, residentData.last_name].filter(Boolean).join(' ');
    currentResidentName = residentData.username
      || residentName
      || userProfile.full_name
      || userProfile.name
      || auth.currentUser?.displayName
      || auth.currentUser?.email
      || 'Resident';

    const displayName = currentResidentName || auth.currentUser?.email || 'Resident';
    const recordName = document.getElementById('recordName');
    if (headerName) headerName.textContent = displayName;
    if (recordName) recordName.textContent = displayName;
    renderLiveRecordHeader(residentVaccinationRecords, residentAppointments);
  }, error => reportResidentDataError('profile', error));

  loadResidentBookings(uid);
  let liveBookings = [];
  onSnapshot(query(collection(db, 'appointments'), where('resident_uid', '==', uid)), snapshot => {
    liveBookings = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    residentAppointments = liveBookings;
    residentVaccinationRecords = setCurrentVaccinationSession(allResidentVaccinationRecords);
    firstDoseDate = toDate(residentVaccinationRecords.find(record => Number(record.dose_number) === 1)?.date_given);
    latestVaccineBrand = residentVaccinationRecords[0]?.vaccine_name || residentVaccinationRecords[0]?.vaccine_type || '';
    updateVaccinationProgress(residentVaccinationRecords);
    renderLiveDoseRecords(residentVaccinationRecords, liveBookings);
    renderPreviousVaccinationRecords(allResidentVaccinationRecords);
    renderLiveRecordHeader(residentVaccinationRecords, liveBookings);
    renderUpcomingAppointments(liveBookings);
    renderLiveAppointments(liveBookings);
  }, error => reportResidentDataError('appointments', error));
  listenToAnimalExposure();
  listenToDashboardAnalytics();

  // Subscribe immediately so a stalled profile read cannot block other data.
  loadVaccinationDocuments(uid);

  onSnapshot(query(collection(db, 'treatments'), where('resident_uid', '==', uid)), snapshot => {
    patientTreatments = snapshot.docs.map(d => d.data());
    updateVaccinationProgress(residentVaccinationRecords);
    renderLiveDoseRecords(residentVaccinationRecords, residentAppointments);
  }, error => reportResidentDataError('treatments', error));
  onSnapshot(query(collection(db, 'vaccination_records'), where('resident_uid', '==', uid)), snapshot => {
    const allRecords = snapshot.docs.map(item => item.data()).sort((first, second) => Number(second.dose_number || 0) - Number(first.dose_number || 0));
    allResidentVaccinationRecords = allRecords;
    residentVaccinationRecords = setCurrentVaccinationSession(allRecords);
    initView(!snapshot.empty, residentVaccinationRecords[0] || null);
    firstDoseDate = residentVaccinationRecords.reduce((earliest, record) => {
      const value = toDate(record.date_given);
      return value && (!earliest || value < earliest) ? value : earliest;
    }, null);
    latestVaccineBrand = residentVaccinationRecords[0]?.vaccine_name || residentVaccinationRecords[0]?.vaccine_type || '';
    originalDoseClinicId = getPrimaryClinicId();
    if (window.clinicDirectory) populateClinicOptions(window.clinicDirectory);
    renderPreviousVaccinationRecords(allRecords);
    updateVaccinationProgress(residentVaccinationRecords);
    renderLiveRecordHeader(residentVaccinationRecords, liveBookings);
    renderLiveDoseRecords(residentVaccinationRecords, liveBookings);
    loadVaccinationDocuments(uid);
  }, error => reportResidentDataError('vaccination records', error));
}

function reportResidentDataError(section, error) {
  console.error(`Could not load resident ${section}:`, error);
  const status = document.getElementById('residentDataStatus');
  if (status) {
    status.hidden = false;
    status.textContent = `Could not load ${section}. Check your connection and refresh to try again.`;
  }
}

function populateResidentProfile(data) {
  const user = auth.currentUser;
  document.getElementById('profileUsername').value = data.username || [data.first_name, data.last_name].filter(Boolean).join(' ') || currentResidentName;
  document.getElementById('profileEmail').value = data.email || user?.email || '';
  document.getElementById('profilePhone').value = data.phone || '';
  document.getElementById('profileBirthday').value = data.birthday || '';
  document.getElementById('profileGender').value = data.gender || '';
  document.getElementById('profileAddress').value = data.address || '';
}

function populateClinicOptions(clinics) {
  const bookableClinics = clinics.filter(clinic => clinic.status === 'available');
  const orderedClinics = originalDoseClinicId
    ? [...bookableClinics].sort((first, second) => Number(second.id === originalDoseClinicId) - Number(first.id === originalDoseClinicId))
    : bookableClinics;
  const select = document.getElementById('modalClinic');
  if (select) {
    select.innerHTML = '';
    orderedClinics.forEach((clinic) => {
      const option = document.createElement('option');
      option.value = clinic.id;
      const optionStatus = `${clinic.status === 'low' ? 'Low Stock' : 'Available'} - ${clinic.stock_total || 0} doses available`;
      option.textContent = `${clinic.name} (${clinic.type}) - ${optionStatus}`;
      option.dataset.name = clinic.name;
      select.appendChild(option);
    });
  }
  renderClinicBookingList(clinics);
  populateClinicFilters(clinics);
}

async function confirmClinicWithHistory(clinic) {
  const records = residentVaccinationRecords.length
    ? residentVaccinationRecords : allResidentVaccinationRecords;
  const history = [...records]
    .filter(record => record.clinic_id)
    .sort((a, b) => String(b.date_given || '').localeCompare(String(a.date_given || '')))[0]
    || [...residentAppointments]
      .filter(appointment => appointment.clinic_id
        && !['cancelled', 'canceled', 'rejected', 'declined', 'expired'].includes(appointment.status))
      .sort((a, b) => (b.created_at?.toMillis?.() || 0) - (a.created_at?.toMillis?.() || 0))[0];
  if (!history || history.clinic_id === clinic.id) return true;
  const previousName = window.clinicDirectory?.find(item => item.id === history.clinic_id)?.name
    || history.clinic_name || 'another clinic';
  return confirmDialog(
    `You have a booking or vaccination dose history at ${previousName}. Are you sure you want to book at ${clinic.name || 'this clinic'}?`,
    { title: 'Book at a different clinic?', confirmText: 'Yes, book here' }
  );
}

function getPrimaryClinicId() {
  const firstCompletedDose = [...residentVaccinationRecords]
    .filter(record => record.clinic_id && record.date_given)
    .sort((a, b) => Number(a.dose_number || 0) - Number(b.dose_number || 0)
      || String(a.date_given).localeCompare(String(b.date_given)))[0];
  if (firstCompletedDose?.clinic_id) return firstCompletedDose.clinic_id;
  const firstBookedDose = residentAppointments
    .filter(appointment => (appointment.vaccination_session_id || 'legacy') === (currentVaccinationSessionId || 'legacy')
      && appointment.clinic_id
      && ['pending', 'confirmed', 'accepted', 'approved', 'in_progress', 'completed'].includes(appointment.status))
    .sort((a, b) => (a.created_at?.toMillis?.() || 0) - (b.created_at?.toMillis?.() || 0))[0];
  return firstBookedDose?.primary_clinic_id || firstBookedDose?.clinic_id || '';
}

function courseBookingContext() {
  const courseAppointments = residentAppointments.filter(appointment =>
    (appointment.vaccination_session_id || 'legacy') === (currentVaccinationSessionId || 'legacy'));
  const intakeSource = courseAppointments.find(appointment => appointment.course_intake_data)
    || courseAppointments.find(appointment => appointment.bite_date || appointment.animal_type)
    || {};
  return { courseAppointments, intake: intakeSource.course_intake_data || intakeSource };
}

function buildCourseHistory() {
  return [...residentVaccinationRecords]
    .sort((a, b) => Number(a.dose_number || 0) - Number(b.dose_number || 0))
    .map(record => ({ dose_number: record.dose_number, date_given: record.date_given || '', vaccine_name: record.vaccine_name || record.vaccine_type || '', clinic_id: record.clinic_id || '', clinic_name: record.clinic_name || '' }));
}

window.populateClinicOptions = populateClinicOptions;
if (window.clinicDirectory) populateClinicOptions(window.clinicDirectory);

function renderClinicBookingList(clinics) {
  const list = document.getElementById('clinicBookingList');
  if (!list) return;
  if (!clinics.length) {
    list.innerHTML = '<p style="padding:16px;color:#6b7280;">No clinics are available yet.</p>';
    return;
  }

  list.innerHTML = clinics.map((clinic) => {
    const isOut = clinic.status === 'out';
    const isLow = clinic.status === 'low';
    const color = isOut ? '#ef4444' : isLow ? '#d97706' : '#16a34a';
    const background = isOut ? '#fee2e2' : isLow ? '#fef3c7' : '#dcfce7';
    const statusText = isOut ? 'Out of stock' : `${isLow ? 'Low stock' : 'Available'} | ${clinic.stock_total || 0} doses available`;
    return `
      <div class="clinic-row">
        <div class="clinic-row-icon" style="background:${background};"><i class="fa-solid fa-hospital" style="color:${color};"></i></div>
        <div class="clinic-row-info">
          <h4>${escapeHtml(clinic.name)} <span style="font-size:12px;color:#6b7280;font-weight:normal;">(${escapeHtml(clinic.type)})</span></h4>
          <p>${escapeHtml(clinic.address || 'Address not provided')} &nbsp;|&nbsp; ${escapeHtml(clinic.hours || 'Hours not provided')} &nbsp;|&nbsp; <strong style="color:${color};">${statusText}</strong></p>
        </div>
        <button class="book-btn dynamic-book-btn" data-clinic-id="${escapeHtml(clinic.id)}" ${isOut || isLow ? 'disabled' : ''}>${isOut || isLow ? 'Unavailable' : 'Book Now'}</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.dynamic-book-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const clinic = clinics.find(item => item.id === button.dataset.clinicId);
      if (clinic) openBookingModal(clinic.name, clinic.id);
    });
  });
}

function populateClinicFilters(clinics) {
  const barangayFilter = document.getElementById('clinicBarangayFilter');
  if (!barangayFilter) return;
  const barangays = [...new Set(clinics.map(clinic => clinic.barangay).filter(Boolean))].sort();
  const currentValue = barangayFilter.value;
  barangayFilter.innerHTML = '<option value="all">All barangays</option>' + barangays.map(barangay => `<option value="${escapeHtml(barangay)}">${escapeHtml(barangay)}</option>`).join('');
  barangayFilter.value = barangays.includes(currentValue) ? currentValue : 'all';
  applyClinicFilters();
}

function applyClinicFilters() {
  const clinics = window.clinicDirectory || [];
  const search = (document.getElementById('clinicSearch')?.value || '').trim().toLowerCase();
  const barangay = document.getElementById('clinicBarangayFilter')?.value || 'all';
  const hours = document.getElementById('clinicHoursFilter')?.value || 'all';
  const price = document.getElementById('clinicPriceFilter')?.value || 'all';
  const filtered = clinics.filter(clinic => {
    const haystack = `${clinic.name} ${clinic.address}`.toLowerCase();
    const hoursText = `${clinic.hours} ${clinic.weekendHours || ''}`.toLowerCase();
    return (!search || haystack.includes(search))
      && (barangay === 'all' || clinic.barangay === barangay)
      && (hours === 'all' || hours === 'open' && !hoursText.includes('closed') || hours === 'weekday' && Boolean(clinic.hours) || hours === 'weekend' && Boolean(clinic.weekendHours) && !String(clinic.weekendHours).toLowerCase().includes('closed'))
      && matchesPrice(clinic.priceRange, price)
      ;
  });
  renderClinicBookingList(filtered);
  const summary = document.getElementById('clinicFilterSummary');
  if (summary) summary.textContent = `${filtered.length} of ${clinics.length} clinic${clinics.length === 1 ? '' : 's'} shown`;
}

function matchesPrice(value, filter) {
  if (filter === 'all') return true;
  const text = String(value || '').toLowerCase();
  if (filter === 'free') return text.includes('free') || text.includes('government');
  const amounts = [...text.matchAll(/(?:php|₱)?\s*([\d,]+)/gi)].map(match => Number(match[1].replace(/,/g, ''))).filter(Number.isFinite);
  if (!amounts.length) return false;
  const lowest = Math.min(...amounts);
  const highest = Math.max(...amounts);
  if (filter === 'under500') return lowest < 500;
  if (filter === '500to1500') return lowest <= 1500 && highest >= 500;
  return highest > 1500;
}

['clinicSearch', 'clinicBarangayFilter', 'clinicHoursFilter', 'clinicPriceFilter'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', applyClinicFilters);
  document.getElementById(id)?.addEventListener('change', applyClinicFilters);
});
document.getElementById('clearClinicFilters')?.addEventListener('click', () => {
  ['clinicSearch', 'clinicBarangayFilter', 'clinicHoursFilter', 'clinicPriceFilter'].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.value = element.tagName === 'SELECT' ? 'all' : '';
  });
  applyClinicFilters();
});

async function loadResidentBookings(uid) {
  const container = document.getElementById('bookingRecords');
  if (!container) return;
  try {
    let bookings = [];
    let recordsLoaded = false;
    const renderBookings = () => {
      if (!recordsLoaded) return;
      completedDoseCount = Math.min(5, residentVaccinationRecords.reduce((highest, record) => Math.max(highest, Number(record.dose_number || 0)), 0));
      firstDoseDate = residentVaccinationRecords.reduce((earliest, record) => {
        const value = toDate(record.date_given);
        return value && (!earliest || value < earliest) ? value : earliest;
      }, null);
      const latestRecord = residentVaccinationRecords.find(record => Number(record.dose_number || 0) === completedDoseCount);
      latestVaccineBrand = latestRecord?.vaccine_name || latestRecord?.vaccine_type || '';
      originalDoseClinicId = getPrimaryClinicId();

      if (!bookings.length) {
        container.innerHTML = `<div class="booking-progress-panel booking-empty-state"><h3><i class="fa-regular fa-calendar-check"></i> Booking Records</h3><p>No booking records yet. Your appointment progress will appear here after you book.</p></div>`;
        return;
      }
      const nextDose = Math.min(5, completedDoseCount + 1);
      renderLiveDoseRecords(residentVaccinationRecords, bookings);
      const nextDoseDate = patientTreatments.find(t => t.vaccination_session_id === (currentVaccinationSessionId || 'legacy'))?.doses?.find(d => d.dose_number === nextDose)?.recommended_date || (firstDoseDate && nextDose > 1 ? formatInputDate(firstDoseDate, doseDayOffsets[nextDose - 1]) : '');
      const latestCompletedAppointment = bookings.find(booking => booking.status === 'completed' && (Number(booking.completed_dose_number || 0) || Number(String(booking.dose_label || '').match(/\d+/)?.[0] || 0)) === completedDoseCount);
      const bookingMarkup = `<div class="booking-progress-panel"><h3><i class="fa-regular fa-calendar-check"></i> Booking Records</h3>${bookings.map(booking => {
        const status = appointmentStatus(booking);
        return `
        <div class="booking-progress-card"><div class="booking-progress-heading"><div><strong>${escapeHtml(booking.clinic_name || 'Clinic')}</strong><div>${escapeHtml(booking.preferred_date || '')} at ${escapeHtml(booking.preferred_time || '')} - ${escapeHtml(booking.dose_label || 'Dose 1')}</div></div><span class="booking-status status-${escapeHtml(status || 'pending')}">${status === 'in_progress' ? 'Arrived' : status === 'confirmed' ? 'Confirmed' : status === 'completed' ? 'Completed' : status === 'declined' ? 'Declined' : status === 'expired' ? 'Expired' : 'Pending clinic review'}</span></div>
        <button type="button" class="view-record-button" data-record-id="${escapeHtml(booking.id)}">View Full Record</button><div class="full-record-details" id="full-record-${escapeHtml(booking.id)}" hidden><strong>Vaccination progress</strong><p>${completedDoseCount} of 5 doses completed.</p><p>${completedDoseCount < 5 ? `Next: Dose ${nextDose} (Day ${doseDayOffsets[nextDose - 1]})${nextDoseDate ? ` on ${formatRecordDate(nextDoseDate)}` : ''}.` : 'Vaccination schedule complete.'}</p>${completedDoseCount < 5 && latestCompletedAppointment?.id === booking.id ? `<button type="button" class="next-dose-button" data-clinic-id="${escapeHtml(latestRecord?.clinic_id || booking.clinic_id || '')}">Book Dose ${nextDose}${nextDoseDate ? ` for ${formatRecordDate(nextDoseDate)}` : ''}</button>` : ''}</div>
        ${status === 'declined' ? '<p class="booking-status-message">This appointment was declined by the clinic. Please choose another clinic or date.</p>' : status === 'expired' ? '<p class="booking-status-message">This appointment has expired. Please book a new appointment.</p>' : `<div class="booking-steps"><div class="booking-step done"><span><i class="fa-solid fa-check"></i></span><small>Booked</small></div><div class="booking-step ${status === 'pending' ? 'current' : 'done'}"><span>${status === 'pending' ? '<i class="fa-solid fa-clock"></i>' : '<i class="fa-solid fa-check"></i>'}</span><small>${status === 'pending' ? 'Under review' : 'Confirmed'}</small></div><div class="booking-step ${status === 'completed' ? 'done' : ''}"><span>${status === 'completed' ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-calendar-day"></i>'}</span><small>${status === 'completed' ? 'Dose recorded' : 'Appointment'}</small></div></div>`}</div>`; }).join('')}</div>`;
      container.innerHTML = bookingMarkup;
      container.querySelectorAll('.view-record-button').forEach(button => button.addEventListener('click', () => { const details = document.getElementById(`full-record-${button.dataset.recordId}`); if (details) details.hidden = !details.hidden; }));
      container.querySelectorAll('.next-dose-button').forEach(button => button.addEventListener('click', () => { const clinic = window.clinicDirectory?.find(item => item.id === button.dataset.clinicId); openBookingModal(clinic?.name || '', clinic?.id || ''); }));
    };
    onSnapshot(query(collection(db, 'vaccination_records'), where('resident_uid', '==', uid)), snapshot => {
      residentVaccinationRecords = setCurrentVaccinationSession(snapshot.docs.map(item => item.data()).filter(r => r.date_given && (r.source !== 'external' || r.verification_status === 'Verified')).sort((first, second) => String(second.date_given || '').localeCompare(String(first.date_given || ''))));
      recordsLoaded = true;
      renderLiveDoseRecords(residentVaccinationRecords, bookings);
      renderBookings();
    }, error => console.error('Failed to listen for vaccination records:', error));
    onSnapshot(query(collection(db, 'appointments'), where('resident_uid', '==', uid)), (snapshot) => {
      bookings = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .sort((a, b) => `${b.preferred_date || ''} ${b.preferred_time || ''}`.localeCompare(`${a.preferred_date || ''} ${a.preferred_time || ''}`));
      renderUpcomingAppointments(bookings);
      renderLiveAppointments(bookings);
      renderBookings();
    }, (error) => {
      console.error('Failed to listen for resident bookings:', error);
      container.innerHTML = `
        <div class="booking-progress-panel booking-empty-state">
          <h3><i class="fa-regular fa-calendar-xmark"></i> Booking Records</h3>
          <p>Booking records could not be loaded. Please refresh the page and try again.</p>
        </div>`;
    });
  } catch (error) {
    console.error('Failed to load resident bookings:', error);
  }
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatInputDate(date, dayOffset) {
  const scheduled = new Date(date);
  scheduled.setDate(scheduled.getDate() + dayOffset);
  return scheduled.toISOString().split('T')[0];
}

function formatScheduleDate(date, dayOffset) {
  return new Date(formatInputDate(date, dayOffset) + 'T00:00:00').toLocaleDateString();
}

function renderLiveDoseRecords(records, bookings = []) {
  const list = document.getElementById('liveDoseRecordList');
  if (!list) return;
  const selectedKeys = new Set([...list.querySelectorAll('.current-dose-checkbox:checked')].map(input => input.dataset.recordKey));
  const recordKey = record => JSON.stringify([record.vaccination_session_id || 'legacy', record.dose_number, record.date_given, record.clinic_id]);
  const completedByDose = new Map(records.map(record => [Number(record.dose_number), record]));
  bookings = bookings.filter(b => (b.vaccination_session_id || 'legacy') === (currentVaccinationSessionId || 'legacy'));
  const bookingByDose = new Map(bookings.map(booking => [Number(String(booking.dose_label || '').match(/\d+/)?.[0] || 0), booking]));
  list.innerHTML = Array.from({ length: 5 }, (_, index) => {
    const doseNumber = index + 1;
    const completed = completedByDose.get(doseNumber);
    const booking = bookingByDose.get(doseNumber);
    const dayOffset = doseDayOffsets[index];
    const first = records.find(r => Number(r.dose_number) === 1);
    const treatmentDose = patientTreatments.find(t => t.vaccination_session_id === (currentVaccinationSessionId || 'legacy'))?.doses?.find(d => d.dose_number === doseNumber);
    const recommended = treatmentDose?.recommended_date || booking?.recommended_date || (first?.date_given ? formatInputDate(new Date(first.date_given), dayOffset) : '');
    const overdue = !completed && recommended && recommended < manilaToday();
    if (completed) {
      const date = formatRecordDate(completed.date_given);
      const clinic = completed.clinic_name || 'Clinic not specified';
      const location = completed.clinic_location ? ` | ${completed.clinic_location}` : '';
      const vaccine = completed.vaccine_name || completed.vaccine_type || 'Vaccine not specified';
      const administrator = completed.administered_by_name ? ` | ${completed.administered_by_name}` : '';
      return `<div class="dose-record"><input type="checkbox" class="dose-report-checkbox current-dose-checkbox" data-dose-number="${doseNumber}" data-record-key="${escapeHtml(recordKey(completed))}" aria-label="Select Dose ${doseNumber} for report" ${selectedKeys.has(recordKey(completed)) ? 'checked' : ''}><div class="dose-circle done-circle"><i class="fa-solid fa-check"></i></div><div class="dose-record-info"><h4>Dose ${doseNumber} - Day ${dayOffset}</h4><p>${escapeHtml(date)} | ${escapeHtml(clinic)}${escapeHtml(location)} | ${escapeHtml(vaccine)}${escapeHtml(administrator)}</p></div><div class="dose-record-status"><span class="r-done">${completed.source === 'external' || /verified previous record|verified history|verified past dose/i.test(completed.status || '') ? 'Completed (Verified History)' : 'Completed'}</span><button type="button" class="completed-dose-button" data-completed-dose="${doseNumber}" aria-haspopup="dialog">View dose <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button></div></div>`;
    }
    if (booking && ['pending', 'confirmed'].includes(booking.status)) {
      const recommendedMarkup = treatmentDose?.recommended_date
        ? `<p>Clinic recommended: ${escapeHtml(formatRecordDate(treatmentDose.recommended_date))}</p>`
        : '';
      return `<div class="dose-record"><div class="dose-circle next-circle"><i class="fa-regular fa-calendar"></i></div><div class="dose-record-info"><h4>Dose ${doseNumber} - Day ${dayOffset}</h4>${recommendedMarkup}<p>Appointment: ${escapeHtml(formatRecordDate(booking.preferred_date))} at ${escapeHtml(booking.preferred_time || '')} | ${escapeHtml(booking.clinic_name || 'Clinic')}</p></div><div class="dose-record-status"><span class="r-next">${overdue ? 'Overdue' : 'Upcoming'}</span></div></div>`;
    }
    return `<div class="dose-record"><div class="dose-circle pending-circle">${doseNumber}</div><div class="dose-record-info"><h4>Dose ${doseNumber} - Day ${dayOffset}</h4><p>${recommended ? `${treatmentDose?.recommended_date ? 'Clinic recommended: ' : 'Recommended: '}${escapeHtml(formatRecordDate(recommended))}` : 'Not yet scheduled'}</p></div><div class="dose-record-status"><span class="r-pending">${overdue ? 'Overdue' : 'Pending'}</span></div></div>`;
  }).join('');
  const courseTreatment = patientTreatments.find(t => t.vaccination_session_id === (currentVaccinationSessionId || 'legacy'));
  const activeByDose = new Map(bookings.map(booking => [
    Number(booking.dose_number || String(booking.dose_label || '').match(/\d+/)?.[0] || 0),
    booking
  ]));
  const bookableDoses = Array.from({ length: 5 }, (_, index) => index + 1)
    .filter(doseNumber => !completedByDose.has(doseNumber) && activeByDose.get(doseNumber)?.status !== 'in_progress');
  const hasRecommendations = bookableDoses.length && bookableDoses.every(doseNumber =>
    courseTreatment?.doses?.find(dose => dose.dose_number === doseNumber)?.recommended_date
  );
  if (hasRecommendations) {
    list.insertAdjacentHTML('beforeend', `<button type="button" class="action-btn" id="openBatchBookingBtn"><i class="fa-regular fa-calendar-check"></i> Book all recommended dates (${bookableDoses.length} doses)</button>`);
    list.querySelector('#openBatchBookingBtn').addEventListener('click', () => openBatchBookingModal());
  }
  if (list.querySelector('.current-dose-checkbox')) {
    list.insertAdjacentHTML('afterbegin', '<p class="dose-selection-help">Select completed doses to preview and print a report.</p>');
    list.insertAdjacentHTML('beforeend', '<div class="dose-selection-actions"><span class="dose-selection-count" role="status"></span><button type="button" class="dose-report-preview-button" aria-haspopup="dialog" disabled>Preview selected doses</button></div>');
    const selected = () => [...list.querySelectorAll('.current-dose-checkbox:checked')]
      .map(input => completedByDose.get(Number(input.dataset.doseNumber)));
    const previewButton = list.querySelector('.dose-report-preview-button');
    const updateSelection = () => {
      const count = selected().length;
      list.querySelector('.dose-selection-count').textContent = `${count} dose${count === 1 ? '' : 's'} selected`;
      previewButton.disabled = count === 0;
    };
    list.querySelectorAll('.current-dose-checkbox').forEach(input => input.addEventListener('change', updateSelection));
    previewButton.addEventListener('click', () => {
      const selectedRecords = selected();
      if (selectedRecords.length) openDoseReportPreview(selectedRecords, currentResidentName, formatRecordDate);
    });
    updateSelection();
  }
  list.querySelectorAll('[data-completed-dose]').forEach(button => button.addEventListener('click', () => {
    const record = completedByDose.get(Number(button.dataset.completedDose));
    openDosePreview(record, currentResidentName, formatRecordDate(record.date_given));
  }));
}
function formatRecordDate(value) {
  const date = toDate(value);
  return date ? date.toLocaleDateString() : String(value || 'Date not specified');
}

function renderLiveRecordHeader(records, bookings = []) {
  const orderedRecords = [...records].sort((first, second) => {
    const firstDate = toDate(first.date_given)?.getTime() || Number.MAX_SAFE_INTEGER;
    const secondDate = toDate(second.date_given)?.getTime() || Number.MAX_SAFE_INTEGER;
    return firstDate - secondDate;
  });
  const firstRecord = orderedRecords[0];
  if (!firstRecord) {
    for (const id of ['recordCaseId', 'recordStart', 'recordVaccine', 'recordBiteSite', 'recordAnimal', 'recordCategory']) {
      const element = document.getElementById(id);
      if (element) element.textContent = 'Not yet recorded';
    }
    return;
  }
  const linkedAppointment = bookings.find(booking => booking.id === firstRecord.appointment_id)
    || bookings.find(booking => Number(String(booking.dose_label || '').match(/\d+/)?.[0] || 0) === Number(firstRecord.dose_number || 1));
  const setText = (id, value, fallback) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value || fallback;
  };
  setText('recordCaseId', firstRecord.case_id || findPublicCaseId(firstRecord, linkedAppointment), 'Not assigned');
  setText('recordStart', formatRecordDate(firstRecord.date_given), 'Date not specified');
  setText('recordVaccine', firstRecord.vaccine_name || firstRecord.vaccine_type, 'Vaccine not specified');
  setText('recordBiteSite', linkedAppointment?.bite_body_part, 'Not recorded');
  setText('recordAnimal', linkedAppointment?.animal_type, 'Not recorded');
  setText('recordCategory', linkedAppointment?.patient_category, 'Not recorded');
}

function findPublicCaseId(firstRecord, appointment) {
  const caseDate = [
    appointment?.bite_date,
    firstRecord.bite_date,
    appointment?.preferred_date,
    firstRecord.preferred_date,
    firstRecord.date_given
  ].map(value => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    return toDate(value)?.toISOString().slice(0, 10);
  }).find(Boolean);
  const animal = String(appointment?.animal_type || firstRecord.animal_type || '').trim().toLowerCase();
  const category = String(appointment?.patient_category || firstRecord.patient_category || '').trim().toLowerCase();
  if (!caseDate || (!animal && !category)) return '';
  const matches = livePublicCaseRecords.filter(record =>
    caseDate === String(record.date || '').slice(0, 10)
    && (!animal || String(record.animal || '').trim().toLowerCase() === animal)
    && (!category || String(record.category || '').trim().toLowerCase() === category || record.category === 'Not recorded')
  );
  return matches.length === 1 ? matches[0].caseId : '';
}

function updateVaccinationProgress(records) {
  const completedDoses = new Set(records
    .map(record => Number(record.dose_number || 0))
    .filter(doseNumber => doseNumber >= 1 && doseNumber <= 5));
  completedDoseCount = completedDoses.size;
  const next = [1,2,3,4,5].find(n => !completedDoses.has(n));
  const due = patientTreatments.find(t => t.vaccination_session_id === (currentVaccinationSessionId || 'legacy'))?.doses?.find(d => d.dose_number === next)?.recommended_date || (firstDoseDate && next ? formatInputDate(firstDoseDate, doseDayOffsets[next - 1]) : '');
  const nextLabel = document.getElementById('nextDoseLabel');
  if (nextLabel) nextLabel.textContent = next ? 'Next: Dose ' + next + (due ? ' on ' + formatRecordDate(due) : ' - awaiting clinical schedule confirmation') : 'Vaccination treatment complete';
  const total = 5;
  const pct = Math.round((completedDoseCount / total) * 100);
  const activeDoses = document.getElementById('activeDosesCount');
  const progressLabel = document.getElementById('progressLabel');
  const progressBar = document.getElementById('progressBar');
  const progressPct = document.getElementById('progressPct');
  const recordPct = document.getElementById('recordPct');
  const recordDoses = document.getElementById('recordDoses');
  if (activeDoses) activeDoses.textContent = completedDoseCount;
  if (progressLabel) progressLabel.textContent = `Treatment Progress - ${completedDoseCount} of ${total} doses`;
  if (progressBar) progressBar.style.width = `${pct}%`;
  if (progressPct) progressPct.textContent = `${pct}% Complete`;
  if (recordPct) recordPct.textContent = `${pct}%`;
  if (recordDoses) recordDoses.textContent = `${completedDoseCount} / ${total} doses`;
  for (let doseNumber = 1; doseNumber <= total; doseNumber++) {
    const pip = document.getElementById(`pip${doseNumber}`);
    if (!pip) continue;
    pip.className = completedDoses.has(doseNumber) ? 'dose-pip done' : doseNumber === [1,2,3,4,5].find(n => !completedDoses.has(n)) ? 'dose-pip current' : 'dose-pip';
  }
}

function setCurrentVaccinationSession(records) {
  records = records.filter(r => r.date_given && (r.source !== 'external' || r.verification_status === 'Verified'));
  const latestAppointment = [...residentAppointments].sort((a, b) =>
    (b.created_at?.toMillis?.() || 0) - (a.created_at?.toMillis?.() || 0))[0];
  // A newly booked course can be current before its first dose is administered.
  const awaitingAppointment = currentVaccinationSessionId
    && !records.some(record => (record.vaccination_session_id || 'legacy') === currentVaccinationSessionId)
    && !residentAppointments.some(appointment => (appointment.vaccination_session_id || 'legacy') === currentVaccinationSessionId);
  if (latestAppointment?.vaccination_session_id && !awaitingAppointment) {
    currentVaccinationSessionId = latestAppointment.vaccination_session_id;
    return records.filter(record => (record.vaccination_session_id || 'legacy') === currentVaccinationSessionId);
  }
  if (awaitingAppointment) return [];
  if (!records.length) {
    currentVaccinationSessionId = '';
    return records;
  }
  const sessions = records.filter(record => record.vaccination_session_id);
  if (currentVaccinationSessionId) {
    const currentRecords = records.filter(record => (record.vaccination_session_id || 'legacy') === currentVaccinationSessionId);
    if (currentRecords.length) return currentRecords;
  }
  if (sessions.length) {
    const latestSessionRecord = [...sessions].sort((first, second) => String(second.date_given || '').localeCompare(String(first.date_given || '')))[0];
    currentVaccinationSessionId = latestSessionRecord.vaccination_session_id;
    return records.filter(record => record.vaccination_session_id === currentVaccinationSessionId);
  }
  currentVaccinationSessionId = 'legacy';
  return records;
}

function renderPreviousVaccinationRecords(allRecords) {
  const container = document.getElementById('previousVaccinationRecords');
  if (!container) return;
  const previousRecords = allRecords.filter(record => (record.vaccination_session_id || 'legacy') !== currentVaccinationSessionId);
  if (!previousRecords.length) {
    container.innerHTML = '';
    return;
  }
  const sessions = new Map();
  previousRecords.forEach(record => {
    const sessionId = record.vaccination_session_id || 'legacy';
    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    sessions.get(sessionId).push(record);
  });
  container.innerHTML = `<div class="previous-records-heading"><i class="fa-solid fa-clock-rotate-left"></i> Previous History</div>${[...sessions.values()].map((records, index) => {
    const ordered = records.sort((first, second) => Number(first.dose_number || 0) - Number(second.dose_number || 0));
    const first = ordered[0];
    const completed = new Set(ordered.map(record => Number(record.dose_number || 0))).size;
    const percent = Math.round((completed / 5) * 100);
    const sessionId = first.vaccination_session_id || 'legacy';
    // Legacy uploads were created before course IDs existed. Show those only
    // under the most recent previous record, never under the active course.
    const courseDocuments = allResidentVaccinationDocuments.filter(document =>
      document.vaccination_session_id === sessionId || (!document.vaccination_session_id && index === 0));
    const documentMarkup = courseDocuments.length
      ? `<div class="previous-record-documents"><strong>Uploaded documents</strong>${courseDocuments.map(document => renderDocumentPreview(document)).join('')}</div>`
      : '';
    return `<details class="previous-record-card"><summary><div class="previous-record-main"><div class="previous-record-title-row"><strong>Vaccination Record - ${escapeHtml(first.clinic_name || 'Previous clinic')}</strong><span class="previous-completed-badge">${percent}% Complete</span></div><small>Started ${escapeHtml(formatRecordDate(first.date_given))} | ${completed} / 5 doses</small><div class="previous-progress-track"><span style="width:${percent}%;"></span></div></div><div class="previous-record-progress"><b>${percent}%</b><small>complete</small></div><i class="fa-solid fa-chevron-down previous-record-chevron"></i></summary><div class="previous-dose-list"><strong>Completed doses</strong><p class="dose-selection-help">Select doses to include in your report, or click a dose to view its details.</p>${ordered.map(record => `<div class="dose-selection-row"><input type="checkbox" class="dose-report-checkbox" data-record-index="${previousRecords.indexOf(record)}" aria-label="Select Dose ${escapeHtml(record.dose_number)} dated ${escapeHtml(formatRecordDate(record.date_given))}"><button type="button" class="completed-dose-button" data-dose-index="${previousRecords.indexOf(record)}" aria-haspopup="dialog"><i class="fa-solid fa-check" aria-hidden="true"></i><span>Dose ${escapeHtml(record.dose_number)}: ${escapeHtml(formatRecordDate(record.date_given))} | ${escapeHtml(record.clinic_name || 'Clinic')}</span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button></div>`).join('')}<div class="dose-selection-actions"><span class="dose-selection-count" role="status">0 doses selected</span><button type="button" class="dose-report-preview-button" disabled aria-haspopup="dialog">Preview selected doses</button></div></div>${documentMarkup}</details>`;
  }).join('')}`;
  container.querySelectorAll('.previous-record-card').forEach(card => {
    const previewButton = card.querySelector('.dose-report-preview-button');
    const selected = () => [...card.querySelectorAll('.dose-report-checkbox:checked')]
      .map(checkbox => previousRecords[Number(checkbox.dataset.recordIndex)]);
    card.querySelectorAll('.dose-report-checkbox').forEach(checkbox => checkbox.addEventListener('change', () => {
      const count = selected().length;
      card.querySelector('.dose-selection-count').textContent = `${count} dose${count === 1 ? '' : 's'} selected`;
      previewButton.disabled = count === 0;
    }));
    previewButton.addEventListener('click', () => {
      const records = selected();
      if (records.length) openDoseReportPreview(records, currentResidentName, formatRecordDate);
    });
  });
  container.querySelectorAll('[data-dose-index]').forEach(button => button.addEventListener('click', () => {
    const record = previousRecords[Number(button.dataset.doseIndex)];
    openDosePreview(record, currentResidentName, formatRecordDate(record.date_given));
  }));
  container.querySelectorAll('.previous-document-delete-button').forEach(button => button.addEventListener('click', () => deleteVaccinationDocument(button.dataset.documentId)));
}

function renderDocumentPreview(document) {
  const isImage = document.file_type?.startsWith('image/')
    || /\.(jpe?g|png)(?:[?#]|$)/i.test(document.file_name || '')
    || /\.(jpe?g|png)(?:[?#]|&|$)/i.test(document.download_url || '');
  return `<div class="previous-document-preview">${isImage ? `<img src="${escapeHtml(document.download_url || '')}" alt="Uploaded vaccination document">` : '<i class="fa-regular fa-file-lines"></i>'}<div><strong>${escapeHtml(document.file_name || 'Vaccination document')}</strong><a href="${escapeHtml(document.download_url || '#')}" target="_blank" rel="noopener">Open document</a><button type="button" class="previous-document-delete-button" data-document-id="${escapeHtml(document.id)}"><i class="fa-solid fa-trash"></i> Delete</button></div></div>`;
}

function loadVaccinationDocuments(uid) {
  const container = document.getElementById('vaccinationDocuments');
  if (!container) return;
  vaccinationDocumentsUnsubscribe?.();
  const controls = document.getElementById('uploadDocumentControls');
  const help = document.getElementById('vaccinationDocumentHelp');
  if (controls) controls.hidden = false;
  if (help) help.textContent = 'Upload a vaccination card for clinic verification of external doses. Uploads do not count as administered doses.';
  const documentsQuery = query(collection(db, 'vaccination_documents'), where('resident_uid', '==', uid));
  const renderDocumentList = documents => {
    residentVaccinationDocuments = documents;
    renderPreviousVaccinationRecords(allResidentVaccinationRecords);
    documents = documents
      .sort((first, second) => (second.uploaded_at?.toMillis?.() || 0) - (first.uploaded_at?.toMillis?.() || 0));
    if (!documents.length) {
      container.innerHTML = '<p class="documents-empty">No vaccination document uploaded yet.</p>';
      const controls = document.getElementById('uploadDocumentControls');
      if (controls) controls.hidden = false;
      return;
    }
    const controls = document.getElementById('uploadDocumentControls');
    if (controls) controls.hidden = true;
    container.innerHTML = `<h4 class="documents-title">Uploaded documents</h4>${documents.map(document => {
      const isImage = document.file_type?.startsWith('image/')
        || /\.(jpe?g|png)(?:[?#]|$)/i.test(document.file_name || '')
        || /\.(jpe?g|png)(?:[?#]|&|$)/i.test(document.download_url || '');
      return `
      <div class="vaccination-document" data-document-id="${escapeHtml(document.id)}">
        <div class="document-preview-wrap">${isImage ? `<img class="document-preview" src="${escapeHtml(document.download_url || '')}" alt="Uploaded vaccination document">` : '<i class="fa-regular fa-file-lines document-file-icon"></i>'}<button type="button" class="document-delete-button" data-document-id="${escapeHtml(document.id)}" title="Delete uploaded document" aria-label="Delete uploaded document"><i class="fa-solid fa-trash"></i></button></div>
        <div class="document-summary-text"><strong>${escapeHtml(document.file_name || 'Vaccination document')}</strong><small>${escapeHtml(document.file_type || 'File')} | ${escapeHtml(document.uploaded_at?.toDate ? document.uploaded_at.toDate().toLocaleDateString() : 'Uploaded')}</small></div>
        <div class="document-details"><p><strong>File:</strong> ${escapeHtml(document.file_name || 'Not available')}</p><p><strong>Uploaded:</strong> ${escapeHtml(document.uploaded_at?.toDate ? document.uploaded_at.toDate().toLocaleString() : 'Not available')}</p><a href="${escapeHtml(document.download_url || '#')}" target="_blank" rel="noopener">Open full document <i class="fa-solid fa-arrow-up-right-from-square"></i></a></div>
      </div>`;
    }).join('')}`;
    container.querySelectorAll('.document-delete-button').forEach(button => button.addEventListener('click', () => deleteVaccinationDocument(button.dataset.documentId)));
  };
  const renderDocuments = snapshot => {
    // Documents are tied to one 5-dose course. Older uploads must never leak
    // into the current course's record panel.
    allResidentVaccinationDocuments = snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
    const documents = allResidentVaccinationDocuments
      .filter(document => (document.vaccination_session_id || 'legacy') === (currentVaccinationSessionId || 'legacy'));
    renderPreviousVaccinationRecords(allResidentVaccinationRecords);
    if (documents.length) {
      renderDocumentList(documents);
      return;
    }
    renderDocumentList([]);
  };
  container.innerHTML = '<p class="documents-loading">Loading uploaded document...</p>';
  getDocs(documentsQuery).then(renderDocuments).catch(error => {
    console.error('Failed to load vaccination documents:', error);
    container.innerHTML = `<p class="document-error">Could not load uploaded documents: ${escapeHtml(error.message)}</p>`;
  });
  vaccinationDocumentsUnsubscribe = onSnapshot(documentsQuery, renderDocuments, error => {
    console.error('Failed to listen for vaccination documents:', error);
    if (!container.querySelector('.vaccination-document')) {
      container.innerHTML = `<p class="document-error">Could not load uploaded documents: ${escapeHtml(error.message)}</p>`;
    }
  });
}

async function deleteVaccinationDocument(documentId) {
  if (!documentId || !currentUid || !await confirmDialog('Delete this uploaded vaccination document?')) return;
  try {
    const documentSnap = await getDoc(doc(db, 'vaccination_documents', documentId));
    if (!documentSnap.exists() || documentSnap.data().resident_uid !== currentUid) throw new Error('This document is no longer available.');
    const record = documentSnap.data();
    if (record.storage_path) {
      try {
        await deleteObject(ref(storage, record.storage_path));
      } catch (storageError) {
        // Older document rows may point at a file that has already been removed.
        if (storageError.code !== 'storage/object-not-found') throw storageError;
      }
    }
    await deleteDoc(doc(db, 'vaccination_documents', documentId));
    localStorage.removeItem(`vaccination-document-${currentUid}`);
  } catch (error) {
    console.error('Failed to delete vaccination document:', error);
    notifyDialog('Could not delete the document: ' + error.message);
  }
}

function appointmentActionMarkup(booking) {
  const status = appointmentStatus(booking);
  if (status === 'expired') return `<div class="appt-card-actions"><button type="button" class="action-btn book-again-button" data-appointment-id="${escapeHtml(booking.id)}">Book Again</button></div>`;
  if (!['pending', 'confirmed'].includes(status) || booking.arrived_at) return '';
  return `<div class="appt-card-actions"><button type="button" class="action-btn reschedule-button" data-appointment-id="${escapeHtml(booking.id)}"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Reschedule</button><button type="button" class="action-btn danger cancel-appointment-button" data-appointment-id="${escapeHtml(booking.id)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i> Cancel</button></div>`;
}

function bindAppointmentActions(container, bookings) {
  if (!container) return;
  container.querySelectorAll('.reschedule-button').forEach(button => button.addEventListener('click', () => openRescheduleModal(bookings.find(booking => booking.id === button.dataset.appointmentId))));
  container.querySelectorAll('.cancel-appointment-button').forEach(button => button.addEventListener('click', () => openCancelModal(bookings.find(booking => booking.id === button.dataset.appointmentId))));
  container.querySelectorAll('.book-again-button').forEach(button => button.addEventListener('click', () => {
    const booking = bookings.find(item => item.id === button.dataset.appointmentId);
    if (booking && appointmentStatus(booking) === 'expired') openBookingModal(booking.clinic_name, booking.clinic_id);
  }));
}

function renderUpcomingAppointments(bookings) {
  const container = document.getElementById('upcomingAppointmentsList');
  if (!container) return;
  const today = manilaToday();
  const upcoming = bookings
    .filter(booking => ['pending', 'confirmed', 'in_progress'].includes(appointmentStatus(booking)) && (booking.preferred_date || '') >= today)
    .sort((first, second) => `${second.preferred_date || ''} ${second.preferred_time || ''}`.localeCompare(`${first.preferred_date || ''} ${first.preferred_time || ''}`))
    .slice(0, 3);
  if (!upcoming.length) {
    container.innerHTML = '<p style="font-size:13px;color:#6b7280;padding:10px 0;">No upcoming appointments.</p>';
    return;
  }
  container.innerHTML = upcoming.map(booking => {
    const date = new Date(`${booking.preferred_date}T00:00:00`);
    const day = Number.isNaN(date.getTime()) ? '--' : date.getDate();
    const month = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    const doseNumber = String(booking.dose_label || 'Dose 1').match(/\d+/)?.[0] || '1';
    const status = appointmentStatus(booking);
    const label = status === 'pending' ? (booking.reschedule_requested ? 'Reschedule awaiting confirmation' : 'Awaiting clinic confirmation') : status === 'confirmed' ? 'Confirmed' : 'Arrived';
    return `<div class="appt-mini"><div class="appt-date-box"><div class="day">${escapeHtml(String(day))}</div><div class="mon">${escapeHtml(month)}</div></div><div class="appt-info"><h4>${escapeHtml(booking.clinic_name || 'Clinic')}</h4><p><i class="fa-regular fa-clock"></i> ${escapeHtml(booking.preferred_time || 'Time not specified')} &nbsp;|&nbsp; Dose ${escapeHtml(doseNumber)} of 5</p><p class="appt-mini-status">${label}</p>${appointmentActionMarkup(booking)}</div><span class="dose-badge">D${escapeHtml(doseNumber)}</span></div>`;
  }).join('');
  bindAppointmentActions(container, bookings);
}

function renderLiveAppointments(bookings) {
  window.residentAppointments = bookings;
  const upcomingContainer = document.getElementById('liveUpcomingAppointments');
  const completedContainer = document.getElementById('liveCompletedAppointments');
  if (!upcomingContainer && !completedContainer) return;
  const sorted = [...bookings].sort((first, second) => `${second.preferred_date || ''} ${second.preferred_time || ''}`.localeCompare(`${first.preferred_date || ''} ${first.preferred_time || ''}`));
  const upcoming = sorted.filter(booking => ['pending', 'confirmed', 'in_progress'].includes(appointmentStatus(booking)) && (!booking.preferred_date || booking.preferred_date >= manilaToday()));
  const completed = sorted.filter(booking => ['completed', 'cancelled', 'declined', 'expired'].includes(appointmentStatus(booking)));
  updateNextAppointmentSummary(upcoming);
  const renderCard = (booking, isCompleted) => {
    const appointmentDate = isCompleted ? (booking.completed_at || booking.preferred_date) : booking.preferred_date;
    const date = toDate(appointmentDate) || new Date(`${booking.preferred_date}T00:00:00`);
    const day = Number.isNaN(date.getTime()) ? '--' : date.getDate();
    const monthYear = Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    const dose = String(booking.dose_label || 'Dose 1').match(/\d+/)?.[0] || '1';
    const vaccine = booking.vaccine_name || 'Vaccination';
    const detail = isCompleted ? `Administered on ${formatRecordDate(appointmentDate)}` : `${booking.preferred_time || 'Time not specified'} | ${booking.clinic_address || 'Clinic location not specified'}`;
    const status = appointmentStatus(booking);
    const past = ['cancelled', 'declined', 'expired'].includes(status);
    const label = status === 'pending' ? (booking.reschedule_requested ? 'Reschedule pending' : 'Pending confirmation') : status === 'in_progress' ? 'Arrived' : status.charAt(0).toUpperCase() + status.slice(1);
    const cancellation = status === 'cancelled' && booking.cancellation_reason ? `<p>Reason: ${escapeHtml(booking.cancellation_reason)}</p>` : '';
    return `<div class="appt-card ${past ? 'expired-appointment' : isCompleted ? 'completed' : 'upcoming'}"><div class="appt-card-date"><div class="big-day">${escapeHtml(String(day))}</div><div class="month-yr">${escapeHtml(monthYear)}</div></div><div class="appt-card-body"><div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;"><h3>Dose ${escapeHtml(dose)} ${escapeHtml(vaccine)} Vaccination</h3><span class="appt-status ${isCompleted ? 'status-done' : past ? 'status-expired' : 'status-upcoming'}">${label}</span></div><p><i class="fa-solid fa-hospital" style="color:#6b7280;"></i> ${escapeHtml(booking.clinic_name || 'Clinic not specified')}</p><p><i class="fa-regular fa-clock" style="color:#6b7280;"></i> ${escapeHtml(detail)}</p>${cancellation}${appointmentActionMarkup(booking)}</div></div>`;
  };
  if (upcomingContainer) upcomingContainer.innerHTML = upcoming.length ? upcoming.map(booking => renderCard(booking, false)).join('') : '<p style="font-size:13px;color:#6b7280;padding:10px 0;">No upcoming appointments.</p>';
  if (completedContainer) completedContainer.innerHTML = completed.length ? completed.map(booking => renderCard(booking, booking.status === 'completed')).join('') : '<p style="font-size:13px;color:#6b7280;padding:10px 0;">No past appointments yet.</p>';
  bindAppointmentActions(upcomingContainer, bookings);
  bindAppointmentActions(completedContainer, bookings);
}

function updateNextAppointmentSummary(bookings) {
  const element = document.getElementById('activeNextAppt');
  if (!element) return;
  const today = manilaToday();
  const next = [...bookings]
    .filter(booking => booking.preferred_date && booking.preferred_date >= today)
    .sort((first, second) => `${first.preferred_date} ${first.preferred_time || ''}`.localeCompare(`${second.preferred_date} ${second.preferred_time || ''}`))[0];
  element.textContent = next ? new Date(`${next.preferred_date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'No upcoming appointment';
}

function updateNearestClinicSummary(clinics = []) {
  const element = document.getElementById('nearestClinicDistance');
  if (!element) return;
  element.textContent = clinics.some(clinic => Number.isFinite(clinic.lat) && Number.isFinite(clinic.lng)) ? 'Tap to find nearest' : 'No clinic location';
}

function distanceInKm(origin, clinic) {
  const earthRadius = 6371;
  const latDelta = (clinic.lat - origin.lat) * Math.PI / 180;
  const lngDelta = (clinic.lng - origin.lng) * Math.PI / 180;
  const value = Math.sin(latDelta / 2) ** 2 + Math.cos(origin.lat * Math.PI / 180) * Math.cos(clinic.lat * Math.PI / 180) * Math.sin(lngDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function editableAppointment(appointment) {
  if (!appointment) return null;
  const current = residentAppointments.find(item => item.id === appointment.id) || appointment;
  const status = appointmentStatus(current);
  if (!['pending', 'confirmed'].includes(status) || current.arrived_at) {
    notifyDialog(status === 'expired'
      ? 'This appointment has expired. Please book a new appointment.'
      : 'This appointment can no longer be changed. Please review its latest status.');
    return null;
  }
  return current;
}

function nextRescheduleDate(date) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function openRescheduleModal(appointment) {
  activeRescheduleAppointment = editableAppointment(appointment);
  if (!activeRescheduleAppointment) return;
  const date = activeRescheduleAppointment.preferred_date || manilaToday();
  const nextDate = nextRescheduleDate(date);
  document.getElementById('rescheduleAppointmentId').value = activeRescheduleAppointment.id;
  const dateInput = document.getElementById('rescheduleDate');
  dateInput.value = date;
  dateInput.min = date;
  dateInput.max = nextDate;
  refreshRescheduleSlots();
  const timeSelect = document.getElementById('rescheduleTime');
  if ([...timeSelect.options].some(option => option.value === activeRescheduleAppointment.preferred_time)) timeSelect.value = activeRescheduleAppointment.preferred_time;
  document.getElementById('rescheduleMsg').style.display = 'none';
  document.getElementById('rescheduleModal').classList.add('open');
  dateInput.focus({ preventScroll: true });
  dateInput.showPicker?.();
}

async function saveReschedule() {
  const button = document.getElementById('saveRescheduleBtn');
  if (button.disabled) return;
  const appointmentId = document.getElementById('rescheduleAppointmentId').value;
  const date = document.getElementById('rescheduleDate').value;
  const time = document.getElementById('rescheduleTime').value;
  const message = document.getElementById('rescheduleMsg');
  if (!appointmentId || !date || !time) {
    message.textContent = 'Choose an appointment date and time.';
    message.style.display = 'block';
    message.style.color = '#b91c1c';
    return;
  }
  const appointment = residentAppointments.find(item => item.id === appointmentId)
    || (activeRescheduleAppointment?.id === appointmentId ? activeRescheduleAppointment : null);
  const originalDate = appointment?.preferred_date;
  const allowedNextDate = originalDate ? nextRescheduleDate(originalDate) : date;
  if (originalDate && (date < originalDate || date > allowedNextDate)) {
    message.textContent = `You may reschedule only from ${originalDate} to ${allowedNextDate}.`;
    message.style.display = 'block';
    message.style.color = '#b91c1c';
    return;
  }
  if (date === originalDate && clockMinutes(time) === clockMinutes(appointment?.preferred_time)) {
    message.textContent = 'Choose a different appointment date or time.';
    message.style.display = 'block';
    message.style.color = '#b91c1c';
    return;
  }
  button.disabled = true;
  button.textContent = 'Sending request...';
  message.style.display = 'none';
  try {
    await rescheduleBooking({ appointment_id: appointmentId, preferred_date: date, preferred_time: time });
    activeRescheduleAppointment = null;
    document.getElementById('rescheduleModal').classList.remove('open');
    notifyDialog('Reschedule request sent. Clinic staff have been notified and must confirm your new date and time.');
  } catch (error) {
    message.textContent = 'Could not reschedule: ' + error.message;
    message.style.display = 'block';
    message.style.color = '#b91c1c';
  } finally {
    button.disabled = false;
    button.textContent = 'Request Reschedule';
  }
}

function openCancelModal(appointment) {
  const current = editableAppointment(appointment);
  if (!current) return;
  document.getElementById('cancelAppointmentId').value = current.id;
  document.getElementById('cancelReason').value = '';
  document.getElementById('cancelMsg').style.display = 'none';
  document.getElementById('cancelModal').classList.add('open');
  document.getElementById('cancelReason').focus({ preventScroll: true });
}

window.openRescheduleModal = openRescheduleModal;
window.openCancelModal = openCancelModal;

async function saveCancellation() {
  const button = document.getElementById('saveCancelBtn');
  if (button.disabled) return;
  const appointmentId = document.getElementById('cancelAppointmentId').value;
  const reason = document.getElementById('cancelReason').value.trim();
  const message = document.getElementById('cancelMsg');
  if (!appointmentId || !reason) {
    message.textContent = 'Please provide a reason for cancelling this appointment.';
    message.style.display = 'block';
    message.style.color = '#b91c1c';
    return;
  }
  button.disabled = true;
  button.textContent = 'Cancelling...';
  message.style.display = 'none';
  try {
    await cancelBooking({appointment_id:appointmentId,reason});
    document.getElementById('cancelModal').classList.remove('open');
    notifyDialog('Appointment cancelled successfully. Clinic staff have been notified.');
  } catch (error) {
    message.textContent = 'Could not cancel appointment: ' + error.message;
    message.style.display = 'block';
    message.style.color = '#b91c1c';
  } finally {
    button.disabled = false;
    button.textContent = 'Confirm Cancellation';
  }
}

function escapeHtml(value = '') {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}

function renderAnimalExposure(data = {}) {
  const chart = document.getElementById('animalExposureChart');
  if (!chart) return;
  const colors = ['#e60000', '#d98a00', '#00b140', '#6b7280'];
  const animals = normalizeAnimalExposure(Array.isArray(data.animals) && data.animals.length ? data.animals : []);
  if (!animals.length) {
    chart.innerHTML = '<p class="analytics-empty-state">No exposure records have been collected yet.</p>';
    return;
  }
  let offset = 0;
  const stops = animals.map((animal, index) => {
    const start = offset;
    offset += Number(animal.percent) || 0;
    return `${colors[index % colors.length]} ${start}% ${offset}%`;
  }).join(', ');
  chart.innerHTML = `<div class="animal-donut" style="background:conic-gradient(${stops});"><div><strong>${escapeHtml(animals[0].percent)}%</strong><small>${escapeHtml(animals[0].name)}</small></div></div><div class="donut-legend">${animals.map((animal, index) => `<div class="donut-legend-item"><span class="donut-dot" style="background:${colors[index % colors.length]};"></span> ${escapeHtml(animal.name)} - ${escapeHtml(animal.percent)}%</div>`).join('')}</div>`;
}

function normalizeAnimalExposure(animals) {
  const counts = new Map();
  animals.forEach(animal => {
    const rawName = String(animal.name || 'Others').trim().toLowerCase();
    const name = rawName === 'dog' ? 'Dog'
      : rawName === 'cat' ? 'Cat'
        : rawName === 'bat' ? 'Bat'
          : rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : 'Others';
    counts.set(name, (counts.get(name) || 0) + Number(animal.percent || 0));
  });
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1])
    .map(([name, value]) => ({ name, percent: total ? Math.round(value / total * 100) : 0 }));
}

function listenToAnimalExposure() {
  onSnapshot(doc(db, 'system_settings', 'animal_exposure'), snapshot => {
    renderAnimalExposure(snapshot.exists() ? snapshot.data() : {});
  }, error => console.error('Failed to load live animal exposure data:', error));
}

function listenToDashboardAnalytics() {
  onSnapshot(doc(db, 'system_settings', 'live_analytics'), snapshot => {
    const data = snapshot.exists() ? snapshot.data() : {};
    livePublicCaseRecords = Array.isArray(data.publicRecords) ? data.publicRecords : [];
    renderLiveRecordHeader(residentVaccinationRecords, residentAppointments);
    renderLiveCaptions(data);
    updateMonthlyChart(data);
    const maxCases = Math.max(1, ...(Array.isArray(data.barangays) ? data.barangays : []).map(item => Number(item.cases) || 0));
    renderAnalyticsList('barangayIncidentRate', data.barangays, item => {
      const ratio = Math.min(100, Math.round((Number(item.cases) || 0) / maxCases * 100));
      const fillClass = ratio >= 66 ? 'fill-high' : ratio >= 33 ? 'fill-medium' : 'fill-low';
      return `<div class="bgy-row"><div class="bgy-row-top"><span class="bgy-name">${escapeHtml(item.name)}</span><span class="bgy-count">${escapeHtml(item.cases)} cases</span></div><div class="bgy-bar-wrap"><div class="bgy-bar-fill ${fillClass}" style="width:${ratio}%;"></div></div></div>`;
    });
    const maxTrend = Math.max(1, ...(Array.isArray(data.monthlyCases) ? data.monthlyCases : []).map(value => Number(value) || 0));
    renderAnalyticsList('caseTrendChart', data.monthlyCases, (value, index) => `<div class="trend-bar" style="height:${Math.round((Number(value) || 0) / maxTrend * 100)}%;background:${Number(value) === maxTrend ? '#e60000' : '#d98a00'};" title="${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][index]}: ${escapeHtml(value)}"></div>`);
    const maxAge = Math.max(1, ...(Array.isArray(data.ageGroups) ? data.ageGroups : []).map(value => Number(value) || 0));
    renderAnalyticsList('ageGroupChart', data.ageGroups, (value, index) => `<div class="age-row"><span class="age-label">${['0-9','10-19','20-39','40-59','60+'][index]}</span><div class="age-bar-wrap"><div class="age-bar-fill" style="width:${Math.round((Number(value) || 0) / maxAge * 100)}%;"></div></div><span class="age-count">${escapeHtml(value)}</span></div>`);
  }, error => console.error('Failed to load dashboard analytics:', error));
}

function renderAnalyticsList(id, values, renderItem) {
  const element = document.getElementById(id);
  if (!element) return;
  element.innerHTML = Array.isArray(values) && values.length
    ? values.map(renderItem).join('')
    : '<p class="analytics-empty-state">No live records have been collected yet.</p>';
}

function initView(hasRecord, latestRecord) {
  const setDisplay = (id, display) => {
    const element = document.getElementById(id);
    if (element) element.style.display = display;
  };
  if (hasRecord) {
    setDisplay('view-new', 'none');
    setDisplay('view-active', 'block');
    setDisplay('nav-records', 'flex');
    setDisplay('appt-new-resident', 'none');
    setDisplay('appt-active-patient', 'block');
    setDisplay('notifDot', 'block');
    setDisplay('notifBadge', 'inline');
    if (latestRecord) populateActivePatientData(latestRecord);
  } else {
    setDisplay('view-new', 'block');
    setDisplay('view-active', 'none');
    setDisplay('nav-records', 'none');
    setDisplay('appt-new-resident', 'block');
    setDisplay('appt-active-patient', 'none');
    setTimeout(renderCasesChart, 150);
  }
}

function populateActivePatientData(data) {
  const doses = data.dose_number || 1;
  const total = 5;
  const pct = Math.round((doses / total) * 100);
  if (document.getElementById('activeDosesCount')) document.getElementById('activeDosesCount').textContent = doses;
  if (document.getElementById('progressLabel')) document.getElementById('progressLabel').textContent = `Treatment Progress - ${doses} of ${total} doses`;
  if (document.getElementById('progressBar')) document.getElementById('progressBar').style.width = pct + '%';
  if (document.getElementById('progressPct')) document.getElementById('progressPct').textContent = pct + '% Complete';
  if (document.getElementById('recordPct')) document.getElementById('recordPct').textContent = pct + '%';
  if (document.getElementById('recordDoses')) document.getElementById('recordDoses').textContent = `${doses} / ${total} doses`;
  for (let i = 1; i <= 5; i++) {
    const pip = document.getElementById('pip' + i);
    if (!pip) continue;
    if (i <= doses) pip.className = 'dose-pip done';
    else if (i === doses + 1) pip.className = 'dose-pip current';
    else pip.className = 'dose-pip';
  }
  if (data.resident_name && document.getElementById('recordName')) document.getElementById('recordName').textContent = data.resident_name;
  if (data.vaccine_name && document.getElementById('recordVaccine')) document.getElementById('recordVaccine').textContent = data.vaccine_name;
  if (data.next_due_date) {
    const nextDate = data.next_due_date.toDate ? data.next_due_date.toDate().toLocaleDateString() : data.next_due_date;
    if (document.getElementById('activeNextAppt')) document.getElementById('activeNextAppt').textContent = nextDate;
    if (document.getElementById('nextDoseLabel')) document.getElementById('nextDoseLabel').innerHTML = `<i class="fa-regular fa-calendar"></i> Next: Dose ${doses + 1} on ${nextDate}`;
  }
}

function renderCasesChart() {
  window.residentMonthlyChart = initializeMonthlyChart();
}

function renderResVizChart() {
  const ctx = document.getElementById('resVizChart');
  if (!ctx || !window.Chart) return;
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul'],
      datasets: [
        { label:'Rabies Cases', data:[12,18,15,22,19,24,17], backgroundColor:'rgba(239,0,0,0.75)', borderRadius:4 },
        { label:'Vaccinations', data:[45,62,55,80,72,95,53], backgroundColor:'rgba(52,211,153,0.75)', borderRadius:4 }
      ]
    },
    options: {
      responsive:true,
      plugins:{ legend:{ position:'top', labels:{ font:{size:11}, padding:10 } } },
      scales:{
        y:{ beginAtZero:true, grid:{color:'#f3f4f6'}, ticks:{font:{size:11}} },
        x:{ grid:{display:false}, ticks:{font:{size:11}} }
      }
    }
  });
}

window.renderResidentCasesChart = renderCasesChart;

// Other inline-handler functions are exposed in DOMContentLoaded so HTML can use module scripts.

// Reads the dose level out of a "Dose N (Day D)" label, falling back to a plain
// digit match. Residents choose the dose they are catching up on, so this is
// always read from the <select> rather than derived from their dose history.
function doseLevelFromLabel(label, fallback = 1) {
  const match = String(label ?? '').match(/dose\s*(\d+)/i) || String(label ?? '').match(/(\d+)/);
  const level = Number(match?.[1] || 0);
  return level >= 1 && level <= doseDayOffsets.length ? level : fallback;
}

// The earliest a resident may book a given dose. Doses 2-5 are anchored to the
// start of their course; with no first dose on record yet there is nothing to
// anchor to, so any date from today is allowed. Doses are preferred in order
// but never blocked: a resident catching up must be able to book a later dose
// even if an earlier one was never recorded by a clinic.
function earliestBookingDate(doseLevel) {
  if (doseLevel === 1 && [1,2,3,4,5].every(n => residentVaccinationRecords.some(r => Number(r.dose_number) === n && r.date_given))) return manilaToday();
  const reviewed = patientTreatments.find(t => t.vaccination_session_id === (currentVaccinationSessionId || 'legacy'))?.doses?.find(d => d.dose_number === doseLevel)?.recommended_date;
  if (reviewed) return [manilaToday(), reviewed].sort().pop();
  if (!firstDoseDate || doseLevel <= 1 || doseLevel > doseDayOffsets.length) {
    return manilaToday();
  }
  return [manilaToday(), formatInputDate(firstDoseDate, doseDayOffsets[doseLevel - 1])].sort().pop();
}

// --- Appointment time slots -------------------------------------------------
const slotCapacityCache = new Map();
const getSlotAvailability = httpsCallable(getFunctions(app), 'getSlotAvailability');
function requestSlotCapacity(clinicId, date) {
  if (!clinicId || !date) return null;
  const key = clinicId + ':' + date;
  let entry = slotCapacityCache.get(key);
  if (!entry || (!entry.loading && Date.now() - entry.updated > 15000)) {
    entry = { ...entry, loading: true, updated: Date.now() }; slotCapacityCache.set(key, entry);
    getSlotAvailability({ clinic_id: clinicId, date }).then(({data}) => {
      slotCapacityCache.set(key, { data, updated: Date.now(), loading: false });
      refreshTimeSlots(); refreshRescheduleSlots(); refreshBatchTimeSlots();
    }).catch(error => {
      console.error('Could not check appointment slot availability:', error);
      slotCapacityCache.set(key, { error: true, updated: Date.now(), loading: false });
      refreshTimeSlots(); refreshRescheduleSlots(); refreshBatchTimeSlots();
    });
  }
  return entry;
}
function updateTimeSelect(selectId, dateId, clinic, hintId) {
  const select = document.getElementById(selectId);
  const date = document.getElementById(dateId)?.value;
  if (!select) return;
  const previous = select.value;
  const result = availableSlots(clinic, date);
  const capacity = requestSlotCapacity(clinic?.id, date);
  const signature = [clinic?.id, date, result.known, result.hours, JSON.stringify(capacity?.data), capacity?.error, ...result.slots].join('|');
  if (select.dataset.scheduleSignature === signature) return;
  select.dataset.scheduleSignature = signature;
  select.replaceChildren();
  for (const time of result.slots) {
    const option = document.createElement('option');
    option.value = time;
    const count = capacity?.data?.counts[dateStart(date) + clockMinutes(time) * 60000] || 0;
    option.disabled = !capacity?.data || count >= 5;
    option.textContent = time + (capacity?.data ? count >= 5 ? ' - Full' : ' - ' + (5-count) + ' slots left' : ' - Checking availability');
    select.appendChild(option);
  }
  if (!result.slots.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = !result.known ? 'Operating hours unavailable' : !result.minutes.length ? 'Clinic closed' : 'No future slots available';
    select.appendChild(option);
  } else if (result.slots.includes(previous)) select.value = previous;
  if (select.selectedOptions[0]?.disabled) select.value = [...select.options].find(option => !option.disabled)?.value || '';
  select.disabled = !result.slots.length || !capacity?.data || ![...select.options].some(option => !option.disabled);
  const hint = document.getElementById(hintId);
  if (hint) hint.textContent = !result.known ? 'Contact the clinic to confirm its operating hours.'
    : !result.slots.length ? 'No available times for this date. Please choose another date.'
    : capacity?.error ? 'Could not check slot availability. Please try again shortly.'
    : !capacity?.data ? 'Checking available booking slots...'
    : select.disabled ? 'All slots are full. Please choose another date.'
    : 'Maximum 5 bookings per 30-minute slot (Philippine time).';
}
function refreshTimeSlots() {
  const current = window.clinicDirectory?.find(item => item.id === selectedClinic?.id);
  if (current) selectedClinic = current;
  updateTimeSelect('modalTime', 'modalDate', selectedClinic, 'modalTimeHint');
}
function refreshRescheduleSlots() {
  const id = document.getElementById('rescheduleAppointmentId')?.value;
  const appointment = residentAppointments.find(item => item.id === id)
    || (activeRescheduleAppointment?.id === id ? activeRescheduleAppointment : null);
  const clinic = window.clinicDirectory?.find(item => item.id === appointment?.clinic_id);
  updateTimeSelect('rescheduleTime', 'rescheduleDate', clinic, 'rescheduleTimeHint');
}
function updateBatchTimeSelect(dateInput, select, clinic) {
  const date = dateInput.value;
  const previous = select.value || select.dataset.preferredTime;
  const result = availableSlots(clinic, date);
  const capacity = requestSlotCapacity(clinic?.id, date);
  const signature = [clinic?.id, date, result.known, result.hours, JSON.stringify(capacity?.data), capacity?.error, ...result.slots].join('|');
  if (select.dataset.scheduleSignature === signature) return;
  select.dataset.scheduleSignature = signature;
  const doseNumber = Number(select.dataset.doseTime);
  const existing = residentAppointments.find(item =>
    Number(item.dose_number || String(item.dose_label || '').match(/\d+/)?.[0] || 0) === doseNumber
    && (item.vaccination_session_id || 'legacy') === (currentVaccinationSessionId || 'legacy')
    && ['pending', 'confirmed', 'accepted', 'approved'].includes(item.status)
  );
  select.replaceChildren();
  for (const time of result.slots) {
    const option = document.createElement('option');
    option.value = time;
    const slotKey = dateStart(date) + clockMinutes(time) * 60000;
    const count = Math.max(0, (capacity?.data?.counts[slotKey] || 0)
      - (existing?.clinic_id === clinic?.id && existing.preferred_date === date
        && dateStart(existing.preferred_date) + clockMinutes(existing.preferred_time) * 60000 === slotKey ? 1 : 0));
    option.disabled = !capacity?.data || count >= 5;
    option.textContent = time + (capacity?.data ? count >= 5 ? ' - Full' : ' - ' + (5 - count) + ' slots left' : ' - Checking availability');
    select.appendChild(option);
  }
  if (!result.slots.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = !result.known ? 'Operating hours unavailable' : !result.minutes.length ? 'Clinic closed' : 'No future slots available';
    select.appendChild(option);
  } else if (result.slots.includes(previous)) {
    select.value = previous;
  }
  delete select.dataset.preferredTime;
  if (select.selectedOptions[0]?.disabled) select.value = [...select.options].find(option => !option.disabled)?.value || '';
  select.disabled = !result.slots.length || !capacity?.data || ![...select.options].some(option => !option.disabled);
}
function refreshBatchTimeSlots() {
  const modal = document.getElementById('batchBookingModal');
  if (!modal?.classList.contains('open')) return;
  const clinic = window.clinicDirectory?.find(item => item.id === document.getElementById('batchBookingClinic')?.value);
  modal.querySelectorAll('[data-dose-date]').forEach(dateInput => {
    const doseNumber = dateInput.dataset.doseDate;
    const timeSelect = modal.querySelector(`[data-dose-time="${doseNumber}"]`);
    if (timeSelect) updateBatchTimeSelect(dateInput, timeSelect, clinic);
  });
}
function timeSlotError(date, time, clinic) {
  return bookingTimeError(clinic, date, time);
}
// Refresh while a dialog is open so a time cannot remain selectable after it passes.
setInterval(() => {
  if (document.getElementById('bookingModal')?.classList.contains('open')) refreshTimeSlots();
  if (document.getElementById('rescheduleModal')?.classList.contains('open')) refreshRescheduleSlots();
}, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (document.getElementById('bookingModal')?.classList.contains('open')) refreshTimeSlots();
    if (document.getElementById('rescheduleModal')?.classList.contains('open')) refreshRescheduleSlots();
    if (document.getElementById('batchBookingModal')?.classList.contains('open')) refreshBatchTimeSlots();
  }
});

function openBookingModal(clinic, clinicId = '') {
  const select = document.getElementById('modalClinic');
  const directory = window.clinicDirectory || [];
  const historyClinicId = getPrimaryClinicId();
  const explicitClinic = directory.find(item => item.id === clinicId) || directory.find(item => item.name === clinic);
  selectedClinic = explicitClinic || directory.find(item => item.id === historyClinicId);
  if (!selectedClinic && historyClinicId && !clinic && !clinicId) {
    notifyDialog('Your previous clinic is currently unavailable in the directory. Contact your clinic to arrange your next dose.');
    return;
  }
  selectedClinic ||= directory.find(item => item.id === select.value);
  if (!selectedClinic) { notifyDialog('Choose a clinic from the map or directory first.'); return; }
  select.value = selectedClinic.id;
  document.getElementById('bookingClinicName').textContent = selectedClinic.name;
  const nextDose = [1,2,3,4,5].find(n => !residentVaccinationRecords.some(r => Number(r.dose_number) === n && r.date_given));
  const bookingDose = nextDose || 1;
  selectedDose = 'Dose ' + bookingDose + ' (Day ' + doseDayOffsets[bookingDose - 1] + ')';

  const date = document.getElementById('modalDate');
  date.min = nextDose ? earliestBookingDate(nextDose) : manilaToday();
  date.value = date.min;
  document.getElementById('bookingMsg').style.display = 'none';
  document.getElementById('confirmBookingBtn').disabled = false;
  refreshTimeSlots();
  document.getElementById('bookingModal').classList.add('open');
}
function closeBookingModal() {
  document.getElementById('bookingModal').classList.remove('open');
}
function bookingPrimaryAction() { return confirmBooking(); }

function withBookingTimeout(promise, operation, timeoutMs = 30000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${operation} timed out. Check your booking records before retrying.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function confirmBooking() {
  const button = document.getElementById('confirmBookingBtn');
  const message = document.getElementById('bookingMsg');
  if (button.disabled) return;
  const date = document.getElementById('modalDate').value;
  const time = document.getElementById('modalTime').value;
  message.style.display = 'block';
  message.style.color = '#b91c1c';
  if (!currentUid || !selectedClinic || !date || !time) { message.textContent = 'Choose a preferred date and time.'; return; }
  if ((window.clinicDirectory || []).find(clinic => clinic.id === selectedClinic.id)?.status !== 'available') { message.textContent = 'This clinic has low or out-of-stock inventory. Choose another clinic.'; return; }
  const latestClinic = window.clinicDirectory?.find(item => item.id === selectedClinic.id) || selectedClinic;
  const error = timeSlotError(date, time, latestClinic);
  if (error || date < earliestBookingDate(doseLevelFromLabel(selectedDose))) {
    message.textContent = error || 'Choose a date on or after the earliest available date.'; return;
  }
  button.disabled = true;
  button.textContent = 'Booking...';
  message.textContent = '';
  try {
    const clinicId = selectedClinic.id;
    if (!await confirmClinicWithHistory(selectedClinic)) {
      button.disabled = false;
      return;
    }
    if (selectedClinic?.id !== clinicId || !currentUid) {
      button.disabled = false;
      return;
    }
    const result = await withBookingTimeout(createBooking({
      clinic_id: selectedClinic.id, preferred_date: date, preferred_time: time,
      dose_label: selectedDose, vaccine_name: latestVaccineBrand || '',
      vaccination_session_id: currentVaccinationSessionId || 'legacy',
      primary_clinic_id: getPrimaryClinicId() || selectedClinic.id
    }), 'Saving your appointment');
    if (result?.data?.vaccination_session_id) {
      currentVaccinationSessionId = result.data.vaccination_session_id;
      residentVaccinationRecords = allResidentVaccinationRecords.filter(record =>
        (record.vaccination_session_id || 'legacy') === currentVaccinationSessionId);
      firstDoseDate = toDate(residentVaccinationRecords.find(record => Number(record.dose_number) === 1)?.date_given);
      latestVaccineBrand = residentVaccinationRecords[0]?.vaccine_name || residentVaccinationRecords[0]?.vaccine_type || '';
      renderLiveRecordHeader(residentVaccinationRecords, residentAppointments);
      updateVaccinationProgress(residentVaccinationRecords);
      renderLiveDoseRecords(residentVaccinationRecords, residentAppointments);
      renderPreviousVaccinationRecords(allResidentVaccinationRecords);
    }
    message.style.color = '#15803d';
    message.textContent = 'Appointment sent to the clinic for review.';
    setTimeout(closeBookingModal, 1500);
  } catch (error) {
    message.textContent = error.message || 'Could not book the appointment. Please try again.';
    button.disabled = false;
  } finally { button.textContent = 'Book Appointment'; }
}

function openBatchBookingModal(preferredClinicId = '') {
  const modal = document.getElementById('batchBookingModal');
  const clinicSelect = document.getElementById('batchBookingClinic');
  const grid = document.getElementById('batchBookingDoseGrid');
  const message = document.getElementById('batchBookingMsg');
  const treatment = patientTreatments.find(item => item.vaccination_session_id === (currentVaccinationSessionId || 'legacy'));
  const recordsByDose = new Map(residentVaccinationRecords.map(record => [Number(record.dose_number), record]));
  const bookingsByDose = new Map(residentAppointments
    .filter(item => (item.vaccination_session_id || 'legacy') === (currentVaccinationSessionId || 'legacy')
      && ['pending', 'confirmed', 'accepted', 'approved', 'in_progress'].includes(item.status))
    .map(item => [Number(item.dose_number || String(item.dose_label || '').match(/\d+/)?.[0] || 0), item]));
  const toBook = [1, 2, 3, 4, 5].filter(doseNumber =>
    !recordsByDose.has(doseNumber) && bookingsByDose.get(doseNumber)?.status !== 'in_progress'
  );
  if (!treatment || !toBook.length || toBook.some(doseNumber =>
    !treatment.doses?.find(dose => dose.dose_number === doseNumber)?.recommended_date
  )) {
    notifyDialog('The complete clinic-recommended schedule is not available yet. Please contact your clinic.');
    return;
  }

  const clinics = (window.clinicDirectory || []).filter(clinic => clinic.id && clinic.status === 'available');
  if (!clinics.length) {
    notifyDialog('No clinic is currently available for booking.');
    return;
  }
  clinicSelect.innerHTML = clinics.map(clinic =>
    `<option value="${escapeHtml(clinic.id)}">${escapeHtml(clinic.name || 'Clinic')}</option>`
  ).join('');
  const existingClinicId = toBook.map(doseNumber => bookingsByDose.get(doseNumber)?.clinic_id).find(Boolean);
  const chosenClinic = clinics.find(clinic => clinic.id === preferredClinicId)
    || clinics.find(clinic => clinic.id === existingClinicId)
    || clinics.find(clinic => clinic.id === getPrimaryClinicId())
    || clinics[0];
  clinicSelect.value = chosenClinic.id;
  grid.innerHTML = toBook.map(doseNumber => {
    const dose = treatment.doses.find(item => item.dose_number === doseNumber);
    const existing = bookingsByDose.get(doseNumber);
    const minimum = earliestBookingDate(doseNumber);
    const date = existing?.preferred_date >= minimum ? existing.preferred_date : minimum;
    return `<div class="batch-booking-dose"><strong>Dose ${doseNumber} — Clinic recommended: ${escapeHtml(formatRecordDate(dose.recommended_date))}</strong><label for="batchDoseDate${doseNumber}">Appointment date</label><input id="batchDoseDate${doseNumber}" type="date" min="${escapeHtml(minimum)}" value="${escapeHtml(date)}" data-dose-date="${doseNumber}" required><label for="batchDoseTime${doseNumber}">Appointment time</label><select id="batchDoseTime${doseNumber}" data-dose-time="${doseNumber}" data-preferred-time="${escapeHtml(existing?.preferred_time || '')}" required><option value="">Checking times...</option></select></div>`;
  }).join('');
  message.style.display = 'none';
  modal.classList.add('open');
  refreshBatchTimeSlots();
}

function closeBatchBookingModal() {
  document.getElementById('batchBookingModal')?.classList.remove('open');
}

async function confirmBatchBooking() {
  const button = document.getElementById('batchBookingConfirmBtn');
  const message = document.getElementById('batchBookingMsg');
  const clinic = window.clinicDirectory?.find(item => item.id === document.getElementById('batchBookingClinic')?.value);
  const rows = [...document.querySelectorAll('#batchBookingDoseGrid [data-dose-date]')];
  message.style.display = 'block';
  message.style.color = '#b91c1c';
  if (!currentUid || !clinic || clinic.status !== 'available' || !rows.length) {
    message.textContent = 'Choose an available clinic and the recommended dose dates.';
    return;
  }

  let previousDate = '';
  const selectedSlots = new Set();
  const appointments = [];
  for (const dateInput of rows) {
    const doseNumber = Number(dateInput.dataset.doseDate);
    const timeSelect = document.querySelector(`#batchBookingDoseGrid [data-dose-time="${doseNumber}"]`);
    const date = dateInput.value;
    const time = timeSelect?.value || '';
    const minimum = earliestBookingDate(doseNumber);
    const error = timeSlotError(date, time, clinic);
    if (!date || !time || timeSelect.disabled || date < minimum || date < previousDate || error) {
      message.textContent = error || `Choose a future appointment date and available time for Dose ${doseNumber}, in dose order.`;
      return;
    }
    const slot = dateStart(date) + clockMinutes(time) * 60000;
    if (selectedSlots.has(slot)) {
      message.textContent = 'Choose a different appointment time for each dose.';
      return;
    }
    selectedSlots.add(slot);
    previousDate = date;
    appointments.push({ dose_number: doseNumber, preferred_date: date, preferred_time: time });
  }

  button.disabled = true;
  button.textContent = 'Booking all dates...';
  try {
    if (!await confirmClinicWithHistory(clinic)) return;
    const result = await withBookingTimeout(createBatchBooking({
      clinic_id: clinic.id,
      vaccination_session_id: currentVaccinationSessionId || 'legacy',
      appointments
    }), 'Booking your vaccination schedule');
    message.style.color = '#15803d';
    message.textContent = `${result.data.appointments.length} dose appointments were sent to ${clinic.name || 'the clinic'} for review.`;
    setTimeout(closeBatchBookingModal, 1800);
  } catch (error) {
    console.error('Could not book the recommended vaccination schedule:', error);
    message.textContent = error.message || 'Could not confirm the result. Refresh your booking records before retrying.';
  } finally {
    button.disabled = false;
    button.textContent = 'Book All Dates';
  }
}

function filterMap(btn) {
  document.querySelectorAll('.map-filter button').forEach(b => b.classList.remove('active-btn'));
  btn.classList.add('active-btn');
}

function uploadVaccinationFile(storageRef, file, contentType, onProgress) {
  const task = uploadBytesResumable(storageRef, file, { contentType });
  return new Promise((resolve, reject) => {
    let timeoutId;
    let transferred = 0;
    let unsubscribe;
    let settled = false;
    const finish = (error, snapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      unsubscribe?.();
      if (error) reject(error);
      else resolve(snapshot);
    };
    const resetTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        const error = new Error('The upload stopped responding. Check your internet connection and try again.');
        error.code = 'storage/upload-timeout';
        finish(error);
        task.cancel();
      }, 45000);
    };
    resetTimeout();
    unsubscribe = task.on('state_changed', snapshot => {
      if (settled) return;
      if (snapshot.bytesTransferred > transferred) {
        transferred = snapshot.bytesTransferred;
        resetTimeout();
      }
      onProgress(Math.round(snapshot.bytesTransferred / (snapshot.totalBytes || 1) * 100));
    }, error => finish(error), () => finish(null, task.snapshot));
  });
}

function getVaccinationDocumentUrl(storageRef) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error('The upload service is not responding. Please try again.');
      error.code = 'storage/upload-timeout';
      reject(error);
    }, 30000);
  });
  return Promise.race([getDownloadURL(storageRef), timeout]).finally(() => clearTimeout(timeoutId));
}

function vaccinationUploadErrorMessage(error) {
  switch (error.code) {
    case 'storage/unauthenticated':
      return 'Your session has expired. Please sign in again and upload the document.';
    case 'storage/unauthorized':
    case 'permission-denied':
      return 'Your account does not have permission to upload this document. Please sign in again. If it still fails, contact the clinic.';
    case 'storage/retry-limit-exceeded':
    case 'storage/upload-timeout':
      return 'The upload stopped responding. Check your internet connection and try again. If it still fails, contact the clinic.';
    case 'storage/bucket-not-found':
    case 'storage/project-not-found':
    case 'storage/quota-exceeded':
      return 'The document upload service is currently unavailable. Please contact the clinic.';
    default:
      return 'Could not upload the document. Please try again.';
  }
}

async function handleUpload(input) {
  if (vaccinationUploadInProgress) return;
  const file = input.files[0];
  if (!file || !currentUid) return;
  if (file.size > 10 * 1024 * 1024) {
    notifyDialog('Please choose a file smaller than 10 MB.');
    input.value = '';
    return;
  }
  const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
  const extensionTypes = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  const contentType = file.type || extensionTypes[file.name.split('.').pop().toLowerCase()];
  if (!allowedTypes.includes(contentType)) {
    notifyDialog('Please upload a PDF, JPG, or PNG file.');
    input.value = '';
    return;
  }
  const controls = document.getElementById('uploadDocumentControls');
  const uploadBox = controls?.querySelector('.upload-box');
  const uploadText = uploadBox?.querySelector('p');
  const chooseButton = controls?.querySelector('.upload-btn');
  const status = document.getElementById('vaccinationUploadStatus');
  const uid = currentUid;
  const sessionId = currentVaccinationSessionId || 'legacy';
  const replaceId = input.dataset.replaceId || '';
  let saveNoticeId;
  const showStatus = (message, isError = false) => {
    if (status) {
      status.hidden = false;
      status.textContent = message;
      status.classList.toggle('document-error', isError);
    }
    if (uploadText) uploadText.textContent = message;
  };
  vaccinationUploadInProgress = true;
  input.disabled = true;
  if (chooseButton) chooseButton.disabled = true;
  controls?.setAttribute('aria-busy', 'true');
  uploadBox?.setAttribute('aria-disabled', 'true');
  showStatus('Uploading document... 0%');
  try {
    if (!navigator.onLine) throw Object.assign(new Error('You are offline.'), { code: 'storage/upload-timeout' });
    storage.maxUploadRetryTime = 120000;
    storage.maxOperationRetryTime = 30000;
    const safeFileName = file.name.replace(/[\\/]/g, '_');
    const storageRef = ref(storage, `vaccination-documents/${uid}/${Date.now()}-${safeFileName}`);
    await uploadVaccinationFile(storageRef, file, contentType, percent => showStatus(`Uploading document... ${percent}%`));
    showStatus('Upload complete. Preparing document...');
    const downloadUrl = await getVaccinationDocumentUrl(storageRef);
    const documentData = {
      resident_uid: uid,
      vaccination_session_id: sessionId,
      file_name: file.name,
      file_type: contentType,
      file_size: file.size,
      storage_path: storageRef.fullPath,
      download_url: downloadUrl,
      uploaded_at: serverTimestamp()
    };
    showStatus('Upload complete. Saving document...');
    // Firestore queues writes while offline. Keep this upload locked until the
    // server acknowledges it so retrying cannot create duplicate documents.
    saveNoticeId = setTimeout(() => showStatus('Photo uploaded. Waiting for a connection to save the document. Keep this page open.'), 30000);
    if (replaceId) {
      await updateDoc(doc(db, 'vaccination_documents', replaceId), documentData);
    } else {
      await addDoc(collection(db, 'vaccination_documents'), documentData);
    }
    clearTimeout(saveNoticeId);
    showStatus(replaceId ? 'Vaccination document replaced successfully.' : 'Vaccination document uploaded successfully.');
    if (currentUid === uid) loadVaccinationDocuments(uid);
    notifyDialog(replaceId ? 'Vaccination document replaced successfully.' : 'Vaccination document uploaded successfully.');
  } catch (error) {
    console.error('Failed to upload vaccination document:', error);
    const message = vaccinationUploadErrorMessage(error);
    showStatus(message, true);
    notifyDialog(message);
  } finally {
    clearTimeout(saveNoticeId);
    vaccinationUploadInProgress = false;
    input.disabled = false;
    if (chooseButton) chooseButton.disabled = false;
    controls?.setAttribute('aria-busy', 'false');
    uploadBox?.removeAttribute('aria-disabled');
    if (uploadText) uploadText.textContent = 'Click to upload';
    delete input.dataset.replaceId;
    input.value = '';
  }
}

function toggleResRow(row) {
  const next = row.nextElementSibling;
  const icon = row.querySelector('.fa-chevron-down, .fa-chevron-up');
  const isOpen = next.style.display === 'table-row';
  document.querySelectorAll('.res-accordion-detail').forEach(d => d.style.display = 'none');
  document.querySelectorAll('.res-accordion-row i.fa-chevron-up').forEach(i => {
    i.className = i.className.replace('fa-chevron-up','fa-chevron-down');
  });
  if (!isOpen) {
    next.style.display = 'table-row';
    if (icon) icon.className = icon.className.replace('fa-chevron-down','fa-chevron-up');
  }
}

let resCurrentFilter = 'all';
function resSetFilter(filter, btn) {
  resCurrentFilter = filter;
  document.querySelectorAll('.res-filter-btn').forEach(b => b.classList.remove('active-filter'));
  btn.classList.add('active-filter');
  resApplyFilter();
}
function resFilterRecords(q) { resApplyFilter(q.toLowerCase().trim()); }
function resApplyFilter(q = '') {
  const rows = document.querySelectorAll('#resTbody .res-accordion-row');
  let shown = 0;
  rows.forEach(row => {
    const outcome = row.dataset.outcome || '';
    const text = row.textContent.toLowerCase();
    const matchFilter = resCurrentFilter === 'all' || outcome === resCurrentFilter;
    const matchSearch = !q || text.includes(q);
    const show = matchFilter && matchSearch;
    row.style.display = show ? '' : 'none';
    const detail = row.nextElementSibling;
    if (detail && detail.classList.contains('res-accordion-detail')) {
      if (!show) detail.style.display = 'none';
    }
    if (show) shown++;
  });
  document.getElementById('resRecordsCount').textContent = 'Showing ' + shown + ' of 5 records';
}

function initializeResidentDashboard() {
  document.getElementById('modalDate')?.addEventListener('change', refreshTimeSlots);
  document.getElementById('rescheduleDate')?.addEventListener('change', refreshRescheduleSlots);
  document.getElementById('enablePushAlertsBtn')?.addEventListener('click', registerResidentPushAlerts);
  document.getElementById('batchBookingClinic')?.addEventListener('change', refreshBatchTimeSlots);
  document.getElementById('batchBookingDoseGrid')?.addEventListener('change', event => {
    if (event.target.matches('[data-dose-date]')) refreshBatchTimeSlots();
  });
  document.getElementById('batchBookingConfirmBtn')?.addEventListener('click', confirmBatchBooking);
  document.getElementById('batchBookingCancelBtn')?.addEventListener('click', closeBatchBookingModal);
  document.getElementById('batchBookingModal')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) closeBatchBookingModal();
  });
  document.getElementById('closeRescheduleBtn')?.addEventListener('click', () => {
    activeRescheduleAppointment = null;
    document.getElementById('rescheduleModal').classList.remove('open');
  });
  document.getElementById('saveRescheduleBtn')?.addEventListener('click', saveReschedule);
  document.getElementById('closeCancelBtn')?.addEventListener('click', () => document.getElementById('cancelModal').classList.remove('open'));
  document.getElementById('saveCancelBtn')?.addEventListener('click', saveCancellation);
  document.getElementById('bookingModal')?.addEventListener('click', function(e) {
    if (e.target === this) closeBookingModal();
  });
  document.getElementById('batchBookingModal')?.addEventListener('click', function(e) {
    if (e.target === this) closeBatchBookingModal();
  });


  document.getElementById('confirmBookingBtn')?.addEventListener('click', bookingPrimaryAction);
  document.getElementById('bookingCancelBtn')?.addEventListener('click', closeBookingModal);

  window.openBookingModal = openBookingModal;
  window.closeBookingModal = closeBookingModal;
  window.confirmBooking = confirmBooking;
  // Booking requires only the selected clinic's preferred date and time.
  window.proceedBooking = confirmBooking;
  window.confirmBookingPrimary = confirmBooking;
  window.bookingPrimaryAction = bookingPrimaryAction;

  window.filterMap = filterMap;
  window.handleUpload = handleUpload;
  window.updateNearestClinicSummary = updateNearestClinicSummary;
  window.toggleResRow = toggleResRow;
  const nextAppointmentCard = document.getElementById('nextAppointmentCard');
  const nearestClinicCard = document.getElementById('nearestClinicCard');
  const notificationsCard = document.getElementById('notificationsCard');
  nextAppointmentCard?.addEventListener('click', () => showTab('appointments', document.querySelectorAll('.nav-tab')[1]));
  nextAppointmentCard?.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') nextAppointmentCard.click(); });
  nearestClinicCard?.addEventListener('click', () => { showTab('overview', document.querySelectorAll('.nav-tab')[0]); window.focusNearestClinic?.(); });
  nearestClinicCard?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); nearestClinicCard.click(); }
  });
  notificationsCard?.addEventListener('click', () => showTab('notifications', document.getElementById('nav-notif')));

  onAuthStateChanged(auth, (user) => {
    // The independent session guard owns visibility and routing.
    if (user && !sessionIsTerminated()) {
      fetchUserProfile(user.uid).then(profile => {
        if (profile?.role !== 'resident' || auth.currentUser?.uid !== user.uid || sessionIsTerminated()) return;
        return loadResidentDashboard(user.uid, profile);
      }).catch(error => {
        reportResidentDataError('dashboard', error);
      });
    }
  });

  if (location.hash === '#panel-appointments') {
    const apptTab = document.querySelectorAll('.nav-tab')[1];
    if (apptTab) showTab('appointments', apptTab);
  }
  renderCasesChart();
  setTimeout(renderResVizChart, 300);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeResidentDashboard, { once: true });
} else {
  initializeResidentDashboard();
}

let appointmentDisplayKey = '';
setInterval(() => {
  const bookings = window.residentAppointments || [];
  const key = bookings.map(item => item.id + ':' + appointmentStatus(item)).join('|');
  if (key !== appointmentDisplayKey) {
    appointmentDisplayKey = key;
    renderLiveAppointments(bookings);
    renderUpcomingAppointments(bookings);
  }
}, 1000);

setInterval(() => { if (currentUid) renderLiveDoseRecords(residentVaccinationRecords, residentAppointments); }, 60000);
