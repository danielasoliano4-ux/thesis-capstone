import { auth, db, authPersistenceReady, fetchUserProfile, onAuthStateChanged } from './firebase.js';
import { signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { routes } from './routes.js';

const form = document.getElementById('adminLoginForm');
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const loginButton = document.getElementById('loginBtn');
const messageBox = document.getElementById('loginMessage');
const messageText = document.getElementById('loginMessageText');

function showMessage(message) {
  messageText.textContent = message;
  messageBox.hidden = false;
}

function clearMessage() {
  messageBox.hidden = true;
  messageText.textContent = '';
}

document.getElementById('passwordToggle').addEventListener('click', () => {
  const visible = passwordInput.type === 'text';
  passwordInput.type = visible ? 'password' : 'text';
  document.querySelector('#passwordToggle i').className = visible ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  clearMessage();
  if (!email || !password) return showMessage('Please enter your email and password.');

  loginButton.disabled = true;
  loginButton.textContent = 'Signing in...';
  try {
    await authPersistenceReady;
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const snapshot = await getDoc(doc(db, 'users', credential.user.uid));
    const role = snapshot.exists() ? snapshot.data().role : null;
    if (role !== 'admin' && role !== 'administrator') {
      await signOut(auth);
      showMessage('This account does not have administrator access.');
      return;
    }
    window.location.replace(routes.adminDashboard);
  } catch (error) {
    showMessage(error.code === 'auth/too-many-requests'
      ? 'Too many failed attempts. Please wait a moment and try again.'
      : 'The email or password is incorrect.');
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = 'Sign In to Admin Dashboard';
  }
});

onAuthStateChanged(auth, async user => {
  if (!user) return;
  const profile = await fetchUserProfile(user.uid);
  if (profile?.role === 'admin' || profile?.role === 'administrator') {
    window.location.replace(routes.adminDashboard);
  }
});
