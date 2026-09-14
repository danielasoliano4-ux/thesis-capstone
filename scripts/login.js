import { auth, db, authPersistenceReady } from './firebase.js';
import { signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

console.log('login.js loaded');

const rolePages = {
  resident:     'residents.html',
  clinic_staff: 'staff.html',
  admin:        'admin.html'
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

    const role = userDoc.data().role;
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

    if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' || err.code === 'auth/invalid-email') {
      showLoginMessage('The email or password is incorrect. Check your details or register for an account.');
    } else if (err.code === 'auth/wrong-password') {
      showLoginMessage('The password is incorrect. Please try again.');
    } else if (err.code === 'auth/too-many-requests') {
      showLoginMessage('Too many failed attempts. Please wait a moment before trying again.');
    } else {
      showLoginMessage('Login failed. Please check your connection and try again.');
    }
  }
});
