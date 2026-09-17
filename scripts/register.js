import { auth, db, storage } from './firebase.js';
import { createUserWithEmailAndPassword, deleteUser } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-storage.js";

const ICONS = {
  success: 'fa-solid fa-circle-check',
  error: 'fa-solid fa-circle-exclamation',
  warning: 'fa-solid fa-triangle-exclamation',
  info: 'fa-solid fa-circle-info'
};

function showToast(message, type = 'info') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `
    <i class="toast-icon ${ICONS[type] || ICONS.info}"></i>
    <div class="toast-body">
      <p class="toast-title">${type === 'success' ? 'Success' : type === 'error' ? 'Registration failed' : type === 'warning' ? 'Check your details' : 'Notice'}</p>
      <p class="toast-message"></p>
    </div>
    <button type="button" class="toast-close" aria-label="Dismiss">&times;</button>
    <span class="toast-progress"></span>
  `;
  toast.querySelector('.toast-message').textContent = message;

  let timer = null;
  const remove = () => {
    clearTimeout(timer);
    toast.classList.remove('show');
    toast.classList.add('hide');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  };

  toast.querySelector('.toast-close').addEventListener('click', remove);
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  timer = setTimeout(remove, 5000);
}

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

const accountRole = document.getElementById('accountRole');
const staffRegistrationFields = document.getElementById('staffRegistrationFields');
const clinicNameInput = document.getElementById('clinicName');
const clinicAddressInput = document.getElementById('clinicAddress');
const certificateInput = document.getElementById('bploCertificate');

function updateRegistrationFields() {
  const isStaff = accountRole.value === 'clinic_staff';
  staffRegistrationFields.hidden = !isStaff;
  clinicNameInput.required = isStaff;
  clinicAddressInput.required = isStaff;
  certificateInput.required = isStaff;
}

accountRole.addEventListener('change', updateRegistrationFields);
if (new URLSearchParams(window.location.search).get('role') === 'clinic_staff') {
  accountRole.value = 'clinic_staff';
}
updateRegistrationFields();

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const firstName = document.getElementById('firstName').value.trim();
  const lastName  = document.getElementById('lastName').value.trim();
  const email     = document.getElementById('emailInput').value.trim();
  const phone     = document.getElementById('phoneInput').value.trim();
  const barangay  = document.getElementById('barangaySelect').value;
  const password  = document.getElementById('pw').value;
  const password2 = document.getElementById('pw2').value;
  const role = accountRole.value;
  const clinicName = clinicNameInput.value.trim();
  const clinicAddress = clinicAddressInput.value.trim();
  const certificate = certificateInput.files[0];

  if (!barangay) {
    showToast('Please select your barangay.', 'warning');
    return;
  }
  if (password !== password2) {
    showToast('Passwords do not match.', 'warning');
    return;
  }
  if (password.length < 8) {
    showToast('Password must be at least 8 characters.', 'warning');
    return;
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)) {
    showToast('Password must include at least one special character (e.g. ! @ # $ % ^ & *).', 'warning');
    return;
  }
  if (role === 'clinic_staff' && (!clinicName || !clinicAddress || !certificate)) {
    showToast('Clinic staff registration requires the clinic name, address, and BPLO certificate photo.', 'warning');
    return;
  }
  if (certificate && (certificate.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png'].includes(certificate.type))) {
    showToast('Upload a JPG or PNG BPLO certificate image no larger than 5 MB.', 'warning');
    return;
  }

  const btn = document.querySelector('.register-btn');
  btn.textContent = 'Creating account...';
  btn.disabled = true;

  let createdUser = null;
  try {
    const userCred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = userCred.user.uid;
    createdUser = userCred.user;
    let certificateUrl = '';

    if (role === 'clinic_staff') {
      const certificateRef = ref(storage, `staff-certificates/${uid}/bplo-${Date.now()}-${certificate.name}`);
      await uploadBytes(certificateRef, certificate, { contentType: certificate.type });
      certificateUrl = await getDownloadURL(certificateRef);
    }

    await setDoc(doc(db, 'users', uid), {
      uid,
      email,
      role,
      full_name: firstName + ' ' + lastName,
      phone,
      clinic_name: role === 'clinic_staff' ? clinicName : '',
      clinic_address: role === 'clinic_staff' ? clinicAddress : '',
      bplo_certificate_url: certificateUrl,
      is_active: role !== 'clinic_staff',
      approval_status: role === 'clinic_staff' ? 'pending' : 'approved',
      created_at: serverTimestamp()
    });

    if (role === 'resident') await setDoc(doc(db, 'residents', uid), {
      uid,
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      barangay,
      created_at: serverTimestamp()
    });

    showToast(role === 'clinic_staff'
      ? 'Registration submitted. An administrator must approve your clinic staff account before you can sign in.'
      : 'Account created successfully! You can now sign in.', 'success');
    setTimeout(() => { window.location.href = 'login.html'; }, 1800);

  } catch (err) {
    if (createdUser) {
      try { await deleteUser(createdUser); } catch (cleanupError) { console.error('Could not remove incomplete registration:', cleanupError); }
    }
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account';

    if (err.code === 'auth/email-already-in-use') {
      showToast('That email is already registered. Please sign in instead.', 'error');
    } else if (err.code === 'auth/invalid-email') {
      showToast('Please enter a valid email address.', 'error');
    } else if (err.code === 'auth/weak-password') {
      showToast('Password is too weak. Use at least 8 characters including a special character.', 'error');
    } else {
      showToast('Registration failed: ' + err.message, 'error');
    }
  }
});
