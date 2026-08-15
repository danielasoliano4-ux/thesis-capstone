// Central Firebase initialization (ES modules)
// Replace the firebaseConfig values with your project's credentials.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut as fbSignOut } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
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

const firebaseConfig = {
  apiKey: 'AIzaSyDK8f4qVtcMus8CVVexYZHdk_BBftnpq_k',
  authDomain: 'anti-rabies-locator.firebaseapp.com',
  projectId: 'anti-rabies-locator',
  storageBucket: 'anti-rabies-locator.firebasestorage.app',
  messagingSenderId: '503650196823',
  appId: '1:503650196823:web:70b9dc0f0bfd847c9a3212',
  measurementId: 'G-7Q2C9XMW87'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

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

export { app, auth, db, fetchUserProfile, fetchNotificationsFor, onAuthStateChanged };

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
