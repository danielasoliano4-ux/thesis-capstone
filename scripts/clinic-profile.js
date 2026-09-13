import { auth, db, fetchUserProfile } from './firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { doc, getDoc, setDoc, addDoc, collection, serverTimestamp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { protectPage } from './role-guard.js';

protectPage('clinic_staff');

let currentClinicId = null;
let currentClinicProfile = null;
const form = document.getElementById('clinicProfileForm');
const defaultProfile = {
    name: document.getElementById('profileName').value,
    type: document.getElementById('profileType').value,
    address: document.getElementById('profileAddress').value,
    contact: document.getElementById('profileContact').value,
    email: document.getElementById('profileEmail').value,
    weekdayHours: document.getElementById('profileWeekdayHours').value,
    weekendHours: document.getElementById('profileWeekendHours').value,
    reservationDays: document.getElementById('profileReservationDays').value,
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
        currentClinicProfile = profile;
        document.getElementById('profileName').value = profile.name || '';
        const clinicType = document.getElementById('profileType');
        clinicType.value = ['Animal Bite Center', 'Animal Bite Treatment Center'].includes(profile.type)
            ? profile.type
            : 'Animal Bite Center';
        document.getElementById('profileAddress').value = profile.address || '';
        document.getElementById('profileContact').value = profile.contact || '';
        document.getElementById('profileEmail').value = profile.email || '';
        document.getElementById('profileWeekdayHours').value = profile.weekdayHours || '';
        document.getElementById('profileWeekendHours').value = profile.weekendHours || '';
        document.getElementById('profileReservationDays').value = ['1', '2', '3'].includes(String(profile.reservationDays))
            ? String(profile.reservationDays)
            : '1';
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
        reservationDays: Number(document.getElementById('profileReservationDays').value),
        services: [...document.querySelectorAll('input[name="services"]:checked')].map((input) => input.value)
    };

    try {
        const changes = getProfileChanges(currentClinicProfile || {}, profile);
        await setDoc(doc(db, 'clinics', currentClinicId), profile, { merge: true });
        try {
            await addDoc(collection(db, 'history'), { clinic_id: currentClinicId, type: 'clinic_profile', action: 'updated', changes, performed_by: auth.currentUser.uid, created_at: serverTimestamp() });
            currentClinicProfile = { ...currentClinicProfile, ...profile };
            alert('Clinic profile saved and added to History.');
        } catch (historyError) {
            console.warn('Clinic profile saved, but history could not be recorded:', historyError);
            alert(`Clinic profile saved, but History was not recorded: ${historyError.code || historyError.message}`);
        }
    } catch (error) {
        console.error('Failed to save clinic profile:', error);
        alert(`Failed to save clinic profile: ${error.code || error.message}`);
    }
});

function getProfileChanges(before, after) {
    const labels = {
        name: 'Clinic name', type: 'Clinic type', address: 'Address', contact: 'Contact', email: 'Email',
        weekdayHours: 'Weekday operating hours', weekendHours: 'Weekend operating hours', reservationDays: 'Reservation days', services: 'Services offered'
    };
    return Object.keys(labels).reduce((changes, field) => {
        const oldValue = Array.isArray(before[field]) ? [...before[field]].sort().join(', ') : String(before[field] ?? '');
        const newValue = Array.isArray(after[field]) ? [...after[field]].sort().join(', ') : String(after[field] ?? '');
        if (oldValue !== newValue) changes.push({ field, label: labels[field], before: oldValue || 'Not set', after: newValue || 'Not set' });
        return changes;
    }, []);
}

document.querySelector('.cancel-btn').addEventListener('click', () => {
    if (currentClinicId) loadProfile(currentClinicId);
});

document.querySelector('.signout-btn').addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = 'login.html';
});
