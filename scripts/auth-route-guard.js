import { auth, authPersistenceReady, signOutUser } from './firebase.js';
import { routes } from './routes.js';

const rolePages = {
  resident: 'residents.html',
  clinic_staff: 'staff.html',
  admin: routes.adminDashboard,
  administrator: routes.adminDashboard
};

export function redirectActiveUserFromPublicPage() {
  // Public pages stay public. The login form owns fresh sign-in navigation.
  // Retain this entry point for pages that called the previous redirect guard.
  if (!window.residentSignOutReady) {
    window.residentSignOutReady = authPersistenceReady.then(async () => {
      if (auth.currentUser) await signOutUser();
    });
    window.residentSignOutReady.catch(error => console.error('Could not end restored session:', error));
  }
  return window.residentSignOutReady;
}

export function dashboardForRole(role) {
  return rolePages[role] || 'login.html';
}
