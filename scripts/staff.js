import { auth, db, fetchUserProfile } from './firebase.js';
import { signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { addDoc, collection, doc, getDoc, onSnapshot, query, setDoc, updateDoc, where, getDocs, serverTimestamp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { protectPage } from './role-guard.js';

protectPage('clinic_staff');

let currentClinicId = null;
const modal = document.getElementById('vaccineModal');
const vaccineForm = document.getElementById('vaccineForm');

// Auth state handling
onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    const profile = await fetchUserProfile(user.uid);
    if (!profile) return;

    currentClinicId = profile.clinic_id || user.uid;

    await setDoc(doc(db, 'clinics', currentClinicId), { staff_uid: user.uid }, { merge: true });

    listenToInventory(currentClinicId);
    listenToActivePatients(currentClinicId);
    loadStaffAppointments(currentClinicId);
});

async function loadStaffAppointments(clinicId) {
    const container = document.getElementById('staffAppointments');
    if (!container) return;
    try {
        const snapshot = await getDocs(query(collection(db, 'appointments'), where('clinic_id', '==', clinicId)));
        const appointments = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
            .sort((first, second) => `${first.preferred_date || ''} ${first.preferred_time || ''}`.localeCompare(`${second.preferred_date || ''} ${second.preferred_time || ''}`));
        if (!appointments.length) {
            container.innerHTML = '<p class="empty-appointments">No resident appointments for this clinic.</p>';
            return;
        }
        container.innerHTML = `<table><thead><tr><th>RESIDENT</th><th>DATE</th><th>DOSE</th><th>STATUS</th><th>ACTIONS</th></tr></thead><tbody>${appointments.map(appointment => `
            <tr><td><strong>${escapeHtml(appointment.resident_name || 'Resident')}</strong></td><td>${escapeHtml(appointment.preferred_date || '')} ${escapeHtml(appointment.preferred_time || '')}</td><td>${escapeHtml(appointment.dose_label || 'Dose 1')}</td><td><span class="appointment-status appointment-${escapeHtml(appointment.status || 'pending')}">${escapeHtml(appointment.status || 'pending')}</span></td><td class="appointment-actions">
              ${appointment.status === 'pending' ? `<button type="button" class="update-link" data-confirm-id="${appointment.id}"><i class="fa-solid fa-check"></i> Accept</button>` : ''}
              ${appointment.status === 'confirmed' ? `<button type="button" class="update-link complete-dose-btn" data-complete-id="${appointment.id}"><i class="fa-solid fa-syringe"></i> Complete Dose</button>` : ''}
              ${appointment.status === 'completed' ? '<span class="dose-completed-label"><i class="fa-solid fa-circle-check"></i> Dose recorded</span>' : ''}
            </td></tr>`).join('')}</tbody></table>`;
        container.querySelectorAll('[data-confirm-id]').forEach(button => button.addEventListener('click', () => acceptStaffAppointment(button.dataset.confirmId)));
        container.querySelectorAll('[data-complete-id]').forEach(button => button.addEventListener('click', () => openDoseCompletion(button.dataset.completeId, appointments.find(item => item.id === button.dataset.completeId))));
    } catch (error) {
        container.innerHTML = `<p class="empty-appointments">Could not load appointments: ${escapeHtml(error.message)}</p>`;
    }
}

async function acceptStaffAppointment(appointmentId) {
    try {
        const appointment = (await getDoc(doc(db, 'appointments', appointmentId))).data();
        await updateDoc(doc(db, 'appointments', appointmentId), {
            status: 'confirmed',
            reschedule_requested: false,
            confirmed_at: serverTimestamp()
        });
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
    const vaccineName = document.getElementById('completionVaccine').value.trim();
    const location = document.getElementById('completionLocation').value.trim();
    const doseNumber = Number(document.getElementById('completionDose').value);
    try {
        const appointmentSnap = await getDoc(doc(db, 'appointments', appointmentId));
        const appointment = appointmentSnap.exists() ? appointmentSnap.data() : null;
        if (!appointment) throw new Error('Appointment was not found.');
        const inventorySnap = await getDocs(query(collection(db, 'inventory'), where('clinic_id', '==', currentClinicId)));
        if (!inventorySnap.docs.some(item => item.data().type === vaccineName && Number(item.data().quantity || 0) > 0)) throw new Error(`No available ${vaccineName} stock at this clinic.`);
        const existing = await getDocs(query(collection(db, 'vaccination_records'), where('appointment_id', '==', appointmentId)));
        if (!existing.empty) throw new Error('This appointment already has a completed dose.');
        await addDoc(collection(db, 'vaccination_records'), {
            resident_uid: appointment.resident_uid, resident_name: appointment.resident_name || '', appointment_id: appointmentId,
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

function escapeHtml(value = '') {
    const element = document.createElement('div');
    element.textContent = value;
    return element.innerHTML;
}

function openModal(docId = '', data = {}) {
    document.getElementById('modalTitle').textContent = docId ? 'Update Stock' : 'Add New Stock';
    document.getElementById('vaccineDocId').value = docId;
    document.getElementById('vacType').value = data.type || '';
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
        expiry: document.getElementById('vacExpiry').value
    };

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

document.querySelector('.signout-btn').addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = 'login.html';
});

document.getElementById('refreshAppointmentsBtn')?.addEventListener('click', () => loadStaffAppointments(currentClinicId));
document.getElementById('closeDoseCompletionBtn')?.addEventListener('click', () => {
    const modal = document.getElementById('doseCompletionModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
});
document.getElementById('doseCompletionForm')?.addEventListener('submit', completeStaffDose);
