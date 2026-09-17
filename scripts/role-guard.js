import { auth, fetchUserProfile, onAuthStateChanged } from './firebase.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { routes } from './routes.js';

const rolePages = {
  resident: 'residents.html',
  clinic_staff: 'staff.html',
  admin: routes.adminDashboard,
  administrator: routes.adminDashboard
};

export function protectPage(expectedRole, loginPage = 'login.html') {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = loginPage;
      return;
    }

    const profile = await fetchUserProfile(user.uid);
    const hasExpectedRole = profile && (profile.role === expectedRole
      || (expectedRole === 'admin' && profile.role === 'administrator'));
    // Only newly registered clinic staff carry a 'pending' approval_status.
    // Existing staff accounts may have no approval_status field, so they must
    // not be signed out and bounced back to the login page.
    if (expectedRole === 'clinic_staff' && profile
      && (profile.approval_status === 'pending' || profile.approval_status === 'denied')) {
      await signOut(auth);
      alert(profile.approval_status === 'denied'
        ? 'Your clinic staff registration was not approved.'
        : 'Your clinic staff account is pending administrator approval.');
      window.location.replace(loginPage);
      return;
    }
    if (!hasExpectedRole) {
      const destination = rolePages[profile?.role] || loginPage;
      alert(`This account is not authorized for this page. Returning to your dashboard.`);
      window.location.replace(destination);
    }
  });
}
