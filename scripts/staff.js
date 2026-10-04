import { notifyDialog, confirmDialog } from './app-dialogs.js';
import { summarizeStock, clinicStockStatus } from './stock-summary.mjs';
import { watchDoseStock, saveStockDose, reviewTreatment } from './dose-completion.js';
import { appointmentDeadline, pendingAppointmentExpired } from './booking-status.js';
import { manageAppointment, markArrivalAndOpenIntake, openIntake } from './appointment-intake.js';
import { doc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs, addDoc, onSnapshot, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
// signOutUser comes from the app's own firebase.js, so sign-out acts on the same
// auth instance that set the session persistence.
import { auth, db, fetchUserProfile, signOutUser } from './firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { protectPage } from './role-guard.js';

protectPage('clinic_staff');

let currentClinicId = null;
let staffIntakeController;
let apparentDeclineAppointment = {};
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
const vaccineBrandSelect = document.getElementById('vacType');
const vaccineGenericSelect = document.getElementById('vacGeneric');
const vaccineBrands = [...vaccineBrandSelect.options].filter(option => option.value).map(option => ({
    value: option.value, brand: option.textContent.trim(), generic: option.value.match(/\(([^)]+)\)$/)?.[1] || ''
}));
function setVaccineSelection(value = '') {
    const selected = vaccineBrands.find(item => item.value === value);
    vaccineBrandSelect.replaceChildren(new Option('Select vaccine brand', ''), ...vaccineBrands.map(item => new Option(item.brand, item.value)));
    vaccineBrandSelect.options[0].disabled = true;
    vaccineBrandSelect.value = selected?.value || '';
    vaccineGenericSelect.value = selected?.generic || '';
}
vaccineBrandSelect.addEventListener('change', () => {
    vaccineGenericSelect.value = vaccineBrands.find(item => item.value === vaccineBrandSelect.value)?.generic || '';
});
vaccineGenericSelect.addEventListener('change', () => {
    const previous = vaccineBrandSelect.value;
    const matches = vaccineBrands.filter(item => item.generic === vaccineGenericSelect.value);
    vaccineBrandSelect.replaceChildren(new Option('Select vaccine brand', ''), ...matches.map(item => new Option(item.brand, item.value)));
    vaccineBrandSelect.options[0].disabled = true;
    vaccineBrandSelect.value = matches.some(item => item.value === previous) ? previous : matches.length === 1 ? matches[0].value : '';
});
const LOW_STOCK_THRESHOLD = 15;
function canonicalVaccineName(value) {
    const key = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return VACCINE_NAME_ALIASES[key] || value || '';
}

function manilaToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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
    startListener('inventory', () => listenToInventory(currentClinicId));
    startListener('pending badge', () => listenToPendingAppointmentBadge(currentClinicId, user.uid));
    startListener('appointments', () => loadStaffAppointments(currentClinicId, user.uid));
});

function listenToPendingAppointmentBadge(clinicId, staffUid = auth.currentUser?.uid) {
    const badge = document.getElementById('pendingAppointmentBadge');
    if (!badge) return;
    pendingBadgeSourceUnsubscribes.forEach(unsubscribe => unsubscribe());
    pendingBadgeSourceUnsubscribes = [];
    const sources = new Map();
    const renderBadge = () => {
        const appointments = [...new Map([...sources.values()].flat().map(item => [item.id, item])).values()];
        const count = appointments.filter(item => item.status === 'pending' && !pendingAppointmentExpired(item)).length;
        badge.textContent = count;
        badge.hidden = false;
    };
    const badgeTimer = setInterval(renderBadge, 1000);
    pendingBadgeSourceUnsubscribes.push(() => clearInterval(badgeTimer));
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

function countActivePatients(appointments, clinicId, now = Date.now()) {
    return new Set(appointments.filter(item => item.clinic_id === clinicId && item.resident_uid &&
        (item.status === 'in_progress' || (item.status === 'confirmed' && appointmentDeadline(item) > now)))
        .map(item => item.resident_uid)).size;
}

async function loadStaffAppointments(clinicId, staffUid = auth.currentUser?.uid) {
    const container = document.getElementById('staffAppointments');
    if (!container) return;
    appointmentSourceUnsubscribes.forEach(unsubscribe => unsubscribe());
    appointmentSourceUnsubscribes = [];
    const appointmentSources = new Map();
    const activePatientsElement = document.getElementById('statActivePatients');
    let clinicSourceState = 'loading';
    const updateActivePatients = () => {
        if (!activePatientsElement) return;
        activePatientsElement.textContent = clinicSourceState === 'ready'
            ? String(countActivePatients(appointmentSources.get('clinic') || [], clinicId))
            : clinicSourceState === 'error' ? 'Unavailable' : 'Loading...';
        activePatientsElement.title = clinicSourceState === 'error' ? 'Could not load active patients. Check your connection or reload.'
            : 'Unique residents with an active confirmed or in-progress appointment at this clinic.';
    };
    updateActivePatients();
    const renderAppointments = () => {
        updateActivePatients();
        const appointments = [...new Map([...appointmentSources.values()].flat().map(item => [item.id, item])).values()]
            .map(appointment => pendingAppointmentExpired(appointment) ? { ...appointment, status: 'expired' } : appointment)
            .filter(appointment => appointment.status === 'pending' && !appointment.archived)
            .sort((first, second) => `${second.preferred_date || ''} ${second.preferred_time || ''}`.localeCompare(`${first.preferred_date || ''} ${first.preferred_time || ''}`));
        // Accepted appointments continue in Patient Tracking; this list shows only active pending requests. Expired appointments are kept in History.

        if (!appointments.length) {
            container.innerHTML = '<p class="empty-appointments">No pending appointment requests. Expired appointments are available in History.</p>';
            return;
        }
                container.innerHTML = `<div class="resident-appointment-cards">${appointments.map(appointment => `
                        <article class="resident-appointment-card ${appointment.status === 'expired' ? 'expired-appointment' : ''}">
                            <div class="appointment-avatar"><i class="fa-solid fa-user"></i></div>
                            <div class="resident-appointment-info">
                                <h3>${escapeHtml(appointment.resident_name || 'Resident')}</h3>
                                <p>${escapeHtml(appointment.preferred_date || '')} &nbsp;·&nbsp; ${escapeHtml(appointment.preferred_time || '')}</p>
                                <div class="appointment-tags"><span>${escapeHtml(appointment.dose_label || 'Dose 1')}</span><span><i class="fa-regular fa-clock"></i> ${escapeHtml(appointment.preferred_time || '')}</span><span>${escapeHtml(appointment.clinic_name || '')}</span></div>
                            </div>
                            <div class="resident-appointment-actions">
                                <span class="appointment-status appointment-${escapeHtml(appointment.status || 'pending')}">${appointment.status === 'expired' ? 'Expired' : escapeHtml(appointment.status || 'pending')}</span>
                                ${appointment.status === 'expired' ? '<button type="button" class="confirm-appointment-btn" disabled>Accept</button><small>Expired before clinic confirmation</small>' : ''}
                                ${appointment.status === 'pending' ? `<button type="button" class="confirm-appointment-btn" data-confirm-id="${appointment.id}"><i class="fa-solid fa-circle-check"></i> Confirm</button><button type="button" class="decline-appointment-btn" data-decline-id="${appointment.id}"><i class="fa-solid fa-xmark"></i> Decline</button>` : ''}
                                ${appointment.status === 'confirmed' ? `<button type="button" class="confirm-appointment-btn" data-arrive-id="${appointment.id}">Mark Arrived</button><small>Arrival deadline: ${escapeHtml(new Date(appointmentDeadline(appointment)).toLocaleString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }))}</small>` : ''}
                                ${appointment.status === 'in_progress' && !appointment.intake_completed_at ? `<button type="button" class="confirm-appointment-btn" data-intake-id="${appointment.id}">Complete Intake</button>` : ''}
                                ${appointment.status === 'in_progress' && appointment.intake_completed_at ? `<button type="button" class="confirm-appointment-btn" data-complete-id="${appointment.id}">Complete Dose</button>` : ''}
                                ${appointment.status === 'completed' ? '<span class="dose-completed-label"><i class="fa-solid fa-circle-check"></i> Dose recorded</span>' : ''}
                            </div>
                        </article>`).join('')}</div>`;
                container.querySelectorAll('[data-view-id]').forEach(button => button.addEventListener('click', () => openAppointmentDetails(button.dataset.viewId)));
        container.querySelectorAll('[data-confirm-id]').forEach(button => button.addEventListener('click', () => acceptStaffAppointment(button.dataset.confirmId)));
                container.querySelectorAll('[data-decline-id]').forEach(button => button.addEventListener('click', () => declineStaffAppointment(button.dataset.declineId)));
                container.querySelectorAll('[data-complete-id]').forEach(button => button.addEventListener('click', () => openDoseCompletion(button.dataset.completeId, appointments.find(item => item.id === button.dataset.completeId))));
    };

    staffIntakeController?.abort();
    staffIntakeController = new AbortController();
    container.addEventListener('click', async event => {
        const button = event.target.closest('[data-arrive-id], [data-intake-id]');
        if (!button || button.disabled) return;
        const id = button.dataset.arriveId || button.dataset.intakeId;
        button.disabled = true;
        try {
            const snapshot = await getDoc(doc(db, 'appointments', id));
            if (button.dataset.arriveId) await markArrivalAndOpenIntake(id, snapshot.data());
            else openIntake(id, snapshot.data());
        } catch (error) { notifyDialog(error.message); }
        finally { button.disabled = false; }
    }, { signal: staffIntakeController.signal });

    let displayKey = '';
    const timer = setInterval(() => {
      updateActivePatients();
      const key = [...appointmentSources.values()].flat().map(item => item.id + ':' + pendingAppointmentExpired(item)).join('|');
      if (key !== displayKey) { displayKey = key; renderAppointments(); }
    }, 1000);
    appointmentSourceUnsubscribes.push(() => clearInterval(timer));
    const listenToSource = (sourceKey, appointmentQuery) => {
        const unsubscribe = onSnapshot(appointmentQuery, snapshot => {
            if (sourceKey === 'clinic') clinicSourceState = 'ready';
            appointmentSources.set(sourceKey, snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
            renderAppointments();
        }, error => {
            console.error(`Failed to load appointment source ${sourceKey}:`, error);
            if (sourceKey === 'clinic') clinicSourceState = 'error';
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
    try { await manageAppointment({ appointment_id: appointmentId, action: 'confirm' });
      notifyDialog('Appointment confirmed. You can now find it in Confirmed Appointments.');
    }
    catch (error) { notifyDialog('Could not confirm appointment: ' + error.message); }
}

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
        notifyDialog('Could not decline appointment: ' + error.message);
    } finally {
        if (button) { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-xmark"></i> Decline Appointment'; }
    }
}

function openDoseCompletion(appointmentId, appointment) {
    document.getElementById('completionAppointmentId').value = appointmentId;
    document.getElementById('completionDate').value = manilaToday();
    document.getElementById('completionDate').max = manilaToday();
    document.getElementById('completionDose').readOnly = true;
    document.getElementById('completionDose').value = Number(String(appointment?.dose_label || '1').match(/\d+/)?.[0] || 1);
    watchDoseStock(currentClinicId);
    reviewTreatment(document.getElementById('completionAppointmentId').value);
    document.getElementById('completionLocation').value = appointment?.clinic_address || '';
    document.getElementById('doseCompletionModal').style.display = 'flex';
    document.getElementById('doseCompletionModal').setAttribute('aria-hidden', 'false');
}

async function completeStaffDose(event) {
    event.preventDefault();
    try {
        if (!await saveStockDose(currentClinicId)) return;
        document.getElementById('doseCompletionModal').style.display = 'none';
        document.getElementById('doseCompletionForm').reset();
        await loadStaffAppointments(currentClinicId);
    } catch (error) {
        notifyDialog('Could not complete dose: ' + error.message);
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
        notifyDialog('Failed to load vaccine inventory.');
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
            stock_status: clinicStockStatus(totalStock),
            stock_summary: snapshot.docs.map(item => `${item.data().type || 'Vaccine'}: ${Number(item.data().quantity || 0)}`).join(' · ')
        }, { merge: true }).catch(error => console.error('Failed to publish clinic stock summary:', error));
    }, (error) => {
        console.error('Failed to load inventory:', error);
        notifyDialog('Failed to load vaccine inventory.');
    });
}


function expiryState(expiry) {
    if (!expiry || expiry <= manilaToday()) return ['expired', 'Expired'];
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
        const vaccine = vaccineBrands.find(brand => brand.value === canonicalVaccineName(item.type || item.brand_name));
        const brandName = item.brand_name || vaccine?.brand || String(item.type || '').replace(/\s*\([^)]+\)\s*$/, '') || '—';
        const genericName = item.generic_name || vaccine?.generic || String(item.type || '').match(/\(([^)]+)\)$/)?.[1] || '—';
        return `<tr><td><strong>${escapeHtml(brandName)}</strong></td><td>${escapeHtml(genericName)}</td><td>${escapeHtml(item.manufacturer)}</td><td>${escapeHtml(item.batch)}</td><td><strong>${category.quantity} doses</strong></td><td>${escapeHtml(item.expiry)}${expiryLabel ? `<div class="inventory-warning">${escapeHtml(expiryLabel)}</div>` : ''}</td><td><span class="status ${status}">${statusLabel}</span></td><td><div class="inventory-actions">${category.expired ? '' : `<button type="button" class="update-link" data-edit-id="${item.id}">Update</button><button type="button" class="inventory-action secondary" data-archive-id="${item.id}">${item.archived ? 'Restore' : 'Archive'}</button>`}<button type="button" class="inventory-action" data-delete-id="${item.id}">Delete</button></div></td></tr>`;
    }).join('') || '<tr><td colspan="8">No inventory batches match this filter.</td></tr>';
    tbody.querySelectorAll('[data-edit-id]').forEach(button => button.addEventListener('click', () => openModal(button.dataset.editId, inventoryItems.find(item => item.id === button.dataset.editId))));
    tbody.querySelectorAll('[data-archive-id]').forEach(button => button.addEventListener('click', () => updateDoc(doc(db, 'inventory', button.dataset.archiveId), { archived: !inventoryItems.find(item => item.id === button.dataset.archiveId)?.archived, updated_at: serverTimestamp() })));
    tbody.querySelectorAll('[data-delete-id]').forEach(button => button.addEventListener('click', async () => { if (!await confirmDialog('Delete this batch permanently?')) return; button.disabled = true; try { await deleteDoc(doc(db, 'inventory', button.dataset.deleteId)); } catch (error) { await notifyDialog('Could not delete the batch: ' + error.message); } finally { button.disabled = false; } }));
    const total = active.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    document.getElementById('statTotalStock').textContent = total;
    document.getElementById('statLowStock').textContent = lowCount;
    document.querySelector('.alert-box p').textContent = `${lowCount} usable batch${lowCount === 1 ? ' is' : 'es are'} below ${LOW_STOCK_THRESHOLD} doses.${expiryCount ? ` ${expiryCount} batch${expiryCount === 1 ? ' is' : 'es are'} expired.` : ''}`;
    setDoc(doc(db, 'clinics', currentClinicId), { stock_total: total, stock_status: clinicStockStatus(total), stock_summary: summarizeStock(active), updated_at: serverTimestamp() }, { merge: true }).catch(console.error);
}

function escapeHtml(value = '') {
    const element = document.createElement('div');
    element.textContent = value;
    return element.innerHTML;
}

function openModal(docId = '', data = {}) {
    if (docId && inventoryCategory(data).expired) { notifyDialog('Expired vaccine batches cannot be updated.'); return; }
    document.getElementById('modalTitle').textContent = docId ? 'Update Stock' : 'Add New Stock';
    document.getElementById('vaccineDocId').value = docId;
    setVaccineSelection(canonicalVaccineName(data.type || data.brand_name));
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
        notifyDialog('Your staff account is not linked to a clinic. Add a clinic_id to your users profile first.');
        return;
    }
    const docId = document.getElementById('vaccineDocId').value;
    if (docId && inventoryCategory(inventoryItems.find(item => item.id === docId) || {}).expired) { notifyDialog('This batch has expired and cannot be updated.'); closeModal(); return; }
    const selectedVaccine = vaccineBrands.find(item => item.value === vaccineBrandSelect.value);
    if (!selectedVaccine || selectedVaccine.generic !== vaccineGenericSelect.value) { notifyDialog('Select a matching vaccine brand and generic name/type.'); return; }
    const payload = {
        brand_name: selectedVaccine.brand,
        generic_name: selectedVaccine.generic,
        clinic_id: currentClinicId,
        type: document.getElementById('vacType').value.trim(),
        manufacturer: document.getElementById('vacManufacturer').value.trim(),
        batch: document.getElementById('vacBatch').value.trim(),
        quantity: Number(document.getElementById('vacQuantity').value),
        expiry: document.getElementById('vacExpiry').value,
        archived: docId ? Boolean(inventoryItems.find(item => item.id === docId)?.archived) : false,
        updated_at: serverTimestamp()
    };

    if (payload.expiry <= manilaToday()) {
        if (!await confirmDialog('This batch is already expired. Save it as an archived record?')) return;
        payload.archived = true;
    }
    const duplicate = inventoryItems.find(item => item.id !== docId && !item.archived && item.batch?.toLowerCase() === payload.batch.toLowerCase());
    if (duplicate) { notifyDialog('This clinic already has an active record for that batch number. Update the existing batch instead.'); return; }

    try {
        if (docId) await updateDoc(doc(db, 'inventory', docId), payload);
        else await addDoc(collection(db, 'inventory'), payload);
        closeModal();
    } catch (error) {
        console.error('Error saving vaccine record:', error);
        const reason = error.code ? ` (${error.code})` : '';
        notifyDialog(`Failed to save inventory record${reason}: ${error.message || 'Unknown Firebase error.'}`);
    }
});

// The optional chaining matters: a missing element previously threw a
// TypeError here, which aborted the rest of the module.
document.querySelector('.signout-btn')?.addEventListener('click', async () => {
    try {
        await signOutUser();
    } catch (error) {
        console.error('Sign out failed:', error);
        notifyDialog('Could not sign out: ' + (error.message || 'Unknown error.'));
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
        // The resident may skip the wound photo, so "not provided" is a normal
        // outcome rather than an error to chase.
        const woundPhotoMarkup = appointment.wound_photo_url
            ? `<a href="${escapeHtml(appointment.wound_photo_url)}" target="_blank" rel="noopener"><img class="appointment-photo-preview" src="${escapeHtml(appointment.wound_photo_url)}" alt="Resident wound photo"></a>`
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

let inventoryDisplayDate = manilaToday();
setInterval(() => {
    const date = manilaToday();
    if (date !== inventoryDisplayDate) { inventoryDisplayDate = date; if (currentClinicId) renderInventory(); }
}, 1000);
