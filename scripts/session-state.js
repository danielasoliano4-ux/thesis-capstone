// The marker blocks cached private pages before Firebase finishes signing out.
// Keep the old resident key readable for sessions created by the previous build.
export function sessionIsTerminated() {
  try {
    return (sessionStorage.getItem('auth-session-state')
      || sessionStorage.getItem('resident-session-state')) === 'terminated';
  } catch { return false; }
}

export function activateSession(role) {
  try {
    sessionStorage.setItem('auth-session-state', 'active');
    sessionStorage.setItem('resident-session-state', role === 'resident' ? 'active' : 'terminated');
  } catch { /* Firebase still verifies authorization when storage is unavailable. */ }
}

export function terminateSession() {
  try {
    sessionStorage.setItem('auth-session-state', 'terminated');
    sessionStorage.setItem('resident-session-state', 'terminated');
    sessionStorage.removeItem('appPage');
  } catch { /* Firebase sign-out must still run. */ }
}
