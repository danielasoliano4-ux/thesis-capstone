import { auth, db } from '../firebase-config.js';
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const rolePages = {
  resident:     'residents.html',
  clinic_staff: 'staff.html',
  admin:        'admin.html'
};

document.getElementById('loginBtn').addEventListener('click', async () => {
  const email    = document.querySelector('input[type="text"]').value.trim();
  const password = document.querySelector('input[type="password"]').value;
  const btn      = document.getElementById('loginBtn');

  if (!email || !password) {
    alert('Please enter your email and password.');
    return;
  }

  const originalText = btn.textContent;
  btn.textContent = 'Signing in...';
  btn.disabled = true;

  try {
    const userCred = await signInWithEmailAndPassword(auth, email, password);
    const uid = userCred.user.uid;

    const userDoc = await getDoc(doc(db, 'users', uid));
    if (!userDoc.exists()) {
      alert('Account not found in database. Contact your administrator.');
      btn.textContent = originalText;
      btn.disabled = false;
      return;
    }

    const role = userDoc.data().role;
    const page = rolePages[role];

    if (!page) {
      alert('Unknown role. Contact your administrator.');
      btn.textContent = originalText;
      btn.disabled = false;
      return;
    }

    window.location.href = page;

  } catch (err) {
    btn.textContent = originalText;
    btn.disabled = false;

    if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' || err.code === 'auth/invalid-email') {
      alert('No account found with that email. Please register first.');
    } else if (err.code === 'auth/wrong-password') {
      alert('Incorrect password. Please try again.');
    } else if (err.code === 'auth/too-many-requests') {
      alert('Too many failed attempts. Please wait a moment and try again.');
    } else {
      alert('Login failed: ' + err.message);
    }
  }
});