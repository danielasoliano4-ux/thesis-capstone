import { app, auth, authPersistenceReady } from './firebase.js';
import { signInWithCustomToken, setPersistence, browserLocalPersistence, browserSessionPersistence } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js';
const secureLogin = httpsCallable(getFunctions(app), 'secureLogin');

// Browser storage preserves the countdown on refresh; the server is authoritative.
export function createLoginController(button, showMessage, getRole, getRememberMe = () => false) {
  const cooldownKey = 'login-cooldown-until';
  let deadline = 0;
  let busy = false;
  let idleLabel = button.textContent;
  const readDeadline = () => {
    try { return Number(localStorage.getItem(cooldownKey)) || 0; } catch { return deadline; }
  };
  const refresh = () => {
    deadline = Math.max(deadline, readDeadline());
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    button.disabled = busy || seconds > 0;
    if (seconds) button.textContent = `Try again in ${seconds}s`;
    else if (busy) button.textContent = 'Please wait...';
    else if (/^(Try again in|Please wait)/.test(button.textContent)) button.textContent = idleLabel;
    return seconds;
  };
  setInterval(refresh, 1000);
  window.addEventListener('storage', refresh);
  const attempt = async (email, password) => {
    if (busy) return null;
    if (refresh()) { showMessage('Too many attempts. Please wait for the countdown to finish.'); return null; }
    idleLabel = button.textContent;
    busy = true;
    refresh();
    try {
      await authPersistenceReady;
      const { data } = await secureLogin({ email, password, role: getRole() });
      // Handle a stale backend response without opening verification on sign-in.
      if (data.verificationRequired) {
        showMessage('Email verification is incomplete. Complete verification on the registration page or contact your administrator.');
        return null;
      }
      await setPersistence(auth, getRememberMe() ? browserLocalPersistence : browserSessionPersistence);
      return await signInWithCustomToken(auth, data.token);
    } catch (error) {
      if (error.details?.retryAfterMs) {
        deadline = Date.now() + error.details.retryAfterMs;
        try { localStorage.setItem(cooldownKey, String(deadline)); } catch { /* Server still enforces the limit. */ }
      }
      const remaining = error.details?.remainingAttempts;
      const known = ['functions/unauthenticated', 'functions/resource-exhausted', 'functions/failed-precondition', 'functions/permission-denied', 'functions/invalid-argument', 'functions/unavailable'];
      const serviceErrors = {
        'functions/not-found': 'The login service has not been deployed. Please contact the administrator.',
        'functions/internal': 'The login service could not complete your request. Please contact the administrator.',
        'auth/custom-token-mismatch': 'Login is configured for a different Firebase project. Please contact the administrator.',
        'auth/invalid-custom-token': 'The server could not issue a valid login session. Please contact the administrator.'
      };
      console.error('Login error code:', error.code || 'unknown');
      const message = serviceErrors[error.code] || (known.includes(error.code) ? error.message : 'Unable to reach the login service. Check your connection or contact the administrator.');
      showMessage(message + (remaining > 0 ? ` ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` : ''));
      return null;
    } finally {
      busy = false;
      refresh();
    }
  };
  refresh();
  return { attempt };
}
