import { auth, db, storage, fetchUserProfile, onAuthStateChanged, signOutUser } from './firebase.js';
import { doc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs, addDoc, onSnapshot, serverTimestamp, orderBy } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-storage.js";

let currentUid = null;
let currentResidentName = '';
let residentProfile = {};
let residentAppointments = [];
let selectedClinic = null;
let completedDoseCount = 0;
let firstDoseDate = null;
let latestVaccineBrand = '';
let originalDoseClinicId = '';
let residentVaccinationRecords = [];
let allResidentVaccinationRecords = [];
let residentVaccinationDocuments = [];
let allResidentVaccinationDocuments = [];
let bookingClinicContext = null;
let currentVaccinationSessionId = '';
let selectedDose = 1;
let pendingClinicChangeId = '';
let confirmedClinicChangeId = '';
let vaccinationDocumentsUnsubscribe = null;
const doseDayOffsets = [0, 3, 7, 14, 28];

function manilaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function isReservationExpired(appointment) {
  return appointment.status === 'confirmed'
    && appointment.reservation_end_date
    && appointment.reservation_end_date < manilaToday();
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
        <div class="notif-body" style="flex:1;min-width:0;"><h4 style="font-size:14px;font-weight:600;color:#111827;margin:0 0 4px;">${escapeHtml(notification.title || 'Notification')}</h4><p style="margin:0;font-size:13px;color:#4b5563;line-height:1.5;">${escapeHtml(notification.message || notification.body || '')}</p>${buildReferralCallout(notification)}<div class="notif-meta" style="display:flex;align-items:center;gap:12px;margin-top:8px;flex-wrap:wrap;"><span class="notif-time" style="font-size:12px;color:#9ca3af;"><i class="fa-regular fa-clock"></i> ${escapeHtml(createdAt)}</span><span class="notif-tag tag-${escapeHtml(type)}">${escapeHtml(type)}</span></div></div>
        ${notification.read ? '' : '<div class="unread-dot" style="position:absolute;top:20px;right:16px;width:8px;height:8px;background:#ef0000;border-radius:50%;"></div>'}</div>`;
    }).join('');
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
  }, error => console.error('Failed to listen for resident notifications:', error));
}

window.markAllRead = markAllRead;
window.filterNotifs = filterNotifs;

async function loadResidentDashboard(uid, userProfile = {}) {
  currentUid = uid;
  loadResidentNotifications(uid);
  const residentDoc = await getDoc(doc(db, 'residents', uid));
  const residentData = residentDoc.exists() ? residentDoc.data() : {};
  residentProfile = residentData;
  populateResidentProfile(residentData);

  const residentName = [residentData.first_name, residentData.last_name].filter(Boolean).join(' ');
  currentResidentName = residentName
    || residentData.username
    || userProfile.full_name
    || userProfile.name
    || auth.currentUser?.displayName
    || auth.currentUser?.email
    || 'Resident';

  const displayName = currentResidentName || auth.currentUser?.email || 'Resident';
  const headerName = document.getElementById('headerName');
  const recordName = document.getElementById('recordName');
  if (headerName) headerName.textContent = displayName;
  if (recordName) recordName.textContent = displayName;

  loadResidentBookings(uid);
  let liveBookings = [];
  onSnapshot(query(collection(db, 'appointments'), where('resident_uid', '==', uid)), snapshot => {
    liveBookings = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    residentAppointments = liveBookings;
    renderLiveRecordHeader(residentVaccinationRecords, liveBookings);
    renderUpcomingAppointments(liveBookings);
    renderLiveAppointments(liveBookings);
  }, error => console.error('Failed to listen for resident appointment details:', error));
  listenToAnimalExposure();
  listenToDashboardAnalytics();

  const recordsSnap = await getDocs(query(collection(db, 'vaccination_records'), where('resident_uid', '==', uid)));

  const allVaccinationRecords = recordsSnap.docs.map(item => item.data()).sort((first, second) => String(second.date_given || '').localeCompare(String(first.date_given || '')));
  allResidentVaccinationRecords = allVaccinationRecords;
  const vaccinationRecords = setCurrentVaccinationSession(allVaccinationRecords);
  residentVaccinationRecords = vaccinationRecords;
  renderPreviousVaccinationRecords(allVaccinationRecords);
  renderLiveDoseRecords(vaccinationRecords);
  renderLiveRecordHeader(vaccinationRecords, liveBookings);
  updateVaccinationProgress(vaccinationRecords);
  firstDoseDate = vaccinationRecords.reduce((earliest, record) => {
    const value = toDate(record.date_given);
    return value && (!earliest || value < earliest) ? value : earliest;
  }, null);

  const hasRecord = !recordsSnap.empty;
  const latestRecord = vaccinationRecords[0] || null;
  latestVaccineBrand = latestRecord?.vaccine_name || latestRecord?.vaccine_type || '';
  originalDoseClinicId = getPrimaryClinicId();
  if (window.clinicDirectory) populateClinicOptions(window.clinicDirectory);

  initView(hasRecord, latestRecord);
  updateVaccinationProgress(vaccinationRecords);
  loadVaccinationDocuments(uid);

  onSnapshot(query(collection(db, 'vaccination_records'), where('resident_uid', '==', uid)), snapshot => {
    const allRecords = snapshot.docs.map(item => item.data()).sort((first, second) => Number(second.dose_number || 0) - Number(first.dose_number || 0));
    allResidentVaccinationRecords = allRecords;
    residentVaccinationRecords = setCurrentVaccinationSession(allRecords);
    renderPreviousVaccinationRecords(allRecords);
    updateVaccinationProgress(residentVaccinationRecords);
    renderLiveRecordHeader(residentVaccinationRecords, liveBookings);
    renderLiveDoseRecords(residentVaccinationRecords, liveBookings);
    loadVaccinationDocuments(uid);
  }, error => console.error('Failed to listen for resident record header:', error));
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
  const bookableClinics = clinics.filter(clinic => clinic.status !== 'out');
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

function getPrimaryClinicId() {
  const firstCompletedDose = [...residentVaccinationRecords]
    .filter(record => Number(record.dose_number) === 1)
    .sort((a, b) => String(a.date_given || '').localeCompare(String(b.date_given || '')))[0];
  if (firstCompletedDose?.clinic_id) return firstCompletedDose.clinic_id;
  const firstBookedDose = residentAppointments
    .filter(appointment => appointment.vaccination_session_id === currentVaccinationSessionId
      && Number(String(appointment.dose_label || '').match(/\d+/)?.[0]) === 1)
    .sort((a, b) => (a.created_at?.toMillis?.() || 0) - (b.created_at?.toMillis?.() || 0))[0];
  return firstBookedDose?.primary_clinic_id || firstBookedDose?.clinic_id || originalDoseClinicId || '';
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
        <button class="book-btn dynamic-book-btn" data-clinic-id="${escapeHtml(clinic.id)}" ${isOut ? 'disabled' : ''}>${isOut ? 'Unavailable' : 'Book Now'}</button>
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
      const nextDoseDate = firstDoseDate && nextDose > 1 ? formatInputDate(firstDoseDate, doseDayOffsets[nextDose - 1]) : '';
      const latestCompletedAppointment = bookings.find(booking => booking.status === 'completed' && (Number(booking.completed_dose_number || 0) || Number(String(booking.dose_label || '').match(/\d+/)?.[0] || 0)) === completedDoseCount);
      const bookingMarkup = `<div class="booking-progress-panel"><h3><i class="fa-regular fa-calendar-check"></i> Booking Records</h3>${bookings.map(booking => {
        const status = appointmentStatus(booking);
        return `
        <div class="booking-progress-card"><div class="booking-progress-heading"><div><strong>${escapeHtml(booking.clinic_name || 'Clinic')}</strong><div>${escapeHtml(booking.preferred_date || '')} at ${escapeHtml(booking.preferred_time || '')} - ${escapeHtml(booking.dose_label || 'Dose 1')}</div></div><span class="booking-status status-${escapeHtml(status || 'pending')}">${status === 'confirmed' ? 'Confirmed' : status === 'completed' ? 'Completed' : status === 'declined' ? 'Declined' : status === 'expired' ? 'Expired' : 'Pending clinic review'}</span></div>
        <button type="button" class="view-record-button" data-record-id="${escapeHtml(booking.id)}">View Full Record</button><div class="full-record-details" id="full-record-${escapeHtml(booking.id)}" hidden><strong>Vaccination progress</strong><p>${completedDoseCount} of 5 doses completed.</p><p>${completedDoseCount < 5 ? `Next: Dose ${nextDose} (Day ${doseDayOffsets[nextDose - 1]})${nextDoseDate ? ` on ${formatScheduleDate(firstDoseDate, doseDayOffsets[nextDose - 1])}` : ''}.` : 'Vaccination schedule complete.'}</p>${completedDoseCount < 5 && latestCompletedAppointment?.id === booking.id ? `<button type="button" class="next-dose-button" data-clinic-id="${escapeHtml(latestRecord?.clinic_id || booking.clinic_id || '')}">Book Dose ${nextDose}${nextDoseDate ? ` for ${formatScheduleDate(firstDoseDate, doseDayOffsets[nextDose - 1])}` : ''}</button>` : ''}</div>
        ${status === 'declined' ? '<p class="booking-status-message">This appointment was declined by the clinic. Please choose another clinic or date.</p>' : status === 'expired' ? '<p class="booking-status-message">This reservation expired because its reservation period ended. Please book a new appointment.</p>' : `<div class="booking-steps"><div class="booking-step done"><span><i class="fa-solid fa-check"></i></span><small>Booked</small></div><div class="booking-step ${status === 'pending' ? 'current' : 'done'}"><span>${status === 'pending' ? '<i class="fa-solid fa-clock"></i>' : '<i class="fa-solid fa-check"></i>'}</span><small>${status === 'pending' ? 'Under review' : 'Confirmed'}</small></div><div class="booking-step ${status === 'completed' ? 'done' : ''}"><span>${status === 'completed' ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-calendar-day"></i>'}</span><small>${status === 'completed' ? 'Dose recorded' : 'Appointment'}</small></div></div>`}</div>`; }).join('')}</div>`;
      container.innerHTML = bookingMarkup;
      container.querySelectorAll('.view-record-button').forEach(button => button.addEventListener('click', () => { const details = document.getElementById(`full-record-${button.dataset.recordId}`); if (details) details.hidden = !details.hidden; }));
      container.querySelectorAll('.next-dose-button').forEach(button => button.addEventListener('click', () => { const clinic = window.clinicDirectory?.find(item => item.id === button.dataset.clinicId); openBookingModal(clinic?.name || '', clinic?.id || ''); }));
    };
    onSnapshot(query(collection(db, 'vaccination_records'), where('resident_uid', '==', uid)), snapshot => {
      residentVaccinationRecords = snapshot.docs.map(item => item.data()).sort((first, second) => String(second.date_given || '').localeCompare(String(first.date_given || '')));
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
  const completedByDose = new Map(records.map(record => [Number(record.dose_number), record]));
  const bookingByDose = new Map(bookings.map(booking => [Number(String(booking.dose_label || '').match(/\d+/)?.[0] || 0), booking]));
  list.innerHTML = Array.from({ length: 5 }, (_, index) => {
    const doseNumber = index + 1;
    const completed = completedByDose.get(doseNumber);
    const booking = bookingByDose.get(doseNumber);
    const dayOffset = doseDayOffsets[index];
    if (completed) {
      const date = formatRecordDate(completed.date_given);
      const clinic = completed.clinic_name || 'Clinic not specified';
      const location = completed.clinic_location ? ` | ${completed.clinic_location}` : '';
      const vaccine = completed.vaccine_name || completed.vaccine_type || 'Vaccine not specified';
      const administrator = completed.administered_by_name ? ` | ${completed.administered_by_name}` : '';
      return `<div class="dose-record"><div class="dose-circle done-circle"><i class="fa-solid fa-check"></i></div><div class="dose-record-info"><h4>Dose ${doseNumber} - Day ${dayOffset}</h4><p>${escapeHtml(date)} | ${escapeHtml(clinic)}${escapeHtml(location)} | ${escapeHtml(vaccine)}${escapeHtml(administrator)}</p></div><div class="dose-record-status"><span class="r-done">Completed</span></div></div>`;
    }
    if (booking && ['pending', 'confirmed'].includes(booking.status)) {
      return `<div class="dose-record"><div class="dose-circle next-circle"><i class="fa-regular fa-calendar"></i></div><div class="dose-record-info"><h4>Dose ${doseNumber} - Day ${dayOffset}</h4><p>Scheduled: ${escapeHtml(booking.preferred_date || '')} at ${escapeHtml(booking.preferred_time || '')} | ${escapeHtml(booking.clinic_name || 'Clinic')}</p></div><div class="dose-record-status"><span class="r-next">${booking.status === 'confirmed' ? 'Confirmed' : 'Upcoming'}</span></div></div>`;
    }
    return `<div class="dose-record"><div class="dose-circle pending-circle">${doseNumber}</div><div class="dose-record-info"><h4>Dose ${doseNumber} - Day ${dayOffset}</h4><p>Not yet scheduled</p></div><div class="dose-record-status"><span class="r-pending">Pending</span></div></div>`;
  }).join('');
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
  if (!firstRecord) return;
  const linkedAppointment = bookings.find(booking => booking.id === firstRecord.appointment_id)
    || bookings.find(booking => Number(String(booking.dose_label || '').match(/\d+/)?.[0] || 0) === Number(firstRecord.dose_number || 1));
  const setText = (id, value, fallback) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value || fallback;
  };
  setText('recordStart', formatRecordDate(firstRecord.date_given), 'Date not specified');
  setText('recordVaccine', firstRecord.vaccine_name || firstRecord.vaccine_type, 'Vaccine not specified');
  setText('recordBiteSite', linkedAppointment?.bite_body_part, 'Not recorded');
  setText('recordAnimal', linkedAppointment?.animal_type, 'Not recorded');
  setText('recordCategory', linkedAppointment?.patient_category, 'Not recorded');
}

function updateVaccinationProgress(records) {
  const completedDoses = new Set(records
    .map(record => Number(record.dose_number || 0))
    .filter(doseNumber => doseNumber >= 1 && doseNumber <= 5));
  completedDoseCount = completedDoses.size;
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
    pip.className = completedDoses.has(doseNumber) ? 'dose-pip done' : doseNumber === completedDoseCount + 1 ? 'dose-pip current' : 'dose-pip';
  }
}

function setCurrentVaccinationSession(records) {
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
  container.innerHTML = `<div class="previous-records-heading"><i class="fa-solid fa-clock-rotate-left"></i> Previous vaccination records</div>${[...sessions.values()].map((records, index) => {
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
    return `<details class="previous-record-card"><summary><div class="previous-record-main"><div class="previous-record-title-row"><strong>Vaccination Record - ${escapeHtml(first.clinic_name || 'Previous clinic')}</strong><span class="previous-completed-badge">${percent}% Complete</span></div><small>Started ${escapeHtml(formatRecordDate(first.date_given))} | ${completed} / 5 doses</small><div class="previous-progress-track"><span style="width:${percent}%;"></span></div></div><div class="previous-record-progress"><b>${percent}%</b><small>complete</small></div><i class="fa-solid fa-chevron-down previous-record-chevron"></i></summary><div class="previous-dose-list"><strong>Completed doses</strong>${ordered.map(record => `<span><i class="fa-solid fa-check"></i> Dose ${escapeHtml(record.dose_number)}: ${escapeHtml(formatRecordDate(record.date_given))} | ${escapeHtml(record.clinic_name || 'Clinic')}</span>`).join('')}</div>${documentMarkup}</details>`;
  }).join('')}`;
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
  const completedDoses = new Set(residentVaccinationRecords.map(record => Number(record.dose_number || 0))).size;
  const courseComplete = completedDoses >= doseDayOffsets.length;
  const controls = document.getElementById('uploadDocumentControls');
  const help = document.getElementById('vaccinationDocumentHelp');
  if (!courseComplete) {
    residentVaccinationDocuments = [];
    container.innerHTML = '<p class="documents-empty">Document upload unlocks when Dose 5 has been recorded.</p>';
    if (controls) controls.hidden = true;
    if (help) help.textContent = `Complete all 5 doses to unlock document upload (${completedDoses}/5 recorded).`;
  }
  if (help && courseComplete) help.textContent = 'Upload one completed vaccination card for clinic verification. You can delete it and choose a replacement if needed.';
  const documentsQuery = query(collection(db, 'vaccination_documents'), where('resident_uid', '==', uid));
  const renderDocumentList = documents => {
    residentVaccinationDocuments = documents;
    renderPreviousVaccinationRecords(allResidentVaccinationRecords);
    // Keep the new course's document area locked, but do not stop the query:
    // previous completed courses still need to show their own uploaded photo.
    if (!courseComplete) {
      container.innerHTML = '<p class="documents-empty">Document upload unlocks when Dose 5 has been recorded.</p>';
      if (controls) controls.hidden = true;
      return;
    }
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
    allResidentVaccinationDocuments = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    const documents = allResidentVaccinationDocuments
      .filter(document => document.vaccination_session_id === currentVaccinationSessionId);
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
  if (!documentId || !currentUid || !confirm('Delete this uploaded vaccination document?')) return;
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
    alert('Could not delete the document: ' + error.message);
  }
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
    return `<div class="appt-mini"><div class="appt-date-box"><div class="day">${escapeHtml(String(day))}</div><div class="mon">${escapeHtml(month)}</div></div><div class="appt-info"><h4>${escapeHtml(booking.clinic_name || 'Clinic')}</h4><p><i class="fa-regular fa-clock"></i> ${escapeHtml(booking.preferred_time || 'Time not specified')} &nbsp;|&nbsp; Dose ${escapeHtml(doseNumber)} of 5</p></div><span class="dose-badge">D${escapeHtml(doseNumber)}</span></div>`;
  }).join('');
}

function renderLiveAppointments(bookings) {
  window.residentAppointments = bookings;
  const upcomingContainer = document.getElementById('liveUpcomingAppointments');
  const completedContainer = document.getElementById('liveCompletedAppointments');
  if (!upcomingContainer && !completedContainer) return;
  const sorted = [...bookings].sort((first, second) => `${second.preferred_date || ''} ${second.preferred_time || ''}`.localeCompare(`${first.preferred_date || ''} ${first.preferred_time || ''}`));
  const upcoming = sorted.filter(booking => ['pending', 'confirmed', 'in_progress'].includes(appointmentStatus(booking)) && (!booking.preferred_date || booking.preferred_date >= manilaToday()));
  const completed = sorted.filter(booking => booking.status === 'completed');
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
    return `<div class="appt-card ${isCompleted ? 'completed' : 'upcoming'}"><div class="appt-card-date"><div class="big-day">${escapeHtml(String(day))}</div><div class="month-yr">${escapeHtml(monthYear)}</div></div><div class="appt-card-body"><div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;"><h3>Dose ${escapeHtml(dose)} ${escapeHtml(vaccine)} Vaccination</h3><span class="appt-status ${isCompleted ? 'status-done' : status === 'expired' ? 'status-expired' : 'status-upcoming'}">${isCompleted ? 'Completed' : status === 'expired' ? 'Expired' : status === 'confirmed' ? 'Confirmed' : 'Pending'}</span></div><p><i class="fa-solid fa-hospital" style="color:#6b7280;"></i> ${escapeHtml(booking.clinic_name || 'Clinic not specified')}</p><p><i class="fa-regular fa-clock" style="color:#6b7280;"></i> ${escapeHtml(detail)}</p>${!isCompleted && status !== 'expired' ? `<div class="appt-card-actions"><button class="action-btn reschedule-button" data-appointment-id="${escapeHtml(booking.id)}"><i class="fa-solid fa-arrows-rotate"></i> Reschedule</button><button class="action-btn danger cancel-appointment-button" data-appointment-id="${escapeHtml(booking.id)}"><i class="fa-solid fa-xmark"></i> Cancel</button></div>` : ''}</div></div>`;
  };
  if (upcomingContainer) upcomingContainer.innerHTML = upcoming.length ? upcoming.map(booking => renderCard(booking, false)).join('') : '<p style="font-size:13px;color:#6b7280;padding:10px 0;">No upcoming appointments.</p>';
  if (completedContainer) completedContainer.innerHTML = completed.length ? completed.map(booking => renderCard(booking, true)).join('') : '<p style="font-size:13px;color:#6b7280;padding:10px 0;">No completed appointments yet.</p>';
  document.querySelectorAll('.reschedule-button').forEach(button => button.addEventListener('click', () => openRescheduleModal(bookings.find(booking => booking.id === button.dataset.appointmentId))));
  document.querySelectorAll('.cancel-appointment-button').forEach(button => button.addEventListener('click', () => openCancelModal(bookings.find(booking => booking.id === button.dataset.appointmentId))));
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
  if (!element || !clinics.length) return;
  const fallback = { lat: 14.2718, lng: 121.1246 };
  const update = position => {
    const origin = position ? { lat: position.coords.latitude, lng: position.coords.longitude } : fallback;
    const nearest = clinics.filter(clinic => Number.isFinite(clinic.lat) && Number.isFinite(clinic.lng)).sort((first, second) => distanceInKm(origin, first) - distanceInKm(origin, second))[0];
    element.textContent = nearest ? `${distanceInKm(origin, nearest).toFixed(1)} km` : 'No clinic location';
  };
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition(update, () => update(), { maximumAge: 300000, timeout: 5000 });
  else update();
}

function distanceInKm(origin, clinic) {
  const earthRadius = 6371;
  const latDelta = (clinic.lat - origin.lat) * Math.PI / 180;
  const lngDelta = (clinic.lng - origin.lng) * Math.PI / 180;
  const value = Math.sin(latDelta / 2) ** 2 + Math.cos(origin.lat * Math.PI / 180) * Math.cos(clinic.lat * Math.PI / 180) * Math.sin(lngDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function openRescheduleModal(appointment) {
  if (!appointment) return;
  const date = appointment.preferred_date || new Date().toISOString().split('T')[0];
  const nextDate = formatInputDate(new Date(`${date}T00:00:00`), 1);
  document.getElementById('rescheduleAppointmentId').value = appointment.id;
  const dateInput = document.getElementById('rescheduleDate');
  dateInput.value = date;
  dateInput.min = date;
  dateInput.max = nextDate;
  document.getElementById('rescheduleTime').value = appointment.preferred_time || '9:00 AM';
  document.getElementById('rescheduleMsg').style.display = 'none';
  document.getElementById('rescheduleModal').classList.add('open');
}

async function saveReschedule() {
  const appointmentId = document.getElementById('rescheduleAppointmentId').value;
  const date = document.getElementById('rescheduleDate').value;
  const time = document.getElementById('rescheduleTime').value;
  const message = document.getElementById('rescheduleMsg');
  if (!appointmentId || !date) return;
  const appointment = window.residentAppointments?.find(item => item.id === appointmentId);
  const originalDate = appointment?.preferred_date;
  const allowedNextDate = originalDate ? formatInputDate(new Date(`${originalDate}T00:00:00`), 1) : date;
  if (originalDate && (date < originalDate || date > allowedNextDate)) {
    message.textContent = `You may reschedule only from ${originalDate} to ${allowedNextDate}.`;
    message.style.display = 'block';
    message.style.color = '#b91c1c';
    return;
  }
  try {
    await updateDoc(doc(db, 'appointments', appointmentId), {
      preferred_date: date,
      preferred_time: time,
      status: 'pending',
      reschedule_requested: true,
      rescheduled_at: serverTimestamp()
    });
    if (appointment?.clinic_staff_uid) await addDoc(collection(db, 'notifications'), { recipient_uid: appointment.clinic_staff_uid, user_id: appointment.clinic_staff_uid, appointment_id: appointmentId, type: 'appointment', title: 'Appointment Rescheduled', message: `${currentResidentName} rescheduled an appointment to ${date} at ${time}.`, read: false, created_at: serverTimestamp() });
    document.getElementById('rescheduleModal').classList.remove('open');
  } catch (error) {
    message.textContent = 'Could not reschedule: ' + error.message;
    message.style.display = 'block';
    message.style.color = '#b91c1c';
  }
}

function openCancelModal(appointment) {
  if (!appointment) return;
  document.getElementById('cancelAppointmentId').value = appointment.id;
  document.getElementById('cancelReason').value = '';
  document.getElementById('cancelMsg').style.display = 'none';
  document.getElementById('cancelModal').classList.add('open');
}

async function saveCancellation() {
  const appointmentId = document.getElementById('cancelAppointmentId').value;
  const reason = document.getElementById('cancelReason').value.trim();
  const message = document.getElementById('cancelMsg');
  if (!appointmentId || !reason) {
    message.textContent = 'Please provide a reason for cancelling this appointment.';
    message.style.display = 'block';
    message.style.color = '#b91c1c';
    return;
  }
  const appointment = window.residentAppointments?.find(item => item.id === appointmentId);
  try {
    await updateDoc(doc(db, 'appointments', appointmentId), {
      status: 'cancelled',
      cancellation_reason: reason,
      cancelled_at: serverTimestamp(),
      cancelled_by: currentUid
    });
    if (appointment?.clinic_staff_uid) await addDoc(collection(db, 'notifications'), {
      recipient_uid: appointment.clinic_staff_uid,
      user_id: appointment.clinic_staff_uid,
      appointment_id: appointmentId,
      type: 'appointment',
      title: 'Appointment Cancelled',
      message: `${currentResidentName} cancelled the ${appointment.dose_label || 'vaccination'} appointment. Reason: ${reason}`,
      read: false,
      created_at: serverTimestamp()
    });
    document.getElementById('cancelModal').classList.remove('open');
  } catch (error) {
    message.textContent = 'Could not cancel appointment: ' + error.message;
    message.style.display = 'block';
    message.style.color = '#b91c1c';
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
  onSnapshot(doc(db, 'system_settings', 'live_analytics'), snapshot => {
    renderAnimalExposure(snapshot.exists() ? snapshot.data() : {});
  }, error => console.error('Failed to load live animal exposure data:', error));
}

function listenToDashboardAnalytics() {
  onSnapshot(doc(db, 'system_settings', 'live_analytics'), snapshot => {
    const data = snapshot.exists() ? snapshot.data() : {};
    const monthlyCases = Array.isArray(data.monthlyCases) ? data.monthlyCases : Array(12).fill(0);
    const monthlyVaccinations = Array.isArray(data.monthlyVaccinations) ? data.monthlyVaccinations : Array(12).fill(0);
    if (window.residentMonthlyChart) {
      window.residentMonthlyChart.data.datasets[0].data = monthlyCases;
      window.residentMonthlyChart.data.datasets[1].data = monthlyVaccinations;
      window.residentMonthlyChart.update();
    }
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
    setDisplay('panel-records', 'none');
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
  const ctx = document.getElementById('monthlyChart');
  if (!ctx || !window.Chart) return;
  window.residentMonthlyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      datasets: [
        { label: 'Rabies Cases', data: Array(12).fill(0), backgroundColor: 'rgba(239,0,0,0.75)', borderRadius: 4, borderSkipped: false },
        { label: 'Vaccinations', data: Array(12).fill(0), backgroundColor: 'rgba(52,211,153,0.75)', borderRadius: 4, borderSkipped: false }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'top', labels: { font: { size: 11 }, padding: 10 } } },
      scales: {
        y: { beginAtZero: true, grid: { color: '#f3f4f6' }, ticks: { font: { size: 11 } } },
        x: { grid: { display: false }, ticks: { font: { size: 11 } } }
      }
    }
  });
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

function showTab(tab, el) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const panel = document.getElementById('panel-' + tab);
  if (panel) panel.classList.add('active');
  if (el) el.classList.add('active');
  // If the Overview panel contains maps, refresh them after layout changes
  if (tab === 'overview' && window.refreshMaps) setTimeout(() => window.refreshMaps(), 150);
  // Make sure the first aid and notifications panels stay visible when selected
  if ((tab === 'firstaid' || tab === 'notifications') && panel) panel.classList.add('active');
  // Ensure one of the appointments sub-views is visible when opening Appointments
  if (tab === 'appointments') {
    const newEl = document.getElementById('appt-new-resident');
    const activeEl = document.getElementById('appt-active-patient');
    if (newEl && activeEl) {
      const newVis = window.getComputedStyle(newEl).display;
      const actVis = window.getComputedStyle(activeEl).display;
      if (newVis === 'none' && actVis === 'none') {
        // default to new resident view
        newEl.style.display = 'block';
        activeEl.style.display = 'none';
      }
    }
  }
}

// Note: functions used by inline `onclick` will be exposed to `window` after they are defined,
// inside DOMContentLoaded, so HTML inline handlers continue working with module scripts.

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
  if (!firstDoseDate || doseLevel <= 1 || doseLevel > doseDayOffsets.length) {
    return new Date().toISOString().split('T')[0];
  }
  return formatInputDate(firstDoseDate, doseDayOffsets[doseLevel - 1]);
}

// --- Appointment time slots -------------------------------------------------

// A slot must be booked far enough ahead to be a real appointment, and must end
// before the clinic closes. Both are measured in minutes from midnight.
const SLOT_INTERVAL_MINUTES = 30;
const MIN_LEAD_TIME_MINUTES = 60;
const CLINIC_CLOSE_BUFFER_MINUTES = 30;
// Used only when a clinic has no parseable operating hours on record.
const DEFAULT_CLOSING_MINUTES = 17 * 60;
// Resolves the effective closing time in minutes, or null when unlimited.
function effectiveClosingMinutes(clinic) {
  const closing = clinicClosingMinutes(clinic);
  return closing === null ? null : (closing ?? DEFAULT_CLOSING_MINUTES);
}

// "09:30 AM" -> 570. Returns null when the label is not a clock time.
function parseTimeLabelToMinutes(label) {
  const match = String(label ?? '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const suffix = (match[3] || '').toLowerCase();
  if (minutes > 59) return null;
  if (suffix === 'pm' && hours < 12) hours += 12;
  if (suffix === 'am' && hours === 12) hours = 0;
  if (hours > 23) return null;
  return hours * 60 + minutes;
}

// Minutes from midnight for the wall clock in Cabuyao, which is what the clinic
// and the resident are both looking at regardless of the device timezone.
// (Distinct from manilaToday(), which returns a date string.)
function manilaMinutesNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const read = type => Number(parts.find(part => part.type === type)?.value ?? 0);
  return read('hour') * 60 + read('minute');
}

// Pulls the closing time out of free-text hours such as "8:00 AM - 5:00 PM".
// Returns:
//   a number  - the clinic closes at that time
//   null      - the clinic is open 24 hours, so there is no closing limit
//   undefined - hours are missing or unreadable, so DEFAULT_CLOSING_MINUTES applies
function clinicClosingMinutes(clinic) {
  const hoursText = String(clinic?.hours || '').trim();
  if (!hoursText) return undefined;
  if (/24\s*\/\s*7|24\s*hours?|open\s*24/i.test(hoursText)) return null;
  if (/closed/i.test(hoursText) && !/\d/.test(hoursText)) return undefined;
  // Ignore a "(Weekdays)" / "(Sat-Sun)" style qualifier before the times.
  const body = hoursText.replace(/\([^)]*\)/g, '');
  const times = body.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi) || [];
  // The closing time is the last clock time in the range.
  const closing = times.length >= 2 ? parseTimeLabelToMinutes(times[times.length - 1]) : null;
  return closing === null ? null : closing;
}

// Rebuilds the time dropdown for the selected date. Every slot stays in the
// list so the resident can see the full day, but past slots and slots that run
// into the clinic's closing time are disabled rather than removed.
function refreshTimeSlots() {
  const timeSelect = document.getElementById('modalTime');
  const dateEl = document.getElementById('modalDate');
  const hint = document.getElementById('modalTimeHint');
  if (!timeSelect) return;
  const clinic = window.clinicDirectory?.find(item => item.id === document.getElementById('modalClinic')?.value) || selectedClinic;
  const closingMinutes = effectiveClosingMinutes(clinic);
  const isToday = Boolean(dateEl?.value) && dateEl.value === manilaToday();
  const nowMinutes = manilaMinutesNow();

  let firstOpen = null;
  [...timeSelect.options].forEach(option => {
    const slot = parseTimeLabelToMinutes(option.textContent);
    let reason = '';
    if (slot === null) {
      option.disabled = false;
      return;
    }
    // The appointment runs for SLOT_INTERVAL_MINUTES and must finish at least
    // CLINIC_CLOSE_BUFFER_MINUTES before the clinic shuts. A null closing time
    // means the clinic never closes, so only the past check applies.
    if (closingMinutes !== null && slot + SLOT_INTERVAL_MINUTES + CLINIC_CLOSE_BUFFER_MINUTES > closingMinutes) reason = 'clinic closes';
    else if (isToday && slot < nowMinutes + MIN_LEAD_TIME_MINUTES) reason = 'past';
    option.disabled = Boolean(reason);
    option.dataset.slotState = reason;
    if (!reason && firstOpen === null) firstOpen = option.value;
  });

  // Never leave a disabled slot selected.
  if (timeSelect.selectedOptions[0]?.disabled) {
    timeSelect.value = firstOpen ?? '';
    if (firstOpen === null) {
      timeSelect.selectedIndex = -1;
    }
  }
  if (hint) {
    hint.textContent = firstOpen === null
      ? `No appointment slots remain for this date. The clinic closes at ${formatMinutesLabel(closingMinutes)}, so please choose another date.`
      : closingMinutes === null
        ? 'Slots run every 30 minutes. This clinic is open 24 hours, so any remaining slot today can be booked.'
      : "Slots run every 30 minutes. Times already past, or too close to the clinic's closing time, cannot be selected.";
  }
}

function formatMinutesLabel(totalMinutes) {
  const hours24 = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

// True when the time has already passed (today only) or leaves the clinic less
// than the buffer before closing. Mirrors refreshTimeSlots so a booking cannot
// slip through when a slot was disabled client-side but submitted anyway.
function timeSlotError(date, time, clinic) {
  const slot = parseTimeLabelToMinutes(time);
  if (slot === null) return 'Please select a preferred time.';
  const closingMinutes = effectiveClosingMinutes(clinic);
  if (closingMinutes !== null && slot + SLOT_INTERVAL_MINUTES + CLINIC_CLOSE_BUFFER_MINUTES > closingMinutes) {
    return `The clinic closes at ${formatMinutesLabel(closingMinutes)}, so the last bookable slot is ${formatMinutesLabel(closingMinutes - SLOT_INTERVAL_MINUTES - CLINIC_CLOSE_BUFFER_MINUTES)}. Please choose an earlier time or another date.`;
  }
  if (date === manilaToday() && slot < manilaMinutesNow() + MIN_LEAD_TIME_MINUTES) {
    return `${time} has already passed. Please choose a later time today, or book for another date.`;
  }
  return '';
}

// A follow-up is a returning visit only when the resident has already dealt
// with the clinic currently selected. A record at another clinic must not
// waive this clinic's first-visit ID check.
function isReturningClinicFollowUp(clinicId, dose) {
  if (!clinicId || doseLevelFromLabel(dose) <= 1) return false;
  const hasPreviousAppointment = residentAppointments.some(appointment =>
    appointment.clinic_id === clinicId && appointment.status !== 'cancelled'
  );
  const hasVaccinationRecord = residentVaccinationRecords.some(record =>
    record.clinic_id === clinicId
  );
  return hasPreviousAppointment || hasVaccinationRecord;
}

function updateBookingIdRequirement() {
  const clinicId = document.getElementById('modalClinic')?.value || '';
  const dose = document.getElementById('modalDose')?.value || '';
  const optional = isReturningClinicFollowUp(clinicId, dose);
  const description = document.getElementById('bookingIdRequirementText');
  const label = document.getElementById('bookingIdRequirementLabel');
  if (description) description.textContent = optional
    ? 'Your previous appointment or vaccination record at this clinic is on file. Uploading your Valid ID again is optional.'
    : 'A valid ID is required to confirm your appointment. Clinic staff will verify it when you arrive.';
  if (label) {
    label.textContent = optional ? '(optional - already on file)' : '(required)';
    label.style.color = optional ? '#6b7280' : '#ef0000';
  }
  return optional;
}

function openBookingModal(clinic, clinicId = '') {
  const startsNewVaccination = completedDoseCount >= doseDayOffsets.length;
  confirmedClinicChangeId = '';
  pendingClinicChangeId = '';
  const sel = document.getElementById('modalClinic');
  const nextDose = startsNewVaccination ? 1 : Math.min(5, completedDoseCount + 1);
  const primaryClinicId = nextDose > 1 ? getPrimaryClinicId() : '';
  if (sel && primaryClinicId) {
    sel.value = primaryClinicId;
  } else if (sel && clinicId) {
    sel.value = clinicId;
  } else if (clinic && sel) {
    const option = [...sel.options].find(item => item.dataset.name === clinic || item.text.startsWith(clinic));
    if (option) sel.value = option.value;
  }
  selectedClinic = window.clinicDirectory?.find(item => item.id === sel?.value) || null;
  const { courseAppointments, intake } = courseBookingContext();
  const clinicBookings = residentAppointments
    .filter(item => item.clinic_id === sel?.value && item.status !== 'declined')
    .sort((first, second) => String(second.created_at?.toMillis?.() || '').localeCompare(String(first.created_at?.toMillis?.() || '')));
  const previousBooking = clinicBookings[0];
  const bookingWithDetails = courseAppointments.find(item => item.bite_date && item.animal_type && item.bite_body_part) || previousBooking;
  bookingClinicContext = { clinicId: sel?.value || '', previousBooking, bookingWithDetails, intake, primaryClinicId };
  const returningClinic = nextDose > 1 && Boolean(intake?.bite_date || intake?.animal_type || bookingWithDetails);
  const saved = {
    address: intake.resident_address || residentProfile.address || bookingWithDetails?.resident_address || '',
    dateOfBirth: intake.date_of_birth || residentProfile.birthday || bookingWithDetails?.date_of_birth || '',
    sex: intake.patient_sex || residentProfile.gender || bookingWithDetails?.patient_sex || '',
    biteDate: intake.bite_date || bookingWithDetails?.bite_date || '',
    animal: intake.animal_type || bookingWithDetails?.animal_type || '',
    bitePart: intake.bite_body_part || bookingWithDetails?.bite_body_part || '',
    woundWashed: intake.wound_washed || bookingWithDetails?.wound_washed || '',
    biteType: intake.bite_type || bookingWithDetails?.bite_type || ''
  };
  document.getElementById('modalAddress').value = saved.address;
  document.getElementById('modalDateOfBirth').value = saved.dateOfBirth;
  document.getElementById('modalSex').value = saved.sex;
  document.getElementById('modalBiteDate').value = saved.biteDate;
  document.getElementById('modalAnimal').value = saved.animal;
  document.getElementById('modalBitePart').value = saved.bitePart;
  document.getElementById('modalWoundWashed').value = saved.woundWashed;
  document.getElementById('modalBiteType').value = saved.biteType;
  document.getElementById('modalPriorVaccinationHistory').value = residentProfile.prior_vaccination_history_declared ? 'declared' : 'not_declared';
  document.getElementById('modalPriorVaccinationNotes').value = residentProfile.prior_vaccination_history_notes || '';
  document.getElementById('modalPriorVaccinationDocument').value = '';
  resetBookingSteps();
  document.getElementById('bookingPatientDetails').hidden = returningClinic;
  document.getElementById('returningClinicMessage').hidden = !returningClinic;
  document.getElementById('returningClinicMessage').textContent = 'Your locked intake details and vaccination history are saved for this course. Only choose your next dose date and time, then proceed to confirm.';
  document.getElementById('modalAddress').readOnly = returningClinic;
  document.getElementById('modalDateOfBirth').required = !returningClinic;
  document.getElementById('modalSex').required = !returningClinic;
  document.getElementById('modalBiteDate').required = !returningClinic;
  document.getElementById('modalAnimal').required = !returningClinic;
  document.getElementById('modalBitePart').required = !returningClinic;
  document.getElementById('modalWoundWashed').required = !returningClinic;
  document.getElementById('modalBiteType').required = !returningClinic;
  // The Valid ID is never marked required in step 1 - it belongs to step 2 and
  // is enforced there, after the resident has reviewed their details.
  document.getElementById('modalValidId').required = false;
  document.getElementById('modalWoundPhoto').required = false;
  const dateEl = document.getElementById('modalDate');
  const doseSelect = document.getElementById('modalDose');
  if (startsNewVaccination) {
    currentVaccinationSessionId = crypto.randomUUID();
    bookingClinicContext.newVaccinationSessionId = currentVaccinationSessionId;
  }
  // Every dose level is selectable from the start. A first-time resident may
  // already be catching up on dose 2, 3, or later, so nothing is hidden here -
  // the suggested dose is only a default.
  if (doseSelect) {
    [...doseSelect.options].forEach(option => {
      option.hidden = false;
    });
    doseSelect.value = `Dose ${nextDose} (Day ${doseDayOffsets[nextDose - 1]})`;
    selectedDose = doseSelect.value;
  }
  updateBookingIdRequirement();
  if (dateEl) {
    const suggestedDate = firstDoseDate && nextDose > 1
      ? formatInputDate(firstDoseDate, doseDayOffsets[nextDose - 1])
      : new Date().toISOString().split('T')[0];
    dateEl.value = suggestedDate;
    dateEl.min = suggestedDate;
  }
  // Enable/disable slots for whichever date and clinic ended up selected.
  refreshTimeSlots();
  document.getElementById('bookingModal').classList.add('open');
}

function closeBookingModal() {
  document.getElementById('bookingModal').classList.remove('open');
  document.getElementById('bookingReviewModal')?.classList.remove('open');
  document.getElementById('bookingReviewModal')?.setAttribute('aria-hidden', 'true');
  resetBookingSteps();
}

// --- Booking steps ----------------------------------------------------------
// Step 1 collects the appointment details. "Proceed" validates them and opens a
// review dialog; confirming that reveals step 2, where a Valid ID is mandatory.

function resetBookingSteps() {
  const idStep = document.getElementById('bookingIdStep');
  const detailsStep = document.getElementById('bookingPatientDetails');
  const backBtn = document.getElementById('bookingBackBtn');
  const cancelBtn = document.getElementById('bookingCancelBtn');
  const proceedBtn = document.getElementById('confirmBookingBtn');
  if (idStep) idStep.hidden = true;
  // bookingPatientDetails may have been hidden for returning-clinic bookings;
  // openBookingModal() re-applies that state the next time it runs.
  if (detailsStep) detailsStep.hidden = false;
  if (backBtn) backBtn.hidden = true;
  if (cancelBtn) cancelBtn.hidden = false;
  if (proceedBtn) proceedBtn.disabled = false;
  const idInput = document.getElementById('modalValidId');
  if (idInput) idInput.value = '';
  const reviewSummary = document.getElementById('bookingReviewSummary');
  if (reviewSummary) reviewSummary.innerHTML = '';
}

function bookingStepBack() {
  const idStep = document.getElementById('bookingIdStep');
  const detailsStep = document.getElementById('bookingPatientDetails');
  const backBtn = document.getElementById('bookingBackBtn');
  const proceedBtn = document.getElementById('confirmBookingBtn');
  if (idStep) idStep.hidden = true;
  if (detailsStep) detailsStep.hidden = false;
  if (backBtn) backBtn.hidden = true;
  if (proceedBtn) {
    proceedBtn.disabled = false;
    proceedBtn.innerHTML = '<i class="fa-solid fa-arrow-right"></i> Proceed';
  }
  const msgEl = document.getElementById('bookingMsg');
  if (msgEl) msgEl.style.display = 'none';
}

function showBookingIdStep() {
  const idStep = document.getElementById('bookingIdStep');
  if (idStep) idStep.hidden = false;
  const backBtn = document.getElementById('bookingBackBtn');
  if (backBtn) backBtn.hidden = false;
  const proceedBtn = document.getElementById('confirmBookingBtn');
  if (proceedBtn) proceedBtn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Booking';
  updateBookingIdRequirement();
  const reviewModal = document.getElementById('bookingReviewModal');
  reviewModal?.classList.remove('open');
  reviewModal?.setAttribute('aria-hidden', 'true');
  document.getElementById('bookingIdStep')?.scrollIntoView({ block: 'nearest' });
}

// Step 2 is the active step exactly when its panel is visible. Both the button
// handler and the inline onclick use this to decide what a click should do.
function isBookingIdStepActive() {
  const idStep = document.getElementById('bookingIdStep');
  return Boolean(idStep) && idStep.hidden === false;
}

// Single entry point for the shared Proceed / Confirm Booking button. Used by
// the inline onclick attribute; the direct listener below calls the same logic.
function bookingPrimaryAction() {
  if (isBookingIdStepActive()) {
    confirmBooking();
  } else {
    proceedBooking();
  }
}

// Snapshot of the step-1 fields, used for both the review dialog and the save.
function readBookingDetails() {
  const clinicSelect = document.getElementById('modalClinic');
  const clinicId = clinicSelect?.value || '';
  const clinic = window.clinicDirectory?.find(item => item.id === clinicId) || selectedClinic;
  const dose = document.getElementById('modalDose')?.value || '';
  const idFile = document.getElementById('modalValidId')?.files?.[0] || null;
  return {
    clinic,
    clinicId,
    dose,
    date: document.getElementById('modalDate')?.value || '',
    time: document.getElementById('modalTime')?.value || '',
    address: document.getElementById('modalAddress')?.value.trim() || '',
    dateOfBirth: document.getElementById('modalDateOfBirth')?.value || '',
    sex: document.getElementById('modalSex')?.value || '',
    biteDate: document.getElementById('modalBiteDate')?.value || '',
    animal: document.getElementById('modalAnimal')?.value || '',
    bitePart: document.getElementById('modalBitePart')?.value.trim() || '',
    woundWashed: document.getElementById('modalWoundWashed')?.value || '',
    biteType: document.getElementById('modalBiteType')?.value.trim() || '',
    woundPhoto: document.getElementById('modalWoundPhoto')?.files?.[0] || null,
    priorVaccinationHistory: document.getElementById('modalPriorVaccinationHistory')?.value === 'declared',
    priorVaccinationNotes: document.getElementById('modalPriorVaccinationNotes')?.value.trim() || '',
    priorVaccinationDocument: document.getElementById('modalPriorVaccinationDocument')?.files?.[0] || null,
    idFile,
    returningClinic: doseLevelFromLabel(dose) > 1
      && Boolean(bookingClinicContext?.intake?.bite_date || bookingClinicContext?.bookingWithDetails),
    returningClinicFollowUp: isReturningClinicFollowUp(clinicId, dose)
  };
}

// Returns an error string for the first problem with the step-1 fields, or ''.
// `forReview` skips the Valid ID, which is not collected until step 2.
function validateBookingDetails(details) {
  if (!details.clinic) return 'Please select an available clinic before booking.';
  if (!details.date) return 'Please select a preferred date.';
  if (details.returningClinic) return '';
  if (!details.address) return 'Please provide your address.';
  if (!details.dateOfBirth) return 'Please enter your date of birth.';
  if (!details.sex) return 'Please select your sex.';
  if (!details.biteDate) return 'Please enter the date of the bite.';
  if (!details.animal) return 'Please select the animal that bit you.';
  if (!details.bitePart) return 'Please select the body part of the bite.';
  if (!details.woundWashed) return 'Please state whether the wound was washed.';
  if (!details.biteType) return 'Please select the exposure type.';
  return '';
}

function buildReviewRows(details) {
  const rows = [
    ['Patient', currentResidentName],
    ['Clinic', details.clinic?.name || 'Not selected'],
    ['Dose', details.dose],
    ['Date', details.date],
    ['Time', details.time]
  ];
  if (!details.returningClinic) {
    rows.push(
      ['Address', details.address],
      ['Date of birth', details.dateOfBirth],
      ['Sex', details.sex],
      ['Date of bite', details.biteDate],
      ['Animal', details.animal],
      ['Body part', details.bitePart],
      ['Wound washed', details.woundWashed],
      ['Exposure type', details.biteType],
      ['Wound photo', details.woundPhoto ? details.woundPhoto.name : 'Not provided (optional)']
    );
  }
  if (details.priorVaccinationHistory || details.priorVaccinationNotes || details.priorVaccinationDocument) {
    rows.push(
      ['Previous vaccination history', details.priorVaccinationHistory ? 'Declared' : 'Notes provided'],
      ['Supporting record', details.priorVaccinationDocument ? details.priorVaccinationDocument.name : 'Not provided (optional)']
    );
  }
  return rows.filter(([, value]) => value !== undefined && value !== null && value !== '');
}

// Step 1 -> review dialog.
function proceedBooking() {
  const btn = document.getElementById('confirmBookingBtn');
  const msgEl = document.getElementById('bookingMsg');
  if (!btn || btn.disabled) return;
  const details = readBookingDetails();
  const error = validateBookingDetails(details);
  if (error) {
    if (msgEl) {
      msgEl.style.display = 'block';
      msgEl.style.background = '#fff5f5';
      msgEl.style.color = '#ef0000';
      msgEl.style.border = '1px solid #fecaca';
      msgEl.textContent = error;
    }
    return;
  }
  const slotError = timeSlotError(details.date, details.time, details.clinic);
  if (slotError) {
    if (msgEl) {
      msgEl.style.display = 'block';
      msgEl.style.background = '#fff5f5';
      msgEl.style.color = '#ef0000';
      msgEl.style.border = '1px solid #fecaca';
      msgEl.textContent = slotError;
    }
    return;
  }
  const today = new Date().toISOString().split('T')[0];
  if (details.dateOfBirth && details.dateOfBirth > today) {
    if (msgEl) { msgEl.style.display = 'block'; msgEl.style.color = '#ef0000'; msgEl.style.background = '#fff5f5'; msgEl.style.border = '1px solid #fecaca'; msgEl.textContent = 'Date of birth cannot be in the future.'; }
    return;
  }
  if (details.biteDate && details.biteDate > today) {
    if (msgEl) { msgEl.style.display = 'block'; msgEl.style.color = '#ef0000'; msgEl.style.background = '#fff5f5'; msgEl.style.border = '1px solid #fecaca'; msgEl.textContent = 'Date of bite cannot be in the future.'; }
    return;
  }
  const earliestDate = earliestBookingDate(doseLevelFromLabel(details.dose));
  if (details.date < earliestDate) {
    if (msgEl) { msgEl.style.display = 'block'; msgEl.style.color = '#ef0000'; msgEl.style.background = '#fff5f5'; msgEl.style.border = '1px solid #fecaca'; msgEl.textContent = `Dose ${doseLevelFromLabel(details.dose)} should be scheduled on or after ${earliestDate}.`; }
    return;
  }
  if (msgEl) msgEl.style.display = 'none';

  // Clear any message left over from a failed attempt on step 1, so the review
  // dialog never shows a stale error next to the details being confirmed.
  if (msgEl) msgEl.style.display = 'none';

  const summary = document.getElementById('bookingReviewSummary');
  if (summary) {
    summary.innerHTML = buildReviewRows(details)
      .map(([label, value]) => `<div class="review-row"><dt>${escapeHtml(String(label))}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
      .join('');
  }
  const reviewModal = document.getElementById('bookingReviewModal');
  reviewModal?.classList.add('open');
  reviewModal?.setAttribute('aria-hidden', 'false');
}

function withBookingTimeout(promise, operation, timeoutMs = 30000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${operation} timed out. Make sure Firebase Storage is enabled in the Firebase Console, then try again.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// Formats a Date as YYYY-MM-DD using its LOCAL calendar fields. toISOString()
// converts to UTC first, which shifts the date back a day for any timezone
// ahead of UTC (Asia/Manila is UTC+8) and made reservations expire a day early.
function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// The last day the appointment is still valid. `durationDays` is the inclusive
// grace period the clinic allows: a duration of 1 means the appointment is
// valid only on its scheduled date, 2 adds one day after it, and so on.
// Parsed as local midnight so the arithmetic cannot slip across a day boundary.
function getReservationEndDate(startDate, durationDays) {
  if (!startDate) return '';
  const parts = String(startDate).split('-').map(Number);
  if (parts.length !== 3 || parts.some(value => Number.isNaN(value))) return startDate;
  const endDate = new Date(parts[0], parts[1] - 1, parts[2]);
  endDate.setDate(endDate.getDate() + Math.max(1, Number(durationDays) || 1) - 1);
  return toLocalDateString(endDate);
}

async function confirmBooking() {
  const btn = document.getElementById('confirmBookingBtn');
  const msgEl = document.getElementById('bookingMsg');
  if (!btn || !msgEl) return;
  if (btn.disabled) return;
  const resetBookingButton = () => {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Booking';
  };

  const showError = message => {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = message;
  };

  // Read the step-1 fields and re-check them, so a booking cannot be submitted
  // by reaching step 2 and then editing a value behind the review dialog.
  const details = readBookingDetails();
  const {
    clinic, dose, date, time, address, dateOfBirth, sex,
    biteDate, animal, bitePart, woundWashed, biteType, woundPhoto, idFile,
    priorVaccinationHistory, priorVaccinationNotes, priorVaccinationDocument
  } = details;
  const returningClinic = details.returningClinic;
  const savedBooking = bookingClinicContext?.bookingWithDetails || bookingClinicContext?.previousBooking || {};

  const detailError = validateBookingDetails(details);
  if (detailError) {
    showError(detailError);
    bookingStepBack();
    return;
  }
  const recheckSlotError = timeSlotError(date, time, clinic);
  if (recheckSlotError) {
    showError(recheckSlotError);
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';

  const reservationDays = Math.min(3, Math.max(1, Number(clinic.reservationDays || 1)));
  const reservationEndDate = date ? getReservationEndDate(date, reservationDays) : '';

  try {
    const activeAppointments = await withBookingTimeout(getDocs(query(
      collection(db, 'appointments'),
      where('resident_uid', '==', currentUid)
    )), 'Checking your existing appointments');
  if (activeAppointments.docs.some(item => isActiveAcceptedAppointment(item.data()))) {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = 'You already have an active accepted appointment. Complete that visit before booking another appointment.';
    resetBookingButton();
    return;
  }

  const allowedIdTypes = ['image/jpeg', 'image/png', 'application/pdf'];
  const allowedIdExtensions = ['jpg', 'jpeg', 'png', 'pdf'];
  const maxIdSize = 5 * 1024 * 1024;

  // A Dose 2+ resident who already has an appointment or vaccination record at
  // this same clinic has already been verified there. They may upload a newer
  // ID, but do not need to do so again to continue their course.
  const sameClinicBooking = bookingClinicContext?.previousBooking?.clinic_id === clinic.id
    ? bookingClinicContext.previousBooking
    : null;
  const hasSavedId = Boolean(details.returningClinicFollowUp && sameClinicBooking?.valid_id_url);
  if (!idFile && !hasSavedId && !details.returningClinicFollowUp) {
    showError('Please upload a valid ID to complete your booking.');
    resetBookingButton();
    showBookingIdStep();
    return;
  }

  const idExtension = idFile?.name?.split('.').pop()?.toLowerCase();
  const validIdFormat = idFile && (allowedIdTypes.includes(idFile.type) || allowedIdExtensions.includes(idExtension));
  if (idFile && (!validIdFormat || idFile.size > maxIdSize)) {
    showError('The ID must be a JPG, PNG, or PDF file no larger than 5 MB.');
    resetBookingButton();
    return;
  }

  if (priorVaccinationDocument) {
    const priorExtension = priorVaccinationDocument.name?.split('.').pop()?.toLowerCase();
    const validPriorDocument = allowedIdTypes.includes(priorVaccinationDocument.type) || allowedIdExtensions.includes(priorExtension);
    if (!validPriorDocument || priorVaccinationDocument.size > 10 * 1024 * 1024) {
      showError('The previous vaccination record must be a JPG, PNG, or PDF file no larger than 10 MB.');
      resetBookingButton();
      return;
    }
  }

  // The wound photo is optional, but when one is supplied it must be a usable
  // image, otherwise clinic staff would receive a file they cannot open.
  const allowedPhotoTypes = ['image/jpeg', 'image/png'];
  const allowedPhotoExtensions = ['jpg', 'jpeg', 'png'];
  if (woundPhoto) {
    const photoExtension = woundPhoto.name?.split('.').pop()?.toLowerCase();
    const validPhoto = allowedPhotoTypes.includes(woundPhoto.type) || allowedPhotoExtensions.includes(photoExtension);
    if (!validPhoto || woundPhoto.size > maxIdSize) {
      showError('The wound photo must be a JPG or PNG file no larger than 5 MB, or leave it blank.');
      resetBookingButton();
      return;
    }
  }

  // The date floor follows the dose the resident actually picked, not the dose
  // the system would suggest. Inventory batches are restricted to clinic staff
  // by Firestore rules, so do not make a forbidden client-side inventory query -
  // the resident already sees the clinic's public availability.
  const selectedDoseLevel = doseLevelFromLabel(dose);
  const earliestDate = earliestBookingDate(selectedDoseLevel);
  if (date < earliestDate) {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = `Dose ${selectedDoseLevel} should be scheduled on or after ${earliestDate}.`;
    resetBookingButton();
    return;
  }

  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Booking...';

    // Carry an ID forward only from this clinic. An ID attached to a booking at
    // another clinic is not used to satisfy this clinic's verification flow.
    let idDownloadUrl = sameClinicBooking?.valid_id_url || '';
    let idContentType = sameClinicBooking?.valid_id_type || '';
    let idName = sameClinicBooking?.valid_id_name || '';
    if (idFile) {
      const idStorageRef = ref(storage, `id-verification/${currentUid}/${Date.now()}-${idFile.name}`);
      idContentType = idFile.type || (idExtension === 'pdf' ? 'application/pdf' : idExtension === 'png' ? 'image/png' : 'image/jpeg');
      msgEl.style.display = 'block';
      msgEl.style.background = '#eff6ff';
      msgEl.style.color = '#1d4ed8';
      msgEl.style.border = '1px solid #bfdbfe';
      msgEl.textContent = 'Uploading your valid ID...';
      const idUpload = await withBookingTimeout(uploadBytes(idStorageRef, idFile, { contentType: idContentType }), 'Uploading your valid ID');
      idDownloadUrl = await withBookingTimeout(getDownloadURL(idUpload.ref), 'Preparing your valid ID');
      idName = idFile.name;
    }

    // The wound photo is optional; clinic staff use it to assess the exposure
    // type and prepare supplies. Nothing is stored when it is left blank.
    let woundPhotoUrl = '';
    let woundPhotoName = '';
    if (woundPhoto) {
      const photoContentType = woundPhoto.type || (woundPhoto.name?.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
      const photoRef = ref(storage, `wound-photos/${currentUid}/${Date.now()}-${woundPhoto.name}`);
      msgEl.style.display = 'block';
      msgEl.style.background = '#eff6ff';
      msgEl.style.color = '#1d4ed8';
      msgEl.style.border = '1px solid #bfdbfe';
      msgEl.textContent = 'Uploading your wound photo...';
      const photoUpload = await withBookingTimeout(uploadBytes(photoRef, woundPhoto, { contentType: photoContentType }), 'Uploading your wound photo');
      woundPhotoUrl = await withBookingTimeout(getDownloadURL(photoUpload.ref), 'Preparing your wound photo');
      woundPhotoName = woundPhoto.name;
    }

    // This optional document may be from a past incident or another clinic.
    // Keep it on the resident profile and copy its reference to this booking.
    let priorDocumentUrl = '';
    let priorDocumentName = '';
    let priorDocumentType = '';
    let priorDocumentPath = '';
    if (priorVaccinationDocument) {
      priorDocumentType = priorVaccinationDocument.type || 'application/octet-stream';
      const priorRef = ref(storage, `vaccination-documents/${currentUid}/${Date.now()}-${priorVaccinationDocument.name}`);
      msgEl.textContent = 'Uploading previous vaccination record...';
      const priorUpload = await withBookingTimeout(uploadBytes(priorRef, priorVaccinationDocument, { contentType: priorDocumentType }), 'Uploading previous vaccination record');
      priorDocumentUrl = await withBookingTimeout(getDownloadURL(priorUpload.ref), 'Preparing previous vaccination record');
      priorDocumentName = priorVaccinationDocument.name;
      priorDocumentPath = priorRef.fullPath;
    }
    msgEl.textContent = 'Saving your appointment...';
    const appointmentRef = await withBookingTimeout(addDoc(collection(db, 'appointments'), {
      resident_uid: currentUid,
      resident_name: currentResidentName,
      resident_email: residentProfile.email || auth.currentUser?.email || '',
      clinic_id: clinic.id,
      clinic_name: clinic.name,
      clinic_address: clinic.address || '',
      clinic_staff_uid: clinic.staff_uid || '',
      vaccination_session_id: bookingClinicContext?.newVaccinationSessionId || currentVaccinationSessionId || 'legacy',
      primary_clinic_id: bookingClinicContext?.primaryClinicId || clinic.id,
      primary_clinic_name: window.clinicDirectory?.find(item => item.id === (bookingClinicContext?.primaryClinicId || clinic.id))?.name || clinic.name,
      clinic_changed_for_dose: Boolean(bookingClinicContext?.primaryClinicId && clinic.id !== bookingClinicContext.primaryClinicId),
      dose_label: dose,
      vaccine_name: latestVaccineBrand || '',
      preferred_date: date,
      reservation_days: reservationDays,
      reservation_end_date: reservationEndDate,
      preferred_time: time,
      resident_address: address,
      date_of_birth: dateOfBirth || savedBooking.date_of_birth || null,
      patient_sex: sex || savedBooking.patient_sex || '',
      bite_date: biteDate || savedBooking.bite_date || '',
      animal_type: animal || savedBooking.animal_type || '',
      bite_body_part: bitePart || savedBooking.bite_body_part || '',
      valid_id_url: idDownloadUrl,
      valid_id_name: idName,
      valid_id_type: idContentType,
      // Optional; empty when the resident skipped it (e.g. a wound that cannot
      // be photographed). Staff still see the exposure type they selected.
      wound_photo_url: woundPhotoUrl,
      wound_photo_name: woundPhotoName,
      prior_vaccination_history_declared: priorVaccinationHistory,
      prior_vaccination_history_notes: priorVaccinationNotes,
      prior_vaccination_document_url: priorDocumentUrl,
      prior_vaccination_document_name: priorDocumentName,
      prior_vaccination_document_type: priorDocumentType,
      // carried forward from an earlier booking in this course when available
      patient_category: savedBooking.patient_category || '',
      wound_washed: woundWashed || savedBooking.wound_washed || '',
      bite_type: biteType || savedBooking.bite_type || '',
      // This immutable snapshot is deliberately copied to every appointment
      // in the course so a receiving clinic can review it without querying a
      // clinic it does not belong to.
      course_intake_data: {
        resident_address: address,
        date_of_birth: dateOfBirth || savedBooking.date_of_birth || '',
        patient_sex: sex || savedBooking.patient_sex || '',
        bite_date: biteDate || savedBooking.bite_date || '',
        animal_type: animal || savedBooking.animal_type || '',
        bite_body_part: bitePart || savedBooking.bite_body_part || '',
        patient_category: savedBooking.patient_category || '',
        wound_washed: woundWashed || savedBooking.wound_washed || '',
        bite_type: biteType || savedBooking.bite_type || ''
      },
      course_vaccination_history: buildCourseHistory(),
      status: 'pending',
      created_at: serverTimestamp()
    }), 'Saving your appointment');

    await updateDoc(doc(db, 'residents', currentUid), {
      address,
      birthday: dateOfBirth,
      gender: sex,
      prior_vaccination_history_declared: priorVaccinationHistory || Boolean(residentProfile.prior_vaccination_history_declared),
      prior_vaccination_history_notes: priorVaccinationNotes || residentProfile.prior_vaccination_history_notes || '',
      prior_vaccination_document_url: priorDocumentUrl || residentProfile.prior_vaccination_document_url || '',
      prior_vaccination_document_name: priorDocumentName || residentProfile.prior_vaccination_document_name || '',
      updated_at: serverTimestamp()
    });
    if (priorDocumentUrl) {
      await addDoc(collection(db, 'vaccination_documents'), {
        resident_uid: currentUid,
        appointment_id: appointmentRef.id,
        document_category: 'prior_vaccination_history',
        file_name: priorDocumentName,
        file_type: priorDocumentType,
        file_size: priorVaccinationDocument.size,
        storage_path: priorDocumentPath,
        download_url: priorDocumentUrl,
        uploaded_at: serverTimestamp()
      });
    }
    residentProfile = { ...residentProfile, address, birthday: dateOfBirth, gender: sex,
      prior_vaccination_history_declared: priorVaccinationHistory || Boolean(residentProfile.prior_vaccination_history_declared),
      prior_vaccination_document_url: priorDocumentUrl || residentProfile.prior_vaccination_document_url || '' };

    if (clinic.staff_uid) {
      await withBookingTimeout(addDoc(collection(db, 'notifications'), {
        recipient_uid: clinic.staff_uid,
        user_id: clinic.staff_uid,
        clinic_id: clinic.id,
        appointment_id: appointmentRef.id,
        type: 'appointment',
        title: 'New appointment request',
        message: `${currentResidentName} requested an appointment on ${date} at ${time}.`,
        read: false,
        created_at: serverTimestamp()
      }), 'Sending the clinic notification');
    }

    msgEl.style.display = 'block';
    msgEl.style.background = '#f0fdf4';
    msgEl.style.color = '#16a34a';
    msgEl.style.border = '1px solid #bbf7d0';
    msgEl.textContent = 'Appointment booked! Waiting for clinic confirmation.';

    setTimeout(() => {
      closeBookingModal();
      loadResidentBookings(currentUid);
      msgEl.style.display = 'none';
    }, 2000);
  } catch (err) {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = 'Booking failed: ' + err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Booking';
  }
}

function filterMap(btn) {
  document.querySelectorAll('.map-filter button').forEach(b => b.classList.remove('active-btn'));
  btn.classList.add('active-btn');
}

async function handleUpload(input) {
  const file = input.files[0];
  if (!file || !currentUid) return;
  if (new Set(residentVaccinationRecords.map(record => Number(record.dose_number || 0))).size < doseDayOffsets.length) {
    alert('You can upload a vaccination document only after all 5 doses are recorded.');
    input.value = '';
    return;
  }
  if (clinic.status === 'out') {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = 'This clinic is out of stock. Please choose another clinic with vaccines available.';
    resetBookingButton();
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    alert('Please choose a file smaller than 10 MB.');
    input.value = '';
    return;
  }
  const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
  if (!allowedTypes.includes(file.type)) {
    alert('Please upload a PDF, JPG, or PNG file.');
    input.value = '';
    return;
  }
  const uploadBox = document.querySelector('.upload-box p');
  const replaceId = input.dataset.replaceId || '';
  if (uploadBox) uploadBox.textContent = 'Uploading document...';
  try {
    const storageRef = ref(storage, `vaccination-documents/${currentUid}/${Date.now()}-${file.name}`);
    await uploadBytes(storageRef, file, { contentType: file.type });
    const downloadUrl = await getDownloadURL(storageRef);
    const documentData = {
      id: replaceId || `local-${Date.now()}`,
      resident_uid: currentUid,
      vaccination_session_id: currentVaccinationSessionId,
      file_name: file.name,
      file_type: file.type,
      file_size: file.size,
      storage_path: storageRef.fullPath,
      download_url: downloadUrl,
      uploaded_at: serverTimestamp()
    };
    if (replaceId) {
      await updateDoc(doc(db, 'vaccination_documents', replaceId), documentData);
    } else {
      await addDoc(collection(db, 'vaccination_documents'), documentData);
    }
    localStorage.setItem(`vaccination-document-${currentUid}`, JSON.stringify({
      ...documentData,
      uploaded_at: { localDate: new Date().toLocaleString() }
    }));
    loadVaccinationDocuments(currentUid);
    alert(replaceId ? 'Vaccination document replaced successfully.' : 'Vaccination document uploaded successfully.');
  } catch (error) {
    console.error('Failed to upload vaccination document:', error);
    alert('Could not upload the document: ' + error.message);
  } finally {
    if (uploadBox) uploadBox.textContent = 'Click to upload or drag & drop';
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

document.addEventListener('DOMContentLoaded', function() {
  const clinicSelect = document.getElementById('modalClinic');
  const doseSelect = document.getElementById('modalDose');
  const clinicChangeModal = document.getElementById('clinicChangeModal');
  const closeClinicChange = () => {
    clinicChangeModal?.classList.remove('open');
    clinicChangeModal?.setAttribute('aria-hidden', 'true');
  };
  clinicSelect?.addEventListener('change', () => {
    const primaryClinicId = bookingClinicContext?.primaryClinicId;
    const selectedId = clinicSelect.value;
    if (!primaryClinicId || selectedId === primaryClinicId || selectedId === confirmedClinicChangeId) return;
    pendingClinicChangeId = selectedId;
    clinicChangeModal?.classList.add('open');
    clinicChangeModal?.setAttribute('aria-hidden', 'false');
  });
  clinicSelect?.addEventListener('change', updateBookingIdRequirement);
  // Switching dose level moves the earliest bookable date, because doses 2-5
  // are anchored to the start of the course. Re-anchor the date input, but only
  // when the chosen date would otherwise fall before that floor.
  doseSelect?.addEventListener('change', () => {
    selectedDose = doseSelect.value;
    const el = document.getElementById('modalDate');
    if (!el) return;
    const floor = earliestBookingDate(doseLevelFromLabel(doseSelect.value));
    el.min = floor;
    if (!el.value || el.value < floor) el.value = floor;
    refreshTimeSlots();
    updateBookingIdRequirement();
  });
  // A different date can turn today's passed slots into valid ones, and another
  // clinic may open or close at a different time, so both re-filter the list.
  document.getElementById('modalDate')?.addEventListener('change', refreshTimeSlots);
  clinicSelect?.addEventListener('change', refreshTimeSlots);
  // Review dialog: "Go back and edit" returns to step 1, "Yes, continue"
  // reveals the mandatory Valid ID step.
  const reviewModal = document.getElementById('bookingReviewModal');
  document.getElementById('reviewBackBtn')?.addEventListener('click', () => {
    reviewModal?.classList.remove('open');
    reviewModal?.setAttribute('aria-hidden', 'true');
  });
  document.getElementById('reviewConfirmBtn')?.addEventListener('click', showBookingIdStep);
  reviewModal?.addEventListener('click', event => {
    if (event.target === reviewModal) {
      reviewModal.classList.remove('open');
      reviewModal.setAttribute('aria-hidden', 'true');
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && reviewModal?.classList.contains('open')) {
      reviewModal.classList.remove('open');
      reviewModal.setAttribute('aria-hidden', 'true');
    }
  });
  document.getElementById('cancelClinicChangeBtn')?.addEventListener('click', () => {
    if (clinicSelect && bookingClinicContext?.primaryClinicId) clinicSelect.value = bookingClinicContext.primaryClinicId;
    pendingClinicChangeId = '';
    closeClinicChange();
  });
  document.getElementById('confirmClinicChangeBtn')?.addEventListener('click', () => {
    confirmedClinicChangeId = pendingClinicChangeId;
    pendingClinicChangeId = '';
    closeClinicChange();
  });
  clinicChangeModal?.addEventListener('click', event => {
    if (event.target === clinicChangeModal) document.getElementById('cancelClinicChangeBtn')?.click();
  });
  document.getElementById('closeRescheduleBtn')?.addEventListener('click', () => document.getElementById('rescheduleModal').classList.remove('open'));
  document.getElementById('saveRescheduleBtn')?.addEventListener('click', saveReschedule);
  document.getElementById('closeCancelBtn')?.addEventListener('click', () => document.getElementById('cancelModal').classList.remove('open'));
  document.getElementById('saveCancelBtn')?.addEventListener('click', saveCancellation);
  const profileModal = document.getElementById('profileModal');
  const profileMessage = document.getElementById('profileMessage');
  const openProfile = () => {
    profileModal.classList.add('open');
    profileModal.setAttribute('aria-hidden', 'false');
  };
  const closeProfile = () => {
    profileModal.classList.remove('open');
    profileModal.setAttribute('aria-hidden', 'true');
  };
  document.getElementById('profileBtn')?.addEventListener('click', openProfile);
  document.getElementById('profileClose')?.addEventListener('click', closeProfile);
  profileModal?.addEventListener('click', event => {
    if (event.target === profileModal) closeProfile();
  });
  document.getElementById('profileForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!currentUid) return;
    const username = document.getElementById('profileUsername').value.trim();
    if (!username) return;
    const saveButton = event.currentTarget.querySelector('.profile-save-btn');
    saveButton.disabled = true;
    profileMessage.textContent = 'Saving profile...';
    profileMessage.style.color = '#6b7280';
    try {
      await updateDoc(doc(db, 'residents', currentUid), {
        username,
        phone: document.getElementById('profilePhone').value.trim(),
        birthday: document.getElementById('profileBirthday').value,
        gender: document.getElementById('profileGender').value,
        address: document.getElementById('profileAddress').value.trim()
      });
      residentProfile = {
        ...residentProfile,
        username,
        phone: document.getElementById('profilePhone').value.trim(),
        birthday: document.getElementById('profileBirthday').value,
        gender: document.getElementById('profileGender').value,
        address: document.getElementById('profileAddress').value.trim()
      };
      currentResidentName = username;
      const headerName = document.getElementById('headerName');
      if (headerName) headerName.textContent = username;
      profileMessage.textContent = 'Profile saved successfully.';
      profileMessage.style.color = '#15803d';
    } catch (error) {
      profileMessage.textContent = 'Could not save profile: ' + error.message;
      profileMessage.style.color = '#b91c1c';
    } finally {
      saveButton.disabled = false;
    }
  });

  document.getElementById('bookingModal')?.addEventListener('click', function(e) {
    if (e.target === this) closeBookingModal();
  });

  // Bind the booking buttons directly instead of relying only on the inline
  // onclick attributes below. Module scripts are deferred, so this block can run
  // after DOMContentLoaded has already fired - in which case the window.* bridge
  // is never reached and every inline onclick is dead. Direct listeners keep the
  // booking flow working either way.
  // One button serves both steps, so it dispatches on the active step. Binding
  // it to proceedBooking alone would make "Confirm Booking" reopen the review
  // dialog forever and never submit.
  document.getElementById('confirmBookingBtn')?.addEventListener('click', bookingPrimaryAction);
  document.getElementById('bookingBackBtn')?.addEventListener('click', bookingStepBack);
  document.getElementById('bookingCancelBtn')?.addEventListener('click', closeBookingModal);

  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', () => {
    signOutUser().then(() => window.location.href = 'login.html');
  });

  // Expose some functions to window for inline onclick attributes (module scope isn't global).
  // This block only runs when the handler above actually fires, so the booking
  // buttons are also bound directly - see the listeners above.
  window.showTab = showTab;
  window.openBookingModal = openBookingModal;
  window.closeBookingModal = closeBookingModal;
  window.confirmBooking = confirmBooking;
  // The booking form is a two-step flow: Proceed validates the details and opens
  // the review dialog, Back returns from the Valid ID step to the details.
  window.proceedBooking = proceedBooking;
  window.confirmBookingPrimary = confirmBooking;
  window.bookingPrimaryAction = bookingPrimaryAction;
  window.bookingStepBack = bookingStepBack;
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
  notificationsCard?.addEventListener('click', () => showTab('notifications', document.getElementById('nav-notif')));

  onAuthStateChanged(auth, (user) => {
    if (user) {
      fetchUserProfile(user.uid).then((profile) => {
        if (!profile || profile.role !== 'resident') {
          alert('This account does not have resident access.');
          signOutUser().then(() => window.location.href = 'login.html');
          return;
        }
        loadResidentDashboard(user.uid, profile);
      });
    } else {
      window.location.href = 'login.html';
    }
  });

  if (location.hash === '#panel-appointments') {
    const apptTab = document.querySelectorAll('.nav-tab')[1];
    if (apptTab) showTab('appointments', apptTab);
  }
  renderCasesChart();
  setTimeout(renderResVizChart, 300);
});
