import { auth, db } from './firebase.js';
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";

const policyModal = document.getElementById('policyModal');
const policyTitle = document.getElementById('policyTitle');
const policyContent = document.getElementById('policyContent');
const policies = {
  terms: {
    title: 'Terms of Service',
    content: '<p>By using the Anti-Rabies Locator System, you agree to provide accurate information and use the service only for appointment booking, vaccination tracking, and related public health services.</p><h3>Acceptable Use</h3><p>Do not submit false information, access another person\'s account, or misuse clinic and health information.</p><h3>Appointments</h3><p>Booking requests are subject to clinic confirmation. Please arrive on time and contact the clinic if you need to cancel or reschedule.</p>'
  },
  privacy: {
    title: 'Privacy Policy',
    content: '<p>We collect the information needed to create your account, process appointments, contact you about bookings, and support anti-rabies vaccination services.</p><h3>Information We Use</h3><p>This may include your name, email, phone number, barangay, address, appointment details, and bite information you choose to provide.</p><h3>Data Sharing</h3><p>Your appointment and health-related details are shared only with the clinic handling your appointment and authorized system administrators.</p><h3>Your Responsibility</h3><p>Keep your password private and provide accurate information. Contact the system administrator if you need help correcting your records.</p>'
  }
};

document.querySelectorAll('[data-policy]').forEach(link => {
  link.addEventListener('click', event => {
    event.preventDefault();
    const policy = policies[link.dataset.policy];
    policyTitle.textContent = policy.title;
    policyContent.innerHTML = policy.content;
    policyModal.classList.add('open');
    policyModal.setAttribute('aria-hidden', 'false');
  });
});

function closePolicy() {
  policyModal.classList.remove('open');
  policyModal.setAttribute('aria-hidden', 'true');
}

document.getElementById('policyClose').addEventListener('click', closePolicy);
policyModal.addEventListener('click', event => {
  if (event.target === policyModal) closePolicy();
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
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