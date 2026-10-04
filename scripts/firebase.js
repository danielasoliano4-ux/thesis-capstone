import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js';
import { firebaseConfig } from './firebase-config.js';
import { terminateSession } from './session-state.js';
import { getAuth, onAuthStateChanged, signOut as fbSignOut, setPersistence, browserSessionPersistence } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-storage.js';
import {
  getFirestore,
  doc,
  getDoc,
  collection,
  query,
  where,
  orderBy,
  getDocs
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Preserve restored sessions; new sessions default to this browser session.
const authPersistenceReady = new Promise((resolve, reject) => {
  const unsubscribe = onAuthStateChanged(auth, user => {
    unsubscribe();
    if (user) resolve();
    else setPersistence(auth, browserSessionPersistence).then(resolve, reject);
  }, reject);
});
const db = getFirestore(app);
const storage = getStorage(app);

// Helper: fetch a user profile document from 'users' collection by uid
async function fetchUserProfile(uid) {
  if (!uid || auth.currentUser?.uid !== uid) return null;
  try {
    const token = await auth.currentUser.getIdTokenResult();
    if (!auth.currentUser.emailVerified || token.claims.secure_login !== true || token.signInProvider !== 'custom') return null;
    const docRef = doc(db, 'users', uid);
    const snap = await getDoc(docRef);
    if (!snap.exists()) return null;
    return { uid: snap.id, ...snap.data() };
  } catch (err) {
    console.error('fetchUserProfile error', err);
    return null;
  }
}

// Helper: fetch notifications for a user (one-time)
async function fetchNotificationsFor(uid) {
  if (!uid) return [];
  try {
    const q = query(
      collection(db, 'notifications'),
      where('recipient_uid', '==', uid),
      orderBy('created_at', 'desc')
    );
    const snaps = await getDocs(q);
    return snaps.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error('fetchNotificationsFor error', err);
    return [];
  }
}

export { app, auth, db, storage, authPersistenceReady, fetchUserProfile, fetchNotificationsFor, onAuthStateChanged };

// Sign out helper
async function signOutUser() {
  try {
    terminateSession();
    await authPersistenceReady;
    await fbSignOut(auth);
  } catch (err) {
    console.error('signOutUser error', err);
    throw err;
  }
}

export { signOutUser };

// Refresh regularly so devices with a revoked session return to sign-in.
let checkingSession = false;
async function checkSession() {
  const user = auth.currentUser;
  if (!user || checkingSession) return;
  checkingSession = true;
  try { await user.getIdToken(true); }
  catch (error) {
    if (['auth/user-token-expired', 'auth/invalid-user-token', 'auth/user-disabled', 'auth/user-not-found'].includes(error.code)) await fbSignOut(auth);
  } finally { checkingSession = false; }
}
setInterval(checkSession, 60000);
window.addEventListener('focus', checkSession);
