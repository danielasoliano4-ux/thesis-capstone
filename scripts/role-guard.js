import { auth, fetchUserProfile, onAuthStateChanged, signOutUser } from './firebase.js';

export function protectPage(expectedRole, loginPage = 'login.html') {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = loginPage;
      return;
    }

    const profile = await fetchUserProfile(user.uid);
    if (!profile || profile.role !== expectedRole) {
      alert(`This account does not have ${expectedRole === 'clinic_staff' ? 'clinic staff' : expectedRole} access.`);
      await signOutUser();
      window.location.href = loginPage;
    }
  });
}
