import { doc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs, addDoc, onSnapshot, serverTimestamp, runTransaction, setDoc } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
// signOutUser comes from the app's own firebase.js, so sign-out acts on the same
// auth instance that set the session persistence.
import { auth, db, fetchUserProfile, signOutUser } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { protectPage } from './role-guard.js';

protectPage('clinic_staff');

let currentClinicId = null;
let appointmentsUnsubscribe = null;
let appointmentSourceUnsubscribes = [];
let pendingBadgeUnsubscribe = null;
let pendingBadgeSourceUnsubscribes = [];
let inventoryUnsubscribe = null;
let inventoryItems = [];
const modal = document.getElementById('vaccineModal');
const vaccineForm = document.getElementById('vaccineForm');

const VACCINE_NAME_ALIASES = {
    'verorab': 'Verorab (PVRV)', 'verorab pvrv': 'Verorab (PVRV)', 'verovab': 'Verorab (PVRV)',
    'rabipur': 'Rabipur (PCECV)', 'rabipub': 'Rabipur (PCECV)',
    'speeda': 'Speeda (PVRV)', 'vaxirab': 'VaxiRab N (PCECV)', 'vaxirab n': 'VaxiRab N (PCECV)',
    'rabivax': 'Rabivax-S (PVRV)', 'rabivax s': 'Rabivax-S (PVRV)',
    'imovax': 'Imovax (HDCV)', 'rabavert': 'RabAvert (PCECV)', 'rab avert': 'RabAvert (PCECV)'
};
const LOW_STOCK_THRESHOLD = 15;
function canonicalVaccineName(value) {
    const key = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return VACCINE_NAME_ALIASES[key] || value || '';
}

function manilaToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// An appointment has lapsed only when the clinic confirmed it, the resident did
// not turn up, and the inclusive reservation window has fully passed. The end
// date itself is still valid, so the comparison is strictly "less than today".
function isReservationExpired(appointment) {
    if (!appointment || appointment.status !== 'confirmed') return false;
    if (!appointment.reservation_end_date) return false;
    return appointment.reservation_end_date < manilaToday();
}

// Default grace period in days, used when a clinic has not configured one.
// A duration of 1 means the appointment is valid only on its scheduled date.
const DEFAULT_RESERVATION_DAYS = 1;
const MAX_RESERVATION_DAYS = 7;
// Cached from the clinic document so confirmation does not need an extra read
// on every render. Updated whenever clinic settings load.
let clinicReservationDays = null;

function normaliseReservationDays(value) {
    const days = Number(value);
    if (!Number.isFinite(days) || days < 1) return DEFAULT_RESERVATION_DAYS;
    return Math.min(MAX_RESERVATION_DAYS, Math.floor(days));
}

// Prefers the clinic's configured duration, then the value already stored on the
// appointment, then the system default.
function getConfiguredReservationDays(appointment) {
    if (clinicReservationDays) return normaliseReservationDays(clinicReservationDays);
    if (appointment?.reservation_days) return normaliseReservationDays(appointment.reservation_days);
    return DEFAULT_RESERVATION_DAYS;
}

// Inclusive reservation window: a duration of N days keeps the appointment
// valid through the (N-1)th day after the scheduled date.
function getReservationEndDateFor(startDate, durationDays) {
    if (!startDate) return '';
    const parts = String(startDate).split('-').map(Number);
    if (parts.length !== 3 || parts.some(value => Number.isNaN(value))) return startDate;
    const end = new Date(parts[0], parts[1] - 1, parts[2]);
    end.setDate(end.getDate() + normaliseReservationDays(durationDays) - 1);
    const year = end.getFullYear();
    const month = String(end.getMonth() + 1).padStart(2, '0');
    const day = String(end.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Guards against the confirmed-then-instantly-expired bug: an appointment is
// never expired before its own scheduled date has passed.
function isReservationWindowOpen(appointment) {
    if (!appointment?.reservation_end_date) return true;
    return appointment.reservation_end_date >= manilaToday();
}

// Marks lapsed appointments as expired in Firestore. A resident no-show is the
// only way an appointment reaches this state: the dose was never completed and
// the reservation window has passed. Failures are logged rather than surfaced,
// because the scheduled Cloud Function performs the same transition server-side.
const expiringAppointmentIds = new Set();
async function persistExpiredAppointments(appointments) {
    const due = appointments.filter(appointment =>
        appointment.status === 'expired' &&
        !appointment.expired_at &&
        !expiringAppointmentIds.has(appointment.id)
    );
    for (const appointment of due) {
        expiringAppointmentIds.add(appointment.id);
        try {
            await updateDoc(doc(db, 'appointments', appointment.id), {
                status: 'expired',
                expired_at: serverTimestamp(),
                expiration_reason: 'Reservation duration ended - resident did not attend'
            });
            await addDoc(collection(db, 'history'), {
                clinic_id: currentClinicId,
                type: 'appointment',
                action: 'expired',
                appointment_id: appointment.id,
                resident_name: appointment.resident_name || 'Resident',
                performed_by: auth.currentUser?.uid || '',
                created_at: serverTimestamp()
            });
            if (appointment.resident_uid) {
                await addDoc(collection(db, 'notifications'), {
                    recipient_uid: appointment.resident_uid,
                    user_id: appointment.resident_uid,
                    appointment_id: appointment.id,
                    type: 'appointment',
                    title: 'Appointment Expired',
                    message: `Your appointment at ${appointment.clinic_name || 'the clinic'} on ${appointment.preferred_date || ''} ${appointment.preferred_time || ''} has expired because it was not completed within the reservation period. Please book a new appointment.`,
                    read: false,
                    created_at: serverTimestamp()
                });
            }
        } catch (error) {
            console.error('Could not mark appointment expired:', appointment.id, error);
            expiringAppointmentIds.delete(appointment.id);
        }
    }
}

function applyStaffTab() {
    const inventoryPanel = document.getElementById('inventoryPanel');
    const appointmentsPanel = document.getElementById('residentAppointmentsPanel');
    const appointmentTab = document.querySelector('a[href="staff.html#resident-appointments"] button');
    const inventoryTab = document.querySelector('a[href="staff.html"] button');
    const showingAppointments = window.location.hash === '#resident-appointments';
    if (inventoryPanel) inventoryPanel.hidden = showingAppointments;
    if (appointmentsPanel) appointmentsPanel.hidden = !showingAppointments;
    if (appointmentTab) appointmentTab.classList.toggle('active-tab', showingAppointments);
    if (inventoryTab) inventoryTab.classList.toggle('active-tab', !showingAppointments);
}

applyStaffTab();
window.addEventListener('hashchange', applyStaffTab);

// Auth state handling
onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    const profile = await fetchUserProfile(user.uid);
    if (!profile) return;

    currentClinicId = profile.clinic_id || user.uid;

    // Linking the staff uid to the clinic is a convenience write, not a
    // prerequisite for the dashboard. It used to be an unguarded await, so a
    // rejected or stalled write threw here and every listener below never
    // started - which is why the inventory and appointments stayed empty.
    try {
        await setDoc(doc(db, 'clinics', currentClinicId), { staff_uid: user.uid }, { merge: true });
    } catch (error) {
        console.error('Could not link this staff account to the clinic:', error);
    }

    // Each of these is independent, so one failure cannot suppress the others.
    const startListener = (label, start) => {
        try { start(); } catch (error) { console.error(`Could not start ${label}:`, error); }
    };
    startListener('reservation settings', () => listenToClinicReservationDays(currentClinicId));
    startListener('inventory', () => listenToInventory(currentClinicId));
    startListener('pending badge', () => listenToPendingAppointmentBadge(currentClinicId, user.uid));
    startListener('appointments', () => loadStaffAppointments(currentClinicId, user.uid));
});

// The grace period is a clinic setting, so it is read from the clinic document
// and kept live: changing it affects appointments confirmed from then on.
function listenToClinicReservationDays(clinicId) {
    onSnapshot(doc(db, 'clinics', clinicId), snapshot => {
        const value = snapshot.data()?.reservation_days;
        clinicReservationDays = value === undefined || value === null ? null : normaliseReservationDays(value);
    }, error => console.error('Could not read the clinic reservation duration:', error));
}

function listenToPendingAppointmentBadge(clinicId, staffUid = auth.currentUser?.uid) {
    const badge = document.getElementById('pendingAppointmentBadge');
    if (!badge) return;
    pendingBadgeSourceUnsubscribes.forEach(unsubscribe => unsubscribe());
    pendingBadgeSourceUnsubscribes = [];
    const sources = new Map();
    const renderBadge = () => {
        const appointments = [...new Map([...sources.values()].flat().map(item => [item.id, item])).values()];
        const count = appointments.filter(item => item.status === 'pending').length;
        badge.textContent = count;
        badge.hidden = false;
    };
    const listenToBadgeSource = (sourceKey, appointmentQuery) => {
        const unsubscribe = onSnapshot(appointmentQuery, snapshot => {
            sources.set(sourceKey, snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
            renderBadge();
        }, error => {
            console.error(`Failed to update pending appointment badge from ${sourceKey}:`, error);
            sources.set(sourceKey, []);
            renderBadge();
        });
        pendingBadgeSourceUnsubscribes.push(unsubscribe);
    };
    listenToBadgeSource('clinic', query(collection(db, 'appointments'), where('clinic_id', '==', clinicId)));
    if (staffUid) listenToBadgeSource('staff', query(collection(db, 'appointments'), where('clinic_staff_uid', '==', staffUid)));
}

async function loadStaffAppointments(clinicId, staffUid = auth.currentUser?.uid) {
    const container = document.getElementById('staffAppointments');
    if (!container) return;
    appointmentSourceUnsubscribes.forEach(unsubscribe => unsubscribe());
    appointmentSourceUnsubscribes = [];
    const appointmentSources = new Map();
    const renderAppointments = () => {
        const appointments = [...new Map([...appointmentSources.values()].flat().map(item => [item.id, item])).values()]
            .map(appointment => isReservationExpired(appointment) ? { ...appointment, status: 'expired' } : appointment)
            .filter(appointment => ['pending', 'confirmed', 'expired'].includes(appointment.status))
            .sort((first, second) => `${second.preferred_date || ''} ${second.preferred_time || ''}`.localeCompare(`${first.preferred_date || ''} ${first.preferred_time || ''}`));
        // Persist the no-show transitions so the status survives a reload and is
        // visible to the resident, not just rendered locally for this session.
        persistExpiredAppointments(appointments);
        if (!appointments.length) {
            container.innerHTML = '<p class="empty-appointments">No resident appointments for this clinic.</p>';
            return;
        }
                container.innerHTML = `<div class="resident-appointment-cards">${appointments.map(appointment => `
                        <article class="resident-appointment-card">
                            <div class="appointment-avatar"><i class="fa-solid fa-user"></i></div>
                            <div class="resident-appointment-info">
                                <h3>${escapeHtml(appointment.resident_name || 'Resident')}</h3>
                                <p>${escapeHtml(appointment.preferred_date || '')} &nbsp;·&nbsp; ${escapeHtml(appointment.preferred_time || '')}</p>
                                <div class="appointment-tags"><span>${escapeHtml(appointment.dose_label || 'Dose 1')}</span><span><i class="fa-regular fa-clock"></i> ${escapeHtml(appointment.preferred_time || '')}</span><span>${escapeHtml(appointment.clinic_name || '')}</span></div>
                            </div>
                            <div class="resident-appointment-actions">
                                <span class="appointment-status appointment-${escapeHtml(appointment.status || 'pending')}">${escapeHtml(appointment.status || 'pending')}</span>
                                <button type="button" class="view-appointment-btn" data-view-id="${appointment.id}"><i class="fa-regular fa-id-card"></i> View Course Record</button>
                                ${appointment.status === 'pending' ? `<button type="button" class="confirm-appointment-btn" data-confirm-id="${appointment.id}"><i class="fa-solid fa-circle-check"></i> Confirm</button><button type="button" class="decline-appointment-btn" data-decline-id="${appointment.id}"><i class="fa-solid fa-xmark"></i> Decline</button>` : ''}
                                ${appointment.status === 'expired' ? `<span class="appointment-expired-label"><i class="fa-regular fa-clock"></i> Reservation expired</span><button type="button" class="delete-expired-appointment-btn" data-delete-expired-id="${appointment.id}"><i class="fa-solid fa-trash"></i> Delete</button>` : ''}
                                ${appointment.status === 'confirmed' ? `<button type="button" class="confirm-appointment-btn" data-complete-id="${appointment.id}"><i class="fa-solid fa-syringe"></i> Complete Dose</button>` : ''}
                                ${appointment.status === 'completed' ? '<span class="dose-completed-label"><i class="fa-solid fa-circle-check"></i> Dose recorded</span>' : ''}
                            </div>
                        </article>`).join('')}</div>`;
                container.querySelectorAll('[data-view-id]').forEach(button => button.addEventListener('click', () => openAppointmentDetails(button.dataset.viewId)));
        container.querySelectorAll('[data-confirm-id]').forEach(button => button.addEventListener('click', () => acceptStaffAppointment(button.dataset.confirmId)));
                container.querySelectorAll('[data-decline-id]').forEach(button => button.addEventListener('click', () => declineStaffAppointment(button.dataset.declineId)));
                container.querySelectorAll('[data-complete-id]').forEach(button => button.addEventListener('click', () => openDoseCompletion(button.dataset.completeId, appointments.find(item => item.id === button.dataset.completeId))));
                container.querySelectorAll('[data-delete-expired-id]').forEach(button => button.addEventListener('click', () => deleteExpiredAppointment(button.dataset.deleteExpiredId)));
    };
    const listenToSource = (sourceKey, appointmentQuery) => {
        const unsubscribe = onSnapshot(appointmentQuery, snapshot => {
            appointmentSources.set(sourceKey, snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
            renderAppointments();
        }, error => {
            console.error(`Failed to load appointment source ${sourceKey}:`, error);
            appointmentSources.set(sourceKey, []);
            renderAppointments();
            if (!appointmentSourceUnsubscribes.length) container.innerHTML = `<p class="empty-appointments">Could not load appointments: ${escapeHtml(error.message)}</p>`;
        });
        appointmentSourceUnsubscribes.push(unsubscribe);
    };
    listenToSource('clinic', query(collection(db, 'appointments'), where('clinic_id', '==', clinicId)));
    if (staffUid) listenToSource('staff', query(collection(db, 'appointments'), where('clinic_staff_uid', '==', staffUid)));
}

async function acceptStaffAppointment(appointmentId) {
    try {
        const appointment = (await getDoc(doc(db, 'appointments', appointmentId))).data();
        // Recompute the reservation window at confirmation time from the clinic's
        // current setting, so an appointment booked before the duration was
        // configured still gets the correct grace period.
        const reservationDays = getConfiguredReservationDays(appointment);
        const reservationEndDate = getReservationEndDateFor(appointment?.preferred_date, reservationDays);
        await updateDoc(doc(db, 'appointments', appointmentId), {
            status: 'confirmed',
            reschedule_requested: false,
            confirmed_at: serverTimestamp(),
            reservation_days: reservationDays,
            reservation_end_date: reservationEndDate
        });
        await addDoc(collection(db, 'history'), { clinic_id: currentClinicId, type: 'appointment', action: 'confirmed', appointment_id: appointmentId, resident_name: appointment?.resident_name || 'Resident', performed_by: auth.currentUser.uid, created_at: serverTimestamp() });
        if (appointment?.resident_uid) {
            await addDoc(collection(db, 'notifications'), {
                recipient_uid: appointment.resident_uid, user_id: appointment.resident_uid, appointment_id: appointmentId,
                type: 'appointment', title: appointment.reschedule_requested ? 'Reschedule Confirmed' : 'Appointment Confirmed',
                message: appointment.reschedule_requested
                    ? `Your rescheduled appointment at ${appointment.clinic_name || 'the clinic'} on ${appointment.preferred_date} at ${appointment.preferred_time} was confirmed by the clinic.`
                    : `Your appointment at ${appointment.clinic_name || 'the clinic'} on ${appointment.preferred_date} at ${appointment.preferred_time} was confirmed.`, read: false, created_at: serverTimestamp()
            });
            await addDoc(collection(db, 'notifications'), {
                recipient_uid: appointment.resident_uid, user_id: appointment.resident_uid, appointment_id: appointmentId,
                type: 'appointment', title: 'Appointment Reminder',
                message: `Reminder: your appointment at ${appointment.clinic_name || 'the clinic'} is scheduled for ${appointment.preferred_date} at ${appointment.preferred_time}.`, read: false, created_at: serverTimestamp()
            });
        }
        await loadStaffAppointments(currentClinicId);
    } catch (error) {
        alert('Could not accept appointment: ' + error.message);
    }
}

// Holds the appointment being declined so the live preview can quote it.
let apparentDeclineAppointment = {};

// Opening the decline dialog replaces the old one-click decline, so staff can
// point a turned-away resident at a facility that can actually treat them.
async function declineStaffAppointment(appointmentId) {
    const modal = document.getElementById('declineReferralModal');
    if (!modal) return;
    document.getElementById('declineAppointmentId').value = appointmentId;
    document.getElementById('declineReferralFacility').value = '';
    document.getElementById('declineReferralContact').value = '';
    document.getElementById('declineReferralReason').value = '';
    document.getElementById('declineReferralNote').value = '';
    const summary = document.getElementById('declineReferralSummary');
    if (summary) summary.textContent = 'Loading appointment details...';
    closeDeclineReferral();
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('declineReferralFacility')?.focus();

    let appointment = null;
    try {
        const snap = await getDoc(doc(db, 'appointments', appointmentId));
        appointment = snap.exists() ? snap.data() : null;
    } catch (error) {
        console.error('Could not load appointment for decline:', error);
    }
    apparentDeclineAppointment = appointment || {};
    if (summary) {
        summary.innerHTML = appointment
            ? `<strong>${escapeHtml(appointment.resident_name || 'Resident')}</strong> · ${escapeHtml(appointment.dose_label || 'Dose 1')} · ${escapeHtml(appointment.preferred_date || '')} ${escapeHtml(appointment.preferred_time || '')}`
            : 'Appointment details unavailable. You can still decline and add a referral.';
    }
    updateDeclineReferralPreview();
}

function closeDeclineReferral() {
    const modal = document.getElementById('declineReferralModal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
}

// Mirrors the wording the resident will actually receive, so staff can see the
// recommendation before committing to it.
function buildDeclineReferralFields() {
    const facility = document.getElementById('declineReferralFacility')?.value.trim() || '';
    return {
        facility,
        contact: document.getElementById('declineReferralContact')?.value.trim() || '',
        reason: document.getElementById('declineReferralReason')?.value.trim() || '',
        note: document.getElementById('declineReferralNote')?.value.trim() || ''
    };
}

function buildDeclineMessage(appointment, referral) {
    const clinicName = appointment?.clinic_name || 'the clinic';
    let message = `Your appointment request at ${clinicName} was declined.`;
    if (referral.facility) {
        message += ` We recommend you proceed to ${referral.facility} for your animal bite treatment.`;
        if (referral.contact) message += ` (${referral.contact})`;
    }
    if (referral.reason) message += ` Reason: ${referral.reason}.`;
    if (referral.note) message += ` ${referral.note}`;
    return message;
}

function updateDeclineReferralPreview() {
    const preview = document.getElementById('declineReferralPreview');
    if (!preview) return;
    preview.textContent = buildDeclineMessage(apparentDeclineAppointment, buildDeclineReferralFields());
}

async function submitDeclineReferral(event) {
    event.preventDefault();
    const appointmentId = document.getElementById('declineAppointmentId').value;
    const button = document.getElementById('confirmDeclineReferralBtn');
    if (!appointmentId || button?.disabled) return;
    const referral = buildDeclineReferralFields();
    if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Declining...'; }
    try {
        const appointmentSnap = await getDoc(doc(db, 'appointments', appointmentId));
        const appointment = appointmentSnap.exists() ? appointmentSnap.data() : apparentDeclineAppointment;
        // The referral is stored on the appointment so clinics and admins can
        // audit where a resident was sent, not just on the notification.
        await updateDoc(doc(db, 'appointments', appointmentId), {
            status: 'declined',
            declined_at: serverTimestamp(),
            referral_facility: referral.facility,
            referral_contact: referral.contact,
            referral_reason: referral.reason,
            referral_note: referral.note,
            referral_created_at: serverTimestamp()
        });
        await addDoc(collection(db, 'history'), { clinic_id: currentClinicId, type: 'appointment', action: 'declined', appointment_id: appointmentId, resident_name: appointment?.resident_name || 'Resident', performed_by: auth.currentUser.uid, created_at: serverTimestamp() });
        if (appointment?.resident_uid) {
            await addDoc(collection(db, 'notifications'), {
                recipient_uid: appointment.resident_uid,
                user_id: appointment.resident_uid,
                appointment_id: appointmentId,
                type: 'appointment',
                title: 'Appointment Declined',
                message: buildDeclineMessage(appointment, referral),
                // Rendered as a highlighted callout by the resident's card.
                referral_facility: referral.facility,
                referral_contact: referral.contact,
                referral_reason: referral.reason,
                referral_note: referral.note,
                read: false,
                created_at: serverTimestamp()
            });
        }
        closeDeclineReferral();
        await loadStaffAppointments(currentClinicId);
    } catch (error) {
        alert('Could not decline appointment: ' + error.message);
    } finally {
        if (button) { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-xmark"></i> Decline Appointment'; }
    }
}

function openDoseCompletion(appointmentId, appointment) {
    document.getElementById('completionAppointmentId').value = appointmentId;
    document.getElementById('completionDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('completionDose').value = Number(String(appointment?.dose_label || '1').match(/\d+/)?.[0] || 1);
    document.getElementById('completionVaccine').value = appointment?.vaccine_name || '';
    document.getElementById('completionLocation').value = appointment?.clinic_address || '';
    document.getElementById('doseCompletionModal').style.display = 'flex';
    document.getElementById('doseCompletionModal').setAttribute('aria-hidden', 'false');
}

async function completeStaffDose(event) {
    event.preventDefault();
    const appointmentId = document.getElementById('completionAppointmentId').value;
    const vaccineName = canonicalVaccineName(document.getElementById('completionVaccine').value.trim());
    const location = document.getElementById('completionLocation').value.trim();
    const doseNumber = Number(document.getElementById('completionDose').value);
    try {
        const appointmentSnap = await getDoc(doc(db, 'appointments', appointmentId));
        const appointment = appointmentSnap.exists() ? appointmentSnap.data() : null;
        if (!appointment) throw new Error('Appointment was not found.');
        const inventorySnap = await getDocs(query(collection(db, 'inventory'), where('clinic_id', '==', currentClinicId)));
        const inventoryItem = inventorySnap.docs.filter(item => canonicalVaccineName(item.data().type) === vaccineName && !item.data().archived && item.data().expiry >= manilaToday() && Number(item.data().quantity || 0) > 0).sort((a, b) => String(a.data().expiry).localeCompare(String(b.data().expiry)))[0];
        if (!inventoryItem) throw new Error(`No available ${vaccineName} stock at this clinic.`);
        const existing = await getDocs(query(collection(db, 'vaccination_records'), where('appointment_id', '==', appointmentId)));
        if (!existing.empty) throw new Error('This appointment already has a completed dose.');
        await runTransaction(db, async transaction => {
            const currentInventory = await transaction.get(inventoryItem.ref);
            const item = currentInventory.data();
            const quantity = Number(item?.quantity || 0);
            if (quantity <= 0 || item?.archived || item?.expiry < manilaToday()) throw new Error(`No usable ${vaccineName} stock at this clinic.`);
            transaction.update(inventoryItem.ref, { quantity: quantity - 1 });
        });
        await addDoc(collection(db, 'vaccination_records'), {
            resident_uid: appointment.resident_uid, resident_name: appointment.resident_name || '', appointment_id: appointmentId,
            vaccination_session_id: appointment.vaccination_session_id || 'legacy',
            dose_number: doseNumber, vaccine_name: vaccineName, vaccine_type: vaccineName, clinic_id: currentClinicId,
            clinic_name: appointment.clinic_name || '', clinic_location: location, date_given: document.getElementById('completionDate').value,
            administered_by: auth.currentUser.uid, recorded_at: serverTimestamp()
        });
        await updateDoc(doc(db, 'appointments', appointmentId), { status: 'completed', completed_at: serverTimestamp(), completed_dose_number: doseNumber, completed_vaccine_name: vaccineName });
        if (appointment.resident_uid) {
            await addDoc(collection(db, 'notifications'), {
                recipient_uid: appointment.resident_uid, user_id: appointment.resident_uid, appointment_id: appointmentId,
                type: 'vaccine', title: `Dose ${doseNumber} Completed`,
                message: `Your Dose ${doseNumber} vaccination was recorded at ${appointment.clinic_name || 'the clinic'} on ${document.getElementById('completionDate').value}.`,
                read: false, created_at: serverTimestamp()
            });
        }
        document.getElementById('doseCompletionModal').style.display = 'none';
        document.getElementById('doseCompletionForm').reset();
        await loadStaffAppointments(currentClinicId);
    } catch (error) {
        alert('Could not complete dose: ' + error.message);
    }
}

// --- INVENTORY MANAGEMENT (Real-Time) ---
function listenToInventory(clinicId) {
    const inventoryQuery = query(collection(db, 'inventory'), where('clinic_id', '==', clinicId));
    inventoryUnsubscribe?.();
    inventoryUnsubscribe = onSnapshot(inventoryQuery, snapshot => {
        inventoryItems = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
        renderInventory();
    }, error => {
        console.error('Failed to load inventory:', error);
        alert('Failed to load vaccine inventory.');
    });
    return;
    onSnapshot(inventoryQuery, (snapshot) => {
        const tbody = document.getElementById('inventoryTableBody');
        tbody.innerHTML = '';
        let totalStock = 0;
        let lowStockCount = 0;

        snapshot.forEach((inventoryDoc) => {
            const data = inventoryDoc.data();
            const quantity = Number(data.quantity || 0);
            totalStock += quantity;
            const status = quantity <= 5 ? 'critical' : quantity <= 15 ? 'low' : 'adequate';
            if (status !== 'adequate') lowStockCount++;

            const row = document.createElement('tr');
            row.innerHTML = `
                <td><strong>${escapeHtml(data.type)}</strong></td>
                <td>${escapeHtml(data.manufacturer)}</td>
                <td>${escapeHtml(data.batch)}</td>
                <td><strong>${quantity} doses</strong></td>
                <td>${escapeHtml(data.expiry)}</td>
                <td><span class="status ${status}">${status}</span></td>
                <td><button type="button" class="update-link edit-item-btn" data-id="${inventoryDoc.id}">
                    <i class="fa-regular fa-pen-to-square"></i> Update
                </button></td>`;
            tbody.appendChild(row);

            row.querySelector('.edit-item-btn').addEventListener('click', () => openModal(inventoryDoc.id, data));
        });

        document.getElementById('statTotalStock').textContent = totalStock;
        document.getElementById('statLowStock').textContent = lowStockCount;
        document.querySelector('.alert-box p').textContent = `${lowStockCount} stock item${lowStockCount === 1 ? '' : 's'} require immediate attention.`;
        setDoc(doc(db, 'clinics', clinicId), {
            stock_total: totalStock,
            stock_status: totalStock === 0 ? 'out' : lowStockCount > 0 ? 'low' : 'available',
            stock_summary: snapshot.docs.map(item => `${item.data().type || 'Vaccine'}: ${Number(item.data().quantity || 0)}`).join(' · ')
        }, { merge: true }).catch(error => console.error('Failed to publish clinic stock summary:', error));
    }, (error) => {
        console.error('Failed to load inventory:', error);
        alert('Failed to load vaccine inventory.');
    });
}

async function deleteExpiredAppointment(appointmentId) {
    if (!confirm('Delete this expired reservation? This cannot be undone.')) return;
    try {
        const appointmentSnap = await getDoc(doc(db, 'appointments', appointmentId));
        if (!appointmentSnap.exists()) throw new Error('This reservation no longer exists.');
        const appointment = appointmentSnap.data();
        if (!isReservationExpired(appointment)) throw new Error('Only expired reservations can be deleted.');
        await addDoc(collection(db, 'history'), {
            clinic_id: currentClinicId, type: 'appointment', action: 'expired_reservation_deleted',
            appointment_id: appointmentId, resident_name: appointment.resident_name || 'Resident',
            performed_by: auth.currentUser.uid, created_at: serverTimestamp()
        });
        await deleteDoc(doc(db, 'appointments', appointmentId));
    } catch (error) {
        alert('Could not delete expired reservation: ' + error.message);
    }
}

function expiryState(expiry) {
    if (!expiry || expiry < manilaToday()) return ['expired', 'Expired'];
    const days = Math.ceil((new Date(`${expiry}T00:00:00`) - new Date(`${manilaToday()}T00:00:00`)) / 86400000);
    return days <= 30 ? ['expiring', `Expires in ${days} day${days === 1 ? '' : 's'}`] : ['', ''];
}

function inventoryCategory(item) {
    const quantity = Number(item.quantity || 0);
    const [expiry] = expiryState(item.expiry);
    const expired = expiry === 'expired';
    const archived = Boolean(item.archived) || quantity <= 0;
    const usable = !archived && !expired && quantity > 0;
    return { quantity, expired, archived, usable, low: usable && quantity < LOW_STOCK_THRESHOLD, adequate: usable && quantity >= LOW_STOCK_THRESHOLD };
}

function renderInventory() {
    const tbody = document.getElementById('inventoryTableBody');
    if (!tbody) return;
    const filter = document.getElementById('inventoryFilter')?.value || 'active';
    const active = inventoryItems.filter(item => inventoryCategory(item).usable);
    const items = inventoryItems.filter(item => {
        const category = inventoryCategory(item);
        if (filter === 'all') return true;
        // "Active Stock" means every usable batch, including low-stock ones.
        if (filter === 'active') return category.usable;
        if (filter === 'low') return category.low;
        if (filter === 'expired') return category.expired;
        if (filter === 'archived') return category.archived;
        return false;
    });
    let lowCount = 0, expiryCount = 0;
    tbody.innerHTML = items.map(item => {
        const category = inventoryCategory(item), [expiryClass, expiryLabel] = expiryState(item.expiry);
        const status = category.expired ? 'critical' : category.archived ? 'archived' : category.low ? 'low' : 'adequate';
        if (category.low) lowCount++;
        if (category.expired) expiryCount++;
        const statusLabel = category.expired ? 'expired' : category.archived ? (category.quantity <= 0 ? 'zeroed out' : 'archived') : category.low ? 'low' : 'adequate';
        return `<tr><td><strong>${escapeHtml(item.type)}</strong></td><td>${escapeHtml(item.manufacturer)}</td><td>${escapeHtml(item.batch)}</td><td><strong>${category.quantity} doses</strong></td><td>${escapeHtml(item.expiry)}${expiryLabel ? `<div class="inventory-warning">${escapeHtml(expiryLabel)}</div>` : ''}</td><td><span class="status ${status}">${statusLabel}</span></td><td><div class="inventory-actions"><button type="button" class="update-link" data-edit-id="${item.id}">Update</button><button type="button" class="inventory-action secondary" data-archive-id="${item.id}">${item.archived ? 'Restore' : 'Archive'}</button><button type="button" class="inventory-action" data-delete-id="${item.id}">Delete</button></div></td></tr>`;
    }).join('') || '<tr><td colspan="7">No inventory batches match this filter.</td></tr>';
    tbody.querySelectorAll('[data-edit-id]').forEach(button => button.addEventListener('click', () => openModal(button.dataset.editId, inventoryItems.find(item => item.id === button.dataset.editId))));
    tbody.querySelectorAll('[data-archive-id]').forEach(button => button.addEventListener('click', () => updateDoc(doc(db, 'inventory', button.dataset.archiveId), { archived: !inventoryItems.find(item => item.id === button.dataset.archiveId)?.archived, updated_at: serverTimestamp() })));
    tbody.querySelectorAll('[data-delete-id]').forEach(button => button.addEventListener('click', async () => { if (confirm('Delete this batch permanently?')) await deleteDoc(doc(db, 'inventory', button.dataset.deleteId)); }));
    const total = active.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    document.getElementById('statTotalStock').textContent = total;
    document.getElementById('statLowStock').textContent = lowCount;
    document.querySelector('.alert-box p').textContent = `${lowCount} usable batch${lowCount === 1 ? ' is' : 'es are'} below ${LOW_STOCK_THRESHOLD} doses.${expiryCount ? ` ${expiryCount} batch${expiryCount === 1 ? ' is' : 'es are'} expired.` : ''}`;
    setDoc(doc(db, 'clinics', currentClinicId), { stock_total: total, stock_status: total === 0 ? 'out' : lowCount ? 'low' : 'available', stock_summary: active.map(item => `${item.type || 'Vaccine'} (${item.batch || 'No batch'}): ${Number(item.quantity || 0)}`).join(' · '), updated_at: serverTimestamp() }, { merge: true }).catch(console.error);
}

function escapeHtml(value = '') {
    const element = document.createElement('div');
    element.textContent = value;
    return element.innerHTML;
}

function openModal(docId = '', data = {}) {
    document.getElementById('modalTitle').textContent = docId ? 'Update Stock' : 'Add New Stock';
    document.getElementById('vaccineDocId').value = docId;
    document.getElementById('vacType').value = canonicalVaccineName(data.type);
    document.getElementById('vacManufacturer').value = data.manufacturer || '';
    document.getElementById('vacBatch').value = data.batch || '';
    document.getElementById('vacQuantity').value = data.quantity ?? '';
    document.getElementById('vacExpiry').value = data.expiry || '';
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    vaccineForm.reset();
}

document.querySelector('.add-btn').addEventListener('click', () => openModal());
document.getElementById('inventoryFilter')?.addEventListener('change', renderInventory);
document.getElementById('closeModalBtn').addEventListener('click', closeModal);
modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
});

vaccineForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentClinicId) {
        alert('Your staff account is not linked to a clinic. Add a clinic_id to your users profile first.');
        return;
    }
    const docId = document.getElementById('vaccineDocId').value;
    const payload = {
        clinic_id: currentClinicId,
        type: document.getElementById('vacType').value.trim(),
        manufacturer: document.getElementById('vacManufacturer').value.trim(),
        batch: document.getElementById('vacBatch').value.trim(),
        quantity: Number(document.getElementById('vacQuantity').value),
        expiry: document.getElementById('vacExpiry').value,
        archived: docId ? Boolean(inventoryItems.find(item => item.id === docId)?.archived) : false,
        updated_at: serverTimestamp()
    };

    if (payload.expiry < manilaToday()) {
        if (!confirm('This batch is already expired. Save it as an archived record?')) return;
        payload.archived = true;
    }
    const duplicate = inventoryItems.find(item => item.id !== docId && !item.archived && item.batch?.toLowerCase() === payload.batch.toLowerCase());
    if (duplicate) { alert('This clinic already has an active record for that batch number. Update the existing batch instead.'); return; }

    try {
        if (docId) await updateDoc(doc(db, 'inventory', docId), payload);
        else await addDoc(collection(db, 'inventory'), payload);
        closeModal();
    } catch (error) {
        console.error('Error saving vaccine record:', error);
        const reason = error.code ? ` (${error.code})` : '';
        alert(`Failed to save inventory record${reason}: ${error.message || 'Unknown Firebase error.'}`);
    }
});

// The optional chaining matters: a missing element previously threw a
// TypeError here, which aborted the rest of the module.
document.querySelector('.signout-btn')?.addEventListener('click', async () => {
    try {
        await signOutUser();
    } catch (error) {
        console.error('Sign out failed:', error);
        alert('Could not sign out: ' + (error.message || 'Unknown error.'));
        return;
    }
    window.location.replace('login.html');
});

async function openAppointmentDetails(appointmentId) {
    const modal = document.getElementById('appointmentDetailsModal');
    const body = document.getElementById('appointmentDetailsBody');
    if (!modal || !body) return;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    body.innerHTML = '<p>Loading appointment details...</p>';
    try {
        const snapshot = await getDoc(doc(db, 'appointments', appointmentId));
        if (!snapshot.exists()) throw new Error('This appointment is no longer available.');
        const appointment = snapshot.data();
        const intake = appointment.course_intake_data || appointment;
        const priorDoses = Array.isArray(appointment.course_vaccination_history) ? appointment.course_vaccination_history : [];
        const historyMarkup = priorDoses.length
            ? `<ol class="appointment-course-history">${priorDoses.map(record => `<li><strong>Dose ${displayStaffValue(record.dose_number)}</strong> — ${displayStaffValue(record.date_given)} | ${displayStaffValue(record.vaccine_name)} | ${displayStaffValue(record.clinic_name)}</li>`).join('')}</ol>`
            : '<span>No previous administered doses recorded yet.</span>';
        const isImage = ['image/jpeg', 'image/png'].includes(appointment.valid_id_type) || /\.(jpe?g|png)$/i.test(appointment.valid_id_name || appointment.valid_id_url || '');
        const idMarkup = appointment.valid_id_url
            ? (isImage
                ? `<a href="${escapeHtml(appointment.valid_id_url)}" target="_blank" rel="noopener"><img class="appointment-id-preview" src="${escapeHtml(appointment.valid_id_url)}" alt="Uploaded valid ID"></a>`
                : `<a class="appointment-file-link" href="${escapeHtml(appointment.valid_id_url)}" target="_blank" rel="noopener"><i class="fa-solid fa-file-pdf"></i> View uploaded ID${appointment.valid_id_name ? ` (${escapeHtml(appointment.valid_id_name)})` : ''}</a>`)
            : '<span>Not provided</span>';
        // The resident may skip the wound photo, so "not provided" is a normal
        // outcome rather than an error to chase.
        const woundPhotoMarkup = appointment.wound_photo_url
            ? `<a href="${escapeHtml(appointment.wound_photo_url)}" target="_blank" rel="noopener"><img class="appointment-id-preview" src="${escapeHtml(appointment.wound_photo_url)}" alt="Resident wound photo"></a>`
            : '<span>Not provided (optional)</span>';
        const priorVaccinationDocumentMarkup = appointment.prior_vaccination_document_url
            ? `<a class="appointment-file-link" href="${escapeHtml(appointment.prior_vaccination_document_url)}" target="_blank" rel="noopener"><i class="fa-solid fa-file-medical"></i> View ${escapeHtml(appointment.prior_vaccination_document_name || 'previous vaccination record')}</a>`
            : '<span>Not provided (optional)</span>';
        body.innerHTML = `<div class="appointment-detail-grid">
            <div><strong>Resident</strong><span>${displayStaffValue(appointment.resident_name)}</span></div>
            <div><strong>Status</strong><span>${displayStaffValue(appointment.status)}</span></div>
            <div><strong>Primary Clinic</strong><span>${displayStaffValue(appointment.primary_clinic_name || appointment.clinic_name)}</span></div>
            <div><strong>Clinic Transfer</strong><span>${appointment.clinic_changed_for_dose ? 'Yes — resident confirmed change' : 'No'}</span></div>
            <div><strong>Address (locked intake)</strong><span>${displayStaffValue(intake.resident_address)}</span></div>
            <div><strong>Date of Birth (locked intake)</strong><span>${displayStaffValue(intake.date_of_birth)}</span></div>
            <div><strong>Sex (locked intake)</strong><span>${displayStaffValue(intake.patient_sex)}</span></div>
            <div><strong>Date of Bite (locked intake)</strong><span>${displayStaffValue(intake.bite_date)}</span></div>
            <div><strong>Animal (locked intake)</strong><span>${displayStaffValue(intake.animal_type)}</span></div>
            <div><strong>Bite Body Part (locked intake)</strong><span>${displayStaffValue(intake.bite_body_part)}</span></div>
            <div><strong>Wound Washed</strong><span>${displayStaffValue(intake.wound_washed)}</span></div>
            <div><strong>Exposure Type</strong><span>${displayStaffValue(intake.bite_type)}</span></div>
            <div><strong>Dose</strong><span>${displayStaffValue(appointment.dose_label)}</span></div>
            <div><strong>Preferred Date</strong><span>${displayStaffValue(appointment.preferred_date)}</span></div>
            <div><strong>Preferred Time</strong><span>${displayStaffValue(appointment.preferred_time)}</span></div>
            <div><strong>Uploaded ID / Photo</strong><span>${idMarkup}</span></div>
            <div><strong>Wound Photo (for exposure assessment)</strong><span>${woundPhotoMarkup}</span></div>
            <div><strong>Previous Vaccination Declared</strong><span>${appointment.prior_vaccination_history_declared ? 'Yes' : 'No / not declared'}</span></div>
            <div><strong>Previous Vaccination Record</strong><span>${priorVaccinationDocumentMarkup}</span></div>
            ${appointment.prior_vaccination_history_notes ? `<div class="full-field"><strong>Previous Vaccination Notes</strong><span>${displayStaffValue(appointment.prior_vaccination_history_notes)}</span></div>` : ''}
            <div class="full-field"><strong>Previous Vaccination History</strong><span>${historyMarkup}</span></div>
        </div>`;
    } catch (error) {
        body.innerHTML = `<p class="appointment-details-error">Could not load details: ${escapeHtml(error.message)}</p>`;
    }
}

function displayStaffValue(value) {
    return value === null || value === undefined || value === '' ? 'Not provided' : escapeHtml(String(value));
}

document.getElementById('closeAppointmentDetailsBtn')?.addEventListener('click', () => {
    const modal = document.getElementById('appointmentDetailsModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
});
document.getElementById('appointmentDetailsModal')?.addEventListener('click', event => {
    if (event.target.id === 'appointmentDetailsModal') {
        event.currentTarget.style.display = 'none';
        event.currentTarget.setAttribute('aria-hidden', 'true');
    }
});

document.getElementById('closeDoseCompletionBtn')?.addEventListener('click', () => {
    const modal = document.getElementById('doseCompletionModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
});
document.getElementById('doseCompletionForm')?.addEventListener('submit', completeStaffDose);

// --- Decline with referral --------------------------------------------------
document.getElementById('closeDeclineReferralBtn')?.addEventListener('click', closeDeclineReferral);
document.getElementById('cancelDeclineReferralBtn')?.addEventListener('click', closeDeclineReferral);
document.getElementById('declineReferralForm')?.addEventListener('submit', submitDeclineReferral);
document.getElementById('declineReferralModal')?.addEventListener('click', event => {
    if (event.target.id === 'declineReferralModal') closeDeclineReferral();
});
document.addEventListener('keydown', event => {
    const modal = document.getElementById('declineReferralModal');
    if (event.key === 'Escape' && modal?.style.display === 'flex') closeDeclineReferral();
});
// Keep the preview in step with what is being typed.
['declineReferralFacility', 'declineReferralContact', 'declineReferralReason', 'declineReferralNote']
    .forEach(id => document.getElementById(id)?.addEventListener('input', updateDeclineReferralPreview));
