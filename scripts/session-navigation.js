// Runs before painting, including inside the app's iframe.
(() => {
  const path = location.pathname.replace(/\/$/, '').replace(/\.html$/, '');
  const page = path.split('/').pop();
  const adminLogin = path === '/admin/login' || page === 'admin-login';
  const protectedPage = ['residents', 'staff', 'clinic-profile', 'clinic-notifications',
    'confirmed-appointments', 'patient-tracking', 'history', 'admin'].includes(page) && !adminLogin;
  const guest = ['', 'index', 'login', 'register', 'forgot-password', 'first-aid', 'notifications'].includes(page) || adminLogin;
  const read = () => {
    try { return sessionStorage.getItem('auth-session-state') || sessionStorage.getItem('resident-session-state'); }
    catch { return null; }
  };
  const markTerminated = () => {
    try {
      sessionStorage.setItem('auth-session-state', 'terminated');
      sessionStorage.setItem('resident-session-state', 'terminated');
      sessionStorage.removeItem('appPage');
    } catch { /* Clear Firebase credentials even when storage is unavailable. */ }
  };
  const endGuestSession = () => {
    if (read() === 'active') markTerminated();
    // Login waits for restored credentials to clear before creating new ones.
    window.residentSignOutReady = import('./firebase.js').then(async ({ auth, authPersistenceReady, signOutUser }) => {
      await authPersistenceReady;
      if (auth.currentUser) {
        markTerminated();
        await signOutUser();
      }
    });
    window.residentSignOutReady.catch(error => console.error('Could not clear authentication:', error));
  };

  if (protectedPage) {
    let timeout;
    let visiblePage = true;
    const hide = () => { document.documentElement.style.visibility = 'hidden'; };
    const returnToLogin = () => {
      hide();
      clearTimeout(timeout);
      const login = page === 'admin'
        ? (['localhost', '127.0.0.1'].includes(location.hostname) ? '/admin-login.html' : '/admin/login')
        : '/login.html';
      location.replace(login + '?session=expired');
    };
    const checking = () => {
      // Render the dashboard shell while Firebase restores credentials and the
      // role guard validates access. Private data still loads through Firebase.
      // A restored history entry stays hidden until its existing data is verified.
      clearTimeout(timeout);
      timeout = setTimeout(returnToLogin, 20000);
    };
    window.finishSessionCheck = window.finishResidentSessionCheck = () => {
      if (!visiblePage || read() === 'terminated') return;
      clearTimeout(timeout);
      document.documentElement.style.visibility = '';
    };
    checking();
    if (read() === 'terminated') returnToLogin();
    window.addEventListener('pagehide', () => {
      visiblePage = false;
      clearTimeout(timeout);
      hide(); // History snapshots must never contain visible private data.
    });
    window.addEventListener('pageshow', event => {
      visiblePage = true;
      if (!event.persisted) return;
      checking();
      if (read() === 'terminated') returnToLogin();
      else window.revalidateSession?.();
    });
  }

  if (guest) {
    endGuestSession();
    window.addEventListener('pageshow', event => {
      // Initial pageshow may occur during sign-in; only restored history
      // entries represent a return to the guest side.
      if (!event.persisted) return;
      const password = document.getElementById('passwordInput');
      if (password) password.value = '';
      endGuestSession();
    });
  }
})();
