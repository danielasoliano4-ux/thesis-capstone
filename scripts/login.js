import { auth, db, authPersistenceReady } from './firebase.js';
import { signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
import { routes } from './routes.js';

console.log('login.js loaded');

const rolePages = {
  resident:     'residents.html',
  clinic_staff: 'staff.html',
  admin:        routes.adminDashboard
};

const loginRoles = {
  resident: 'resident',
  staff: 'clinic_staff',
  admin: 'admin'
};

function showLoginMessage(message) {
  const messageBox = document.getElementById('loginMessage');
  const messageText = document.getElementById('loginMessageText');
  if (messageBox && messageText) {
    messageText.textContent = message;
    messageBox.hidden = false;
  }
}

function clearLoginMessage() {
  const messageBox = document.getElementById('loginMessage');
  if (messageBox) messageBox.hidden = true;
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const email    = document.getElementById('emailInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  const btn      = document.getElementById('loginBtn');

  clearLoginMessage();
  if (!email || !password) {
    showLoginMessage('Please enter your email and password.');
    return;
  }

  const originalText = btn.textContent;
  btn.textContent = 'Signing in...';
  btn.disabled = true;

  try {
    await authPersistenceReady;
    const userCred = await signInWithEmailAndPassword(auth, email, password);
    const uid = userCred.user.uid;
    const selectedRole = window.currentRole || 'resident';
    const expectedRole = loginRoles[selectedRole];

    const userDoc = await getDoc(doc(db, 'users', uid));
    if (!userDoc.exists()) {
      showLoginMessage('Account not found in the system. Please contact your administrator.');
      await signOut(auth);
      btn.textContent = originalText;
      btn.disabled = false;
      return;
    }

    const profile = userDoc.data();
    const role = profile.role;
    const hasExpectedRole = role === expectedRole
      || (expectedRole === 'admin' && role === 'administrator');
    if (!hasExpectedRole) {
      const roleLabels = {
        resident: 'resident',
        clinic_staff: 'clinic staff',
        admin: 'administrator'
      };
      showLoginMessage(`This account does not have ${roleLabels[expectedRole] || 'this'} access.`);
      await signOut(auth);
      btn.textContent = originalText;
      btn.disabled = false;
      return;
    }

    // The approval gate only applies to newly registered clinic staff, whose
    // profile is written with approval_status 'pending'. Existing clinic staff
    // accounts may have no approval_status field at all, so only an explicit
    // 'pending' or 'denied' status should block sign-in.
    if (role === 'clinic_staff' && (profile.approval_status === 'pending' || profile.approval_status === 'denied')) {
      showLoginMessage(profile.approval_status === 'denied'
        ? 'Your clinic staff registration was not approved. Please contact an administrator.'
        : 'Your clinic staff account is pending administrator approval.');
      await signOut(auth);
      btn.textContent = originalText;
      btn.disabled = false;
      return;
    }

    const page = rolePages[expectedRole];

    if (!page) {
      showLoginMessage('Unknown role. Please contact your administrator.');
      btn.textContent = originalText;
      btn.disabled = false;
      return;
    }

    window.location.href = page;

  } catch (err) {
    btn.textContent = originalText;
    btn.disabled = false;

    // Surface the real failure in the console — otherwise every unrecognised
    // error collapses into the same generic "check your connection" message.
    console.error('Login failed:', err.code || err.name, err.message, err);

    if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' || err.code === 'auth/invalid-email') {
      showLoginMessage('The email or password is incorrect. Check your details or register for an account.');
    } else if (err.code === 'auth/wrong-password') {
      showLoginMessage('The password is incorrect. Please try again.');
    } else if (err.code === 'auth/too-many-requests') {
      showLoginMessage('Too many failed attempts. Please wait a moment before trying again.');
    } else if (err.code === 'auth/network-request-failed') {
      showLoginMessage('Network error. Check your internet connection and try again.');
    } else if (err.code === 'auth/invalid-api-key' || err.code === 'auth/configuration-not-found') {
      showLoginMessage('Login is not configured correctly. Please contact your administrator.');
    } else if (err.code === 'permission-denied' || err.code === 'unavailable') {
      showLoginMessage('Could not read your account profile. Please contact your administrator.');
    } else {
      showLoginMessage(`Login failed (${err.code || 'unknown error'}). Please try again.`);
    }
  }
});
