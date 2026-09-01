import { auth, db, fetchUserProfile } from './firebase.js';
import { signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { addDoc, collection, doc, onSnapshot, query, setDoc, updateDoc, where, getDocs } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
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
});

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
