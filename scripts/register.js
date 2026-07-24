import { auth, db } from '../firebase-config.js';
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

document.querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const firstName = document.getElementById('firstName').value.trim();
  const lastName  = document.getElementById('lastName').value.trim();
  const email     = document.getElementById('emailInput').value.trim();
  const phone     = document.getElementById('phoneInput').value.trim();
  const barangay  = document.getElementById('barangaySelect').value;
  const password  = document.getElementById('pw').value;
  const password2 = document.getElementById('pw2').value;

  if (!barangay) {
    alert('Please select your barangay.');
    return;
  }
  if (password !== password2) {
    alert('Passwords do not match.');
    return;
  }
  if (password.length < 8) {
    alert('Password must be at least 8 characters.');
    return;
  }

  const btn = document.querySelector('.register-btn');
  btn.textContent = 'Creating account...';
  btn.disabled = true;

  try {
    const userCred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = userCred.user.uid;

    await setDoc(doc(db, 'users', uid), {
      uid,
      email,
      role: 'resident',
      full_name: firstName + ' ' + lastName,
      phone,
      is_active: true,
      created_at: serverTimestamp()
    });

    await setDoc(doc(db, 'residents', uid), {
      uid,
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      barangay,
      created_at: serverTimestamp()
    });

    alert('Account created successfully! You can now sign in.');
    window.location.href = 'login.html';

  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account';

    if (err.code === 'auth/email-already-in-use') {
      alert('That email is already registered. Please sign in instead.');
    } else if (err.code === 'auth/invalid-email') {
      alert('Please enter a valid email address.');
    } else if (err.code === 'auth/weak-password') {
      alert('Password is too weak. Use at least 8 characters.');
    } else {
      alert('Registration failed: ' + err.message);
    }
  }
});