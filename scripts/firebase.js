import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js';
import { firebaseConfig } from './firebase-config.js';
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
// Do not retain authentication after the browser is closed.  Firebase defaults
// to LOCAL persistence, which was the source of the apparent cross-session
// "auto-login" behaviour.
const authPersistenceReady = setPersistence(auth, browserSessionPersistence);
const db = getFirestore(app);
const storage = getStorage(app);

// Helper: fetch a user profile document from 'users' collection by uid
async function fetchUserProfile(uid) {
  if (!uid) return null;
  try {
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
    await fbSignOut(auth);
  } catch (err) {
    console.error('signOutUser error', err);
    throw err;
  }
}

export { signOutUser };
