import { auth, fetchUserProfile, onAuthStateChanged, signOutUser } from './firebase.js';
import { activateSession, sessionIsTerminated } from './session-state.js';

// Keep authorization independent of dashboard imports and DOM initialization.
let generation = 0;
async function checkResidentSession(user) {
  const run = ++generation;
  const returnToLogin = () => window.location.replace('/login.html?session=expired');
  if (!user || sessionIsTerminated()) {
    document.documentElement.style.visibility = 'hidden';
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
    if (profile?.role !== 'resident') {
      signOutUser().catch(console.error);
      returnToLogin();
      return;
    }
    activateSession('resident');
    window.finishResidentSessionCheck?.();
  } catch (error) {
    console.error('Resident session check failed:', error);
    returnToLogin();
  }
}
window.revalidateSession = () => checkResidentSession(auth.currentUser);
onAuthStateChanged(auth, checkResidentSession, () => window.location.replace('/login.html?session=expired'));
