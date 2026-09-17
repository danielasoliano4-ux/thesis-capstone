import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js';

// Login-attempt state is maintained by Cloud Functions, rather than in the
// browser, so it is shared by the Resident, Clinic Staff, and Admin sign-ins.
const functions = getFunctions();
const checkLoginLock = httpsCallable(functions, 'checkLoginLock');
const recordLoginFailure = httpsCallable(functions, 'recordLoginFailure');
const clearLoginFailures = httpsCallable(functions, 'clearLoginFailures');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function formatDuration(seconds) {
  const minutes = Math.ceil(Number(seconds || 0) / 60);
  return minutes <= 1 ? '1 minute' : `${minutes} minutes`;
}

export async function getLoginLock(email) {
  const result = await checkLoginLock({ email: normalizeEmail(email) });
  return result.data || { locked: false };
}

export async function registerFailedLogin(email) {
  const result = await recordLoginFailure({ email: normalizeEmail(email) });
  return result.data || { locked: false };
}

export async function resetLoginFailures() {
  await clearLoginFailures();
}

export function lockoutMessage(lock) {
  return `Too many failed attempts. Please wait ${formatDuration(lock.retryAfterSeconds)} before trying again.`;
}

export function invalidCredentialsMessage(lock) {
  if (lock?.locked) return lockoutMessage(lock);
  if (Number.isInteger(lock?.remainingAttempts)) {
    const attempts = lock.remainingAttempts;
    return `The email or password is incorrect. ${attempts} attempt${attempts === 1 ? '' : 's'} remaining before a 15-minute lockout.`;
  }
  return 'The email or password is incorrect.';
}
