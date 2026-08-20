import { auth, db, fetchUserProfile } from './firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { protectPage } from './role-guard.js';

protectPage('clinic_staff');

let currentClinicId = null;
const form = document.getElementById('clinicProfileForm');
const defaultProfile = {
    name: document.getElementById('profileName').value,
    type: document.getElementById('profileType').value,
    address: document.getElementById('profileAddress').value,
    contact: document.getElementById('profileContact').value,
    email: document.getElementById('profileEmail').value,
    weekdayHours: document.getElementById('profileWeekdayHours').value,
    weekendHours: document.getElementById('profileWeekendHours').value,
    services: [...document.querySelectorAll('input[name="services"]:checked')].map((input) => input.value)
};

onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    const profile = await fetchUserProfile(user.uid);
    if (!profile) return;
    currentClinicId = profile.clinic_id || user.uid;
    await loadProfile(currentClinicId);
});

async function loadProfile(clinicId) {
    try {
        const profileSnapshot = await getDoc(doc(db, 'clinics', clinicId));
        if (!profileSnapshot.exists()) return;
        const profile = { ...defaultProfile, ...profileSnapshot.data() };
        document.getElementById('profileName').value = profile.name || '';
        document.getElementById('profileType').value = profile.type || '';
        document.getElementById('profileAddress').value = profile.address || '';
        document.getElementById('profileContact').value = profile.contact || '';
        document.getElementById('profileEmail').value = profile.email || '';
        document.getElementById('profileWeekdayHours').value = profile.weekdayHours || '';
        document.getElementById('profileWeekendHours').value = profile.weekendHours || '';
        document.querySelectorAll('input[name="services"]').forEach((input) => {
            input.checked = (profile.services || []).includes(input.value);
        });
    } catch (error) {
        console.error('Failed to load clinic profile:', error);
        alert('Failed to load clinic profile.');
    }
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentClinicId) return;
    const profile = {
        name: document.getElementById('profileName').value.trim(),
        type: document.getElementById('profileType').value.trim(),
        address: document.getElementById('profileAddress').value.trim(),
        contact: document.getElementById('profileContact').value.trim(),
        email: document.getElementById('profileEmail').value.trim(),
        weekdayHours: document.getElementById('profileWeekdayHours').value.trim(),
        weekendHours: document.getElementById('profileWeekendHours').value.trim(),
        services: [...document.querySelectorAll('input[name="services"]:checked')].map((input) => input.value)
    };

    try {
        await setDoc(doc(db, 'clinics', currentClinicId), profile, { merge: true });
        alert('Clinic profile saved successfully.');
    } catch (error) {
        console.error('Failed to save clinic profile:', error);
        alert('Failed to save clinic profile.');
    }
});

document.querySelector('.cancel-btn').addEventListener('click', () => {
    if (currentClinicId) loadProfile(currentClinicId);
});

document.querySelector('.signout-btn').addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = 'login.html';
});
