import { auth, fetchUserProfile, onAuthStateChanged } from './firebase.js';

const rolePages = {
  resident: 'residents.html',
  clinic_staff: 'staff.html',
  admin: 'admin.html',
  administrator: 'admin.html'
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
    if (!hasExpectedRole) {
      const destination = rolePages[profile?.role] || loginPage;
      alert(`This account is not authorized for this page. Returning to your dashboard.`);
      window.location.replace(destination);
    }
  });
}
