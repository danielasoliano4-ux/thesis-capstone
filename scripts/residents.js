import { auth, db, storage, fetchUserProfile, onAuthStateChanged, signOutUser } from './firebase.js';
import { doc, getDoc, updateDoc, collection, query, where, getDocs, addDoc, onSnapshot, serverTimestamp, orderBy } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-storage.js";

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
let bookingClinicContext = null;
let currentVaccinationSessionId = '';
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
      const icon = notification.title?.toLowerCase().includes('reminder') ? 'fa-calendar-check' : type === 'vaccine' ? 'fa-syringe' : 'fa-circle-check';
      return `<div class="notif-item${notification.read ? '' : ' unread'}" data-id="${escapeHtml(notification.id)}" data-type="${escapeHtml(type)}" style="background:white;border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px;margin-bottom:10px;display:flex;gap:14px;align-items:flex-start;position:relative;">
        <div class="notif-icon icon-blue" style="width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#dbeafe;color:#2563eb;"><i class="fa-solid ${icon}"></i></div>
        <div class="notif-body" style="flex:1;min-width:0;"><h4 style="font-size:14px;font-weight:600;color:#111827;margin:0 0 4px;">${escapeHtml(notification.title || 'Notification')}</h4><p style="margin:0;font-size:13px;color:#4b5563;line-height:1.5;">${escapeHtml(notification.message || notification.body || '')}</p><div class="notif-meta" style="display:flex;align-items:center;gap:12px;margin-top:8px;flex-wrap:wrap;"><span class="notif-time" style="font-size:12px;color:#9ca3af;"><i class="fa-regular fa-clock"></i> ${escapeHtml(createdAt)}</span><span class="notif-tag tag-${escapeHtml(type)}">${escapeHtml(type)}</span></div></div>
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
  originalDoseClinicId = latestRecord?.clinic_id || '';
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
  const orderedClinics = originalDoseClinicId
    ? [...clinics].sort((first, second) => Number(second.id === originalDoseClinicId) - Number(first.id === originalDoseClinicId))
    : clinics;
  const select = document.getElementById('modalClinic');
  if (select) {
    select.innerHTML = '';
    orderedClinics.forEach((clinic) => {
      const option = document.createElement('option');
      option.value = clinic.id;
      const optionStatus = clinic.status === 'out'
        ? 'Out of Stock'
        : `${clinic.status === 'low' ? 'Low Stock' : 'Available'} - ${clinic.stock_total || 0} doses available`;
      option.textContent = `${clinic.name} (${clinic.type}) - ${optionStatus}`;
      option.dataset.name = clinic.name;
      select.appendChild(option);
    });
  }
  renderClinicBookingList(orderedClinics);
  populateClinicFilters(clinics);
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
      originalDoseClinicId = latestRecord?.clinic_id || '';

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
        <div class="booking-progress-card"><div class="booking-progress-heading"><div><strong>${escapeHtml(booking.clinic_name || 'Clinic')}</strong><div>${escapeHtml(booking.preferred_date || '')} at ${escapeHtml(booking.preferred_time || '')} · ${escapeHtml(booking.dose_label || 'Dose 1')}</div></div><span class="booking-status status-${escapeHtml(status || 'pending')}">${status === 'confirmed' ? 'Confirmed' : status === 'completed' ? 'Completed' : status === 'declined' ? 'Declined' : status === 'expired' ? 'Expired' : 'Pending clinic review'}</span></div>
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
      return `<div class="dose-record"><div class="dose-circle done-circle"><i class="fa-solid fa-check"></i></div><div class="dose-record-info"><h4>Dose ${doseNumber} — Day ${dayOffset}</h4><p>${escapeHtml(date)} | ${escapeHtml(clinic)}${escapeHtml(location)} | ${escapeHtml(vaccine)}${escapeHtml(administrator)}</p></div><div class="dose-record-status"><span class="r-done">Completed</span></div></div>`;
    }
    if (booking && ['pending', 'confirmed'].includes(booking.status)) {
      return `<div class="dose-record"><div class="dose-circle next-circle"><i class="fa-regular fa-calendar"></i></div><div class="dose-record-info"><h4>Dose ${doseNumber} — Day ${dayOffset}</h4><p>Scheduled: ${escapeHtml(booking.preferred_date || '')} at ${escapeHtml(booking.preferred_time || '')} | ${escapeHtml(booking.clinic_name || 'Clinic')}</p></div><div class="dose-record-status"><span class="r-next">${booking.status === 'confirmed' ? 'Confirmed' : 'Upcoming'}</span></div></div>`;
    }
    return `<div class="dose-record"><div class="dose-circle pending-circle">${doseNumber}</div><div class="dose-record-info"><h4>Dose ${doseNumber} — Day ${dayOffset}</h4><p>Not yet scheduled</p></div><div class="dose-record-status"><span class="r-pending">Pending</span></div></div>`;
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
  if (progressLabel) progressLabel.textContent = `Treatment Progress — ${completedDoseCount} of ${total} doses`;
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
    const documentMarkup = index === 0 && residentVaccinationDocuments.length
      ? `<div class="previous-record-documents"><strong>Uploaded documents</strong>${residentVaccinationDocuments.map(document => renderDocumentPreview(document)).join('')}</div>`
      : '';
    return `<details class="previous-record-card"><summary><div class="previous-record-main"><div class="previous-record-title-row"><strong>Vaccination Record — ${escapeHtml(first.clinic_name || 'Previous clinic')}</strong><span class="previous-completed-badge">${percent}% Complete</span></div><small>Started ${escapeHtml(formatRecordDate(first.date_given))} | ${completed} / 5 doses</small><div class="previous-progress-track"><span style="width:${percent}%;"></span></div></div><div class="previous-record-progress"><b>${percent}%</b><small>complete</small></div><i class="fa-solid fa-chevron-down previous-record-chevron"></i></summary><div class="previous-dose-list"><strong>Completed doses</strong>${ordered.map(record => `<span><i class="fa-solid fa-check"></i> Dose ${escapeHtml(record.dose_number)}: ${escapeHtml(formatRecordDate(record.date_given))} | ${escapeHtml(record.clinic_name || 'Clinic')}</span>`).join('')}</div>${documentMarkup}</details>`;
  }).join('')}`;
}

function renderDocumentPreview(document) {
  const isImage = document.file_type?.startsWith('image/')
    || /\.(jpe?g|png)(?:[?#]|$)/i.test(document.file_name || '')
    || /\.(jpe?g|png)(?:[?#]|&|$)/i.test(document.download_url || '');
  return `<div class="previous-document-preview">${isImage ? `<img src="${escapeHtml(document.download_url || '')}" alt="Uploaded vaccination document">` : '<i class="fa-regular fa-file-lines"></i>'}<div><strong>${escapeHtml(document.file_name || 'Vaccination document')}</strong><a href="${escapeHtml(document.download_url || '#')}" target="_blank" rel="noopener">Open document</a></div></div>`;
}

function loadVaccinationDocuments(uid) {
  const container = document.getElementById('vaccinationDocuments');
  if (!container) return;
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
        <div class="document-preview-wrap">${isImage ? `<img class="document-preview" src="${escapeHtml(document.download_url || '')}" alt="Uploaded vaccination document">` : '<i class="fa-regular fa-file-lines document-file-icon"></i>'}<button type="button" class="document-edit-button" data-document-id="${escapeHtml(document.id)}" title="Replace uploaded document" aria-label="Replace uploaded document"><i class="fa-solid fa-pencil"></i></button></div>
        <div class="document-summary-text"><strong>${escapeHtml(document.file_name || 'Vaccination document')}</strong><small>${escapeHtml(document.file_type || 'File')} | ${escapeHtml(document.uploaded_at?.toDate ? document.uploaded_at.toDate().toLocaleDateString() : 'Uploaded')}</small></div>
        <div class="document-details"><p><strong>File:</strong> ${escapeHtml(document.file_name || 'Not available')}</p><p><strong>Uploaded:</strong> ${escapeHtml(document.uploaded_at?.toDate ? document.uploaded_at.toDate().toLocaleString() : 'Not available')}</p><a href="${escapeHtml(document.download_url || '#')}" target="_blank" rel="noopener">Open full document <i class="fa-solid fa-arrow-up-right-from-square"></i></a></div>
      </div>`;
    }).join('')}`;
    container.querySelectorAll('.document-edit-button').forEach(button => button.addEventListener('click', () => {
      const input = document.getElementById('fileUpload');
      if (!input) return;
      input.dataset.replaceId = button.dataset.documentId;
      input.click();
    }));
  };
  const renderDocuments = snapshot => {
    const documents = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    if (documents.length) {
      renderDocumentList(documents);
      return;
    }
    try {
      const savedDocument = JSON.parse(localStorage.getItem(`vaccination-document-${uid}`) || 'null');
      renderDocumentList(savedDocument?.download_url ? [savedDocument] : []);
    } catch (error) {
      renderDocumentList([]);
    }
  };
  container.innerHTML = '<p class="documents-loading">Loading uploaded document...</p>';
  try {
    const savedDocument = JSON.parse(localStorage.getItem(`vaccination-document-${uid}`) || 'null');
    if (savedDocument?.download_url) renderDocumentList([savedDocument]);
  } catch (error) {
    console.warn('Could not restore local vaccination document preview:', error);
  }
  getDocs(documentsQuery).then(renderDocuments).catch(error => {
    console.error('Failed to load vaccination documents:', error);
    container.innerHTML = `<p class="document-error">Could not load uploaded documents: ${escapeHtml(error.message)}</p>`;
  });
  onSnapshot(documentsQuery, renderDocuments, error => {
    console.error('Failed to listen for vaccination documents:', error);
    if (!container.querySelector('.vaccination-document')) {
      container.innerHTML = `<p class="document-error">Could not load uploaded documents: ${escapeHtml(error.message)}</p>`;
    }
  });
}

function renderUpcomingAppointments(bookings) {
  const container = document.getElementById('upcomingAppointmentsList');
  if (!container) return;
  const today = new Date().toISOString().split('T')[0];
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
  const upcoming = sorted.filter(booking => ['pending', 'confirmed', 'in_progress'].includes(appointmentStatus(booking)));
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
    return `<div class="appt-card ${isCompleted ? 'completed' : 'upcoming'}"><div class="appt-card-date"><div class="big-day">${escapeHtml(String(day))}</div><div class="month-yr">${escapeHtml(monthYear)}</div></div><div class="appt-card-body"><div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;"><h3>Dose ${escapeHtml(dose)} – ${escapeHtml(vaccine)} Vaccination</h3><span class="appt-status ${isCompleted ? 'status-done' : status === 'expired' ? 'status-expired' : 'status-upcoming'}">${isCompleted ? 'Completed' : status === 'expired' ? 'Expired' : status === 'confirmed' ? 'Confirmed' : 'Pending'}</span></div><p><i class="fa-solid fa-hospital" style="color:#6b7280;"></i> ${escapeHtml(booking.clinic_name || 'Clinic not specified')}</p><p><i class="fa-regular fa-clock" style="color:#6b7280;"></i> ${escapeHtml(detail)}</p>${!isCompleted && status !== 'expired' ? `<div class="appt-card-actions"><button class="action-btn reschedule-button" data-appointment-id="${escapeHtml(booking.id)}"><i class="fa-solid fa-arrows-rotate"></i> Reschedule</button><button class="action-btn danger cancel-appointment-button" data-appointment-id="${escapeHtml(booking.id)}"><i class="fa-solid fa-xmark"></i> Cancel</button></div>` : ''}</div></div>`;
  };
  if (upcomingContainer) upcomingContainer.innerHTML = upcoming.length ? upcoming.map(booking => renderCard(booking, false)).join('') : '<p style="font-size:13px;color:#6b7280;padding:10px 0;">No upcoming appointments.</p>';
  if (completedContainer) completedContainer.innerHTML = completed.length ? completed.map(booking => renderCard(booking, true)).join('') : '<p style="font-size:13px;color:#6b7280;padding:10px 0;">No completed appointments yet.</p>';
  document.querySelectorAll('.reschedule-button').forEach(button => button.addEventListener('click', () => openRescheduleModal(bookings.find(booking => booking.id === button.dataset.appointmentId))));
  document.querySelectorAll('.cancel-appointment-button').forEach(button => button.addEventListener('click', () => openCancelModal(bookings.find(booking => booking.id === button.dataset.appointmentId))));
}

function updateNextAppointmentSummary(bookings) {
  const element = document.getElementById('activeNextAppt');
  if (!element) return;
  const today = new Date().toISOString().split('T')[0];
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
  chart.innerHTML = `<div class="animal-donut" style="background:conic-gradient(${stops});"><div><strong>${escapeHtml(animals[0].percent)}%</strong><small>${escapeHtml(animals[0].name)}</small></div></div><div class="donut-legend">${animals.map((animal, index) => `<div class="donut-legend-item"><span class="donut-dot" style="background:${colors[index % colors.length]};"></span> ${escapeHtml(animal.name)} — ${escapeHtml(animal.percent)}%</div>`).join('')}</div>`;
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
    renderAnalyticsList('ageGroupChart', data.ageGroups, (value, index) => `<div class="age-row"><span class="age-label">${['0–9','10–19','20–39','40–59','60+'][index]}</span><div class="age-bar-wrap"><div class="age-bar-fill" style="width:${Math.round((Number(value) || 0) / maxAge * 100)}%;"></div></div><span class="age-count">${escapeHtml(value)}</span></div>`);
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
  if (document.getElementById('progressLabel')) document.getElementById('progressLabel').textContent = `Treatment Progress — ${doses} of ${total} doses`;
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

function openBookingModal(clinic, clinicId = '') {
  const startsNewVaccination = completedDoseCount >= doseDayOffsets.length;
  const sel = document.getElementById('modalClinic');
  if (sel && clinicId) {
    sel.value = clinicId;
  } else if (clinic && sel) {
    const option = [...sel.options].find(item => item.dataset.name === clinic || item.text.startsWith(clinic));
    if (option) sel.value = option.value;
  }
  selectedClinic = window.clinicDirectory?.find(item => item.id === sel?.value) || null;
  const clinicBookings = residentAppointments
    .filter(item => item.clinic_id === sel?.value && item.status !== 'declined')
    .sort((first, second) => String(second.created_at?.toMillis?.() || '').localeCompare(String(first.created_at?.toMillis?.() || '')));
  const previousBooking = clinicBookings[0];
  const bookingWithDetails = clinicBookings.find(item => item.bite_date && item.animal_type && item.bite_body_part) || previousBooking;
  bookingClinicContext = { clinicId: sel?.value || '', previousBooking, bookingWithDetails };
  const returningClinic = Boolean(previousBooking);
  const saved = {
    address: residentProfile.address || previousBooking?.resident_address || '',
    dateOfBirth: residentProfile.birthday || previousBooking?.date_of_birth || '',
    sex: residentProfile.gender || previousBooking?.patient_sex || '',
    biteDate: bookingWithDetails?.bite_date || '',
    animal: bookingWithDetails?.animal_type || '',
    bitePart: bookingWithDetails?.bite_body_part || ''
  };
  document.getElementById('modalAddress').value = saved.address;
  document.getElementById('modalDateOfBirth').value = saved.dateOfBirth;
  document.getElementById('modalSex').value = saved.sex;
  document.getElementById('modalBiteDate').value = saved.biteDate;
  document.getElementById('modalAnimal').value = saved.animal;
  document.getElementById('modalBitePart').value = saved.bitePart;
  document.getElementById('bookingPatientDetails').hidden = returningClinic;
  document.getElementById('bookingIdField').hidden = returningClinic;
  document.getElementById('returningClinicMessage').hidden = !returningClinic;
  document.getElementById('modalAddress').readOnly = returningClinic;
  document.getElementById('modalDateOfBirth').required = !returningClinic;
  document.getElementById('modalSex').required = !returningClinic;
  document.getElementById('modalBiteDate').required = !returningClinic;
  document.getElementById('modalAnimal').required = !returningClinic;
  document.getElementById('modalBitePart').required = !returningClinic;
  document.getElementById('modalValidId').required = !returningClinic;
  const dateEl = document.getElementById('modalDate');
  const doseSelect = document.getElementById('modalDose');
  const nextDose = startsNewVaccination ? 1 : Math.min(5, completedDoseCount + 1);
  if (startsNewVaccination) {
    currentVaccinationSessionId = crypto.randomUUID();
    bookingClinicContext.newVaccinationSessionId = currentVaccinationSessionId;
  }
  if (doseSelect) {
    doseSelect.value = `Dose ${nextDose} (Day ${doseDayOffsets[nextDose - 1]})`;
    [...doseSelect.options].forEach(option => {
      const optionDose = Number(String(option.value || option.textContent).match(/\d+/)?.[0] || 0);
      option.hidden = optionDose !== nextDose;
    });
  }
  if (dateEl) {
    const suggestedDate = firstDoseDate && nextDose > 1
      ? formatInputDate(firstDoseDate, doseDayOffsets[nextDose - 1])
      : new Date().toISOString().split('T')[0];
    dateEl.value = suggestedDate;
    dateEl.min = suggestedDate;
  }
  document.getElementById('bookingModal').classList.add('open');
}

function closeBookingModal() {
  document.getElementById('bookingModal').classList.remove('open');
}

function withBookingTimeout(promise, operation, timeoutMs = 30000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${operation} timed out. Make sure Firebase Storage is enabled in the Firebase Console, then try again.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function getReservationEndDate(startDate, durationDays) {
  const endDate = new Date(`${startDate}T00:00:00`);
  endDate.setDate(endDate.getDate() + Math.max(1, Number(durationDays || 1)) - 1);
  return endDate.toISOString().split('T')[0];
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
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';

  const clinicSelect = document.getElementById('modalClinic');
  const clinicId = clinicSelect.value;
  const clinic = window.clinicDirectory?.find(item => item.id === clinicId) || selectedClinic;
  const dose = document.getElementById('modalDose').value;
  const date = document.getElementById('modalDate').value;
  const time = document.getElementById('modalTime').value;
  const address = document.getElementById('modalAddress').value.trim();
  const dateOfBirth = document.getElementById('modalDateOfBirth').value;
  const sex = document.getElementById('modalSex').value;
  const biteDate = document.getElementById('modalBiteDate').value;
  const animal = document.getElementById('modalAnimal').value;
  const bitePart = document.getElementById('modalBitePart').value.trim();
  const returningClinic = bookingClinicContext?.clinicId === clinicId && Boolean(bookingClinicContext.previousBooking);
  const savedBooking = bookingClinicContext?.bookingWithDetails || bookingClinicContext?.previousBooking || {};

  if (!clinic) {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = 'Please select an available clinic before booking.';
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Booking';
    return;
  }

  const reservationDays = Math.min(3, Math.max(1, Number(clinic.reservationDays || 1)));
  const reservationEndDate = date ? getReservationEndDate(date, reservationDays) : '';

  try {
    const activeAppointments = await withBookingTimeout(getDocs(query(
      collection(db, 'appointments'),
      where('resident_uid', '==', currentUid)
    )), 'Checking your existing appointments');
  if (activeAppointments.docs.some(item => ['confirmed', 'in_progress'].includes(item.data().status))) {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = 'You already have an active accepted appointment. Complete that visit before booking another appointment.';
    resetBookingButton();
    return;
  }

  const idInput = document.getElementById('modalValidId');
  const idFile = idInput?.files?.[0];
  const allowedIdTypes = ['image/jpeg', 'image/png', 'application/pdf'];
  const allowedIdExtensions = ['jpg', 'jpeg', 'png', 'pdf'];
  const maxIdSize = 5 * 1024 * 1024;

  if (!date || (!returningClinic && (!address || !dateOfBirth || !sex || !biteDate || !animal || !bitePart || !idFile))) {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = !date ? 'Please select a preferred date.' : !address ? 'Please provide your address.' : !dateOfBirth ? 'Please enter your date of birth.' : !sex ? 'Please select your sex.' : !biteDate ? 'Please enter the date of the bite.' : !animal ? 'Please select the animal that bit you.' : !bitePart ? 'Please enter the body part of the bite.' : 'Please upload a valid ID.';
    resetBookingButton();
    return;
  }
  const idExtension = idFile?.name?.split('.').pop()?.toLowerCase();
  const validIdFormat = idFile && (allowedIdTypes.includes(idFile.type) || allowedIdExtensions.includes(idExtension));
  if (idFile && (!validIdFormat || idFile.size > maxIdSize)) {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = 'The ID must be a JPG, PNG, or PDF file no larger than 5 MB.';
    resetBookingButton();
    return;
  }
  if (dateOfBirth > new Date().toISOString().split('T')[0] || biteDate > new Date().toISOString().split('T')[0]) {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = dateOfBirth > new Date().toISOString().split('T')[0] ? 'Date of birth cannot be in the future.' : 'Date of bite cannot be in the future.';
    resetBookingButton();
    return;
  }

  const nextDose = completedDoseCount >= doseDayOffsets.length ? 1 : Math.min(5, completedDoseCount + 1);
  if (nextDose > 1 && latestVaccineBrand && clinic.id !== originalDoseClinicId) {
    const inventorySnap = await withBookingTimeout(getDocs(query(
      collection(db, 'inventory'),
      where('clinic_id', '==', clinic.id)
    )), 'Checking clinic inventory');
    const hasMatchingStock = inventorySnap.docs.some(item => item.data().type === latestVaccineBrand && Number(item.data().quantity || 0) > 0);
    if (!hasMatchingStock) {
      msgEl.style.display = 'block';
      msgEl.style.background = '#fff5f5';
      msgEl.style.color = '#ef0000';
      msgEl.style.border = '1px solid #fecaca';
      msgEl.textContent = `This clinic does not carry the required ${latestVaccineBrand} vaccine for Dose ${nextDose}. Choose the original clinic or a matching clinic.`;
      resetBookingButton();
      return;
    }
  }
  const earliestDate = firstDoseDate && nextDose > 1
    ? formatInputDate(firstDoseDate, doseDayOffsets[nextDose - 1])
    : new Date().toISOString().split('T')[0];
  if (date < earliestDate) {
    msgEl.style.display = 'block';
    msgEl.style.background = '#fff5f5';
    msgEl.style.color = '#ef0000';
    msgEl.style.border = '1px solid #fecaca';
    msgEl.textContent = `Dose ${nextDose} should be scheduled on or after ${earliestDate}.`;
    resetBookingButton();
    return;
  }

  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Booking...';

    let idDownloadUrl = savedBooking.valid_id_url || '';
    let idContentType = savedBooking.valid_id_type || '';
    let idName = savedBooking.valid_id_name || '';
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
      patient_category: '',
      wound_washed: '',
      bite_type: '',
      status: 'pending',
      created_at: serverTimestamp()
    }), 'Saving your appointment');

    await updateDoc(doc(db, 'residents', currentUid), {
      address,
      birthday: dateOfBirth,
      gender: sex,
      updated_at: serverTimestamp()
    });
    residentProfile = { ...residentProfile, address, birthday: dateOfBirth, gender: sex };

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

  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', () => {
    signOutUser().then(() => window.location.href = 'login.html');
  });

  // Expose some functions to window for inline onclick attributes (module scope isn't global)
  window.showTab = showTab;
  window.openBookingModal = openBookingModal;
  window.closeBookingModal = closeBookingModal;
  window.confirmBooking = confirmBooking;
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