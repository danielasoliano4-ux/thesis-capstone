import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDK•••••••••••••••••••••••••••••••",
  authDomain: "anti-rabies-locator.firebaseapp.com",
  projectId: "anti-rabies-locator",
  storageBucket: "anti-rabies-locator.firebasestorage.app",
  messagingSenderId: "503650196823",
  appId: "1:503650196823:web:70b9dc0f0bfd847c9a3212"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };