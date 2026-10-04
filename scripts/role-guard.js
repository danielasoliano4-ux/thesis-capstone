import { auth, fetchUserProfile, onAuthStateChanged, signOutUser } from './firebase.js';
import { activateSession, sessionIsTerminated } from './session-state.js';
import { routes } from './routes.js';

const rolePages = {
  resident: 'residents.html',
  clinic_staff: 'staff.html',
  admin: routes.adminDashboard,
  administrator: routes.adminDashboard
};

export function protectPage(expectedRole, loginPage = 'login.html') {
  let generation = 0;
  const returnToLogin = () => window.location.replace(loginPage + '?session=expired');
  const check = async user => {
    const run = ++generation;
    if (!user || sessionIsTerminated()) {
      if (user) signOutUser().catch(console.error);
      returnToLogin();
      return;
    }
    try {
      const profile = await fetchUserProfile(user.uid);
      if (run !== generation) return;
      if (auth.currentUser?.uid !== user.uid || sessionIsTerminated()) {
        returnToLogin();
        return;
      }
      const hasExpectedRole = profile && (profile.role === expectedRole
        || (expectedRole === 'admin' && profile.role === 'administrator'));
      // Staff created before the approval workflow may omit approval_status.
      if (expectedRole === 'clinic_staff' && profile
        && (profile.approval_status === 'pending' || profile.approval_status === 'denied')) {
        signOutUser().catch(console.error);
        returnToLogin();
        return;
      }
      if (!hasExpectedRole) {
        const destination = rolePages[profile?.role] || loginPage;
        if (!profile) signOutUser().catch(console.error);
        window.location.replace(destination);
        return;
      }
      activateSession(profile.role);
      window.finishSessionCheck?.();
    } catch (error) {
      console.error('Could not verify page access:', error);
      returnToLogin();
    }
  };
  window.revalidateSession = () => check(auth.currentUser);
  return onAuthStateChanged(auth, check, returnToLogin);
}
