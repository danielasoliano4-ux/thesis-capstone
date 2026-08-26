import { auth, fetchUserProfile, onAuthStateChanged, signOutUser } from './firebase.js';

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
      alert(`This account does not have ${expectedRole === 'clinic_staff' ? 'clinic staff' : expectedRole} access.`);
      await signOutUser();
      window.location.href = loginPage;
    }
  });
}
