import { auth, db } from './firebase-config.js';
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const roles = {
    resident: {
        label: 'Resident',
        buttonText: 'Sign In as Resident',
        features: [
            'Book and manage appointments',
            'Receive vaccination reminders',
            'Access first-aid guidelines',
            'View vaccination schedule'
        ]
    },
    staff: {
        label: 'Clinic Staff',
        buttonText: 'Sign In as Clinic Staff',
        features: [
            'Manage vaccine inventory',
            'Update patient dosage records',
            'Track stock levels',
            'Generate clinic reports'
        ]
    },
    admin: {
        label: 'Administrator',
        buttonText: 'Sign In as Administrator',
        features: [
            'Monitor system analytics',
            'Review clinic performance',
            'Approve user access',
            'Manage reports'
        ]
    }
};

const roleBoxes = document.querySelectorAll('.role-box');
const loginBtn = document.getElementById('loginBtn');
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const featuresHeading = document.getElementById('featuresHeading');
const featuresList = document.getElementById('featuresList');

let currentRole = 'resident';

function updateFeatures(role) {
    const roleData = roles[role];
    featuresHeading.textContent = roleData.label + ' Features:';
    featuresList.innerHTML = roleData.features.map(f => `<li>${f}</li>`).join('');
    loginBtn.textContent = roleData.buttonText;
    currentRole = role;

    roleBoxes.forEach(box => {
        const icon = box.querySelector('.role-icon');
        const isActive = box.dataset.role === role;
        box.classList.toggle('active-role', isActive);
        icon.classList.toggle('red', isActive);
        icon.classList.toggle('gray', !isActive);
    });
}

roleBoxes.forEach(box => {
    box.addEventListener('click', () => updateFeatures(box.dataset.role));
});

loginBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();

    if (!email || !password) {
        alert('Please enter your email and password.');
        return;
    }

    try {
        loginBtn.textContent = 'Signing in...';
        loginBtn.disabled = true;

        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const uid = userCredential.user.uid;

        const userDoc = await getDoc(doc(db, 'users', uid));

        if (!userDoc.exists()) {
            alert('Account not found. Please contact the administrator.');
            loginBtn.disabled = false;
            updateFeatures(currentRole);
            return;
        }

        const userData = userDoc.data();

        if (!userData.is_active) {
            alert('Your account has been disabled. Please contact the administrator.');
            loginBtn.disabled = false;
            updateFeatures(currentRole);
            return;
        }

        const rolePages = {
            resident: 'residents.html',
            clinic_staff: 'staff.html',
            admin: 'admin.html'
        };

        const page = rolePages[userData.role];
        if (page) {
            window.location.href = page;
        } else {
            alert('Unknown role. Please contact the administrator.');
            loginBtn.disabled = false;
            updateFeatures(currentRole);
        }

    } catch (error) {
        loginBtn.disabled = false;
        updateFeatures(currentRole);

        if (error.code === 'auth/user-not-found' ||
            error.code === 'auth/wrong-password' ||
            error.code === 'auth/invalid-credential') {
            alert('Invalid email or password. Please try again.');
        } else if (error.code === 'auth/too-many-requests') {
            alert('Too many failed attempts. Please try again later.');
        } else {
            alert('Login failed: ' + error.message);
        }
    }
});

updateFeatures('resident');