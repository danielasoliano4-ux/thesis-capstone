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
    if (expectedRole === 'clinic_staff' && profile && (profile.is_active === false || profile.approval_status !== 'approved')) {
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
