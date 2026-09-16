import { auth, fetchUserProfile, onAuthStateChanged } from './firebase.js';

const rolePages = {
  resident: 'residents.html',
  clinic_staff: 'staff.html',
  admin: '/admin',
  administrator: '/admin'
};

export function redirectActiveUserFromPublicPage() {
  onAuthStateChanged(auth, async user => {
    if (!user) return;
    const profile = await fetchUserProfile(user.uid);
    const destination = rolePages[profile?.role];
    if (destination && !window.location.pathname.endsWith(`/${destination}`)) {
      window.location.replace(destination);
    }
  });
}

export function dashboardForRole(role) {
  return rolePages[role] || 'login.html';
}
