import { auth, db, fetchUserProfile } from './scripts/firebase.js';
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import { 
    collection, 
    doc, 
    getDoc, 
    setDoc, 
    updateDoc, 
    addDoc, 
    onSnapshot, 
    query, 
    where 
} from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
import { protectPage } from './scripts/role-guard.js';

protectPage('clinic_staff');

let currentClinicId = null;

// Tab Switcher
const tabInventoryBtn = document.getElementById('tabInventoryBtn');
const tabProfileBtn = document.getElementById('tabProfileBtn');
const inventorySection = document.getElementById('inventorySection');
const profileSection = document.getElementById('profileSection');

tabInventoryBtn.addEventListener('click', () => {
    tabInventoryBtn.classList.add('active-tab');
    tabProfileBtn.classList.remove('active-tab');
    inventorySection.style.display = 'block';
    profileSection.style.display = 'none';
});

tabProfileBtn.addEventListener('click', () => {
    tabProfileBtn.classList.add('active-tab');
    tabInventoryBtn.classList.remove('active-tab');
    profileSection.style.display = 'block';
    inventorySection.style.display = 'none';
});

// Auth state handling
onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    const profile = await fetchUserProfile(user.uid);
    if (!profile) return;

    currentClinicId = profile.clinic_id || user.uid;

    loadClinicProfile(currentClinicId);
    listenToInventory(currentClinicId);
});

// --- CLINIC PROFILE CRUD ---
async function loadClinicProfile(clinicId) {
    try {
        const docRef = doc(db, 'clinics', clinicId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            const data = docSnap.data();
            document.getElementById('clinicDashboardTitle').textContent = data.name || "Clinic Dashboard";
            document.getElementById('profName').value = data.name || '';
            document.getElementById('profContact').value = data.contact || '';
            document.getElementById('profHours').value = data.hours || '';
        }
    } catch (err) {
        console.error("Failed to load clinic profile:", err);
    }
}

document.getElementById('clinicProfileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentClinicId) return;

    const name = document.getElementById('profName').value;
    const contact = document.getElementById('profContact').value;
    const hours = document.getElementById('profHours').value;

    try {
        await setDoc(doc(db, 'clinics', currentClinicId), {
            name,
            contact,
            hours
        }, { merge: true });

        document.getElementById('clinicDashboardTitle').textContent = name;
        alert('Clinic profile updated successfully!');
    } catch (err) {
        console.error("Error saving profile:", err);
        alert('Failed to update profile.');
    }
});

// --- INVENTORY MANAGEMENT (Real-Time) ---
function listenToInventory(clinicId) {
    const q = query(collection(db, 'inventory'), where('clinic_id', '==', clinicId));

    onSnapshot(q, (snapshot) => {
        const tbody = document.getElementById('inventoryTableBody');
        tbody.innerHTML = '';

        let totalStock = 0;
        let lowStockCount = 0;

        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const id = docSnap.id;
            const qty = parseInt(data.quantity || 0, 10);
            totalStock += qty;

            let statusClass = 'adequate';
            if (qty <= 5) {
                statusClass = 'critical';
                lowStockCount++;
            } else if (qty <= 15) {
                statusClass = 'low';
                lowStockCount++;
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${data.type}</strong></td>
                <td>${data.manufacturer}</td>
                <td>${data.batch}</td>
                <td><strong>${qty} doses</strong></td>
                <td>${data.expiry}</td>
                <td><span class="status ${statusClass}">${statusClass}</span></td>
                <td>
                    <button class="edit-item-btn" data-id="${id}">
                        <i class="fa-regular fa-pen-to-square"></i> Update
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        document.getElementById('statTotalStock').textContent = totalStock;
        document.getElementById('statLowStock').textContent = lowStockCount;

        // Attach event listeners to Edit buttons
        document.querySelectorAll('.edit-item-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const docId = e.currentTarget.getAttribute('data-id');
                const docData = snapshot.docs.find((d) => d.id === docId).data();
                openModal(docId, docData);
            });
        });
    });
}

// Modal Handlers
const modal = document.getElementById('vaccineModal');
const vaccineForm = document.getElementById('vaccineForm');

document.getElementById('openAddModalBtn').addEventListener('click', () => openModal());
document.getElementById('closeModalBtn').addEventListener('click', closeModal);

function openModal(docId = null, data = null) {
    modal.style.display = 'flex';
    if (docId && data) {
        document.getElementById('modalTitle').textContent = 'Update Stock';
        document.getElementById('vaccineDocId').value = docId;
        document.getElementById('vacType').value = data.type || '';
        document.getElementById('vacManufacturer').value = data.manufacturer || '';
        document.getElementById('vacBatch').value = data.batch || '';
        document.getElementById('vacQuantity').value = data.quantity || 0;
        document.getElementById('vacExpiry').value = data.expiry || '';
    } else {
        document.getElementById('modalTitle').textContent = 'Add New Stock';
        vaccineForm.reset();
        document.getElementById('vaccineDocId').value = '';
    }
}

function closeModal() {
    modal.style.display = 'none';
    vaccineForm.reset();
}

vaccineForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentClinicId) return;

    const docId = document.getElementById('vaccineDocId').value;
    const payload = {
        clinic_id: currentClinicId,
        type: document.getElementById('vacType').value,
        manufacturer: document.getElementById('vacManufacturer').value,
        batch: document.getElementById('vacBatch').value,
        quantity: Number(document.getElementById('vacQuantity').value),
        expiry: document.getElementById('vacExpiry').value
    };

    try {
        if (docId) {
            await updateDoc(doc(db, 'inventory', docId), payload);
        } else {
            await addDoc(collection(db, 'inventory'), payload);
        }
        closeModal();
    } catch (err) {
        console.error("Error saving vaccine record:", err);
        alert('Failed to save inventory record.');
    }
});

// Sign Out
document.querySelector('.signout-btn').addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = 'login.html';
});