import { auth, db, signOutUser } from './firebase.js';
import { sessionIsTerminated } from './session-state.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { routes } from './routes.js';
import { createLoginController } from './login-security.js';

const rolePages = { resident: 'residents.html', clinic_staff: 'staff.html', admin: routes.adminDashboard };
const loginRoles = { resident: 'resident', staff: 'clinic_staff', admin: 'admin' };
function showLoginMessage(message) {
  document.getElementById('loginMessageText').textContent = message;
  document.getElementById('loginMessage').hidden = false;
}
const controller = createLoginController(document.getElementById('loginBtn'), showLoginMessage, () => loginRoles[window.currentRole || 'resident'], () => document.getElementById('rememberMe').checked);
if (new URLSearchParams(location.search).get('session') === 'expired') showLoginMessage('Your session ended or could not be verified. Please sign in again.');
if (new URLSearchParams(location.search).has('verify')) showLoginMessage('Your account is saved. Complete email verification during registration before signing in. Contact your administrator if you cannot return to registration.');
document.getElementById('loginBtn').addEventListener('click', async () => {
  const email = document.getElementById('emailInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  if (!email || !password) return showLoginMessage('Please enter your email and password.');
  const credential = await controller.attempt(email, password);
  if (!credential) return;
  try {
    const profile = (await getDoc(doc(db, 'users', credential.user.uid))).data();
    const role = profile?.role === 'administrator' ? 'admin' : profile?.role;
    if (!rolePages[role]) throw new Error('Missing role');
    if (auth.currentUser?.uid !== credential.user.uid || sessionIsTerminated()) return;
    document.getElementById('passwordInput').value = '';
    window.location.href = rolePages[role];
  } catch {
    await signOutUser();
    showLoginMessage('Could not load your account profile. Please contact the administrator.');
  }
});
document.getElementById('passwordInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); document.getElementById('loginBtn').click(); }
});

if (new URLSearchParams(location.search).has('verified')) showLoginMessage('Email verified. You can now sign in. Clinic staff also need administrator approval.');

document.querySelector('.signin-section form').addEventListener('submit', event => {
  event.preventDefault();
  document.getElementById('loginBtn').click();
});
