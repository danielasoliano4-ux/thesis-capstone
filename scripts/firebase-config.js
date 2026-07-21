// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDK8f4qVtcMus8CVVexYZHdk_BBftnpq_k",
  authDomain: "anti-rabies-locator.firebaseapp.com",
  projectId: "anti-rabies-locator",
  storageBucket: "anti-rabies-locator.firebasestorage.app",
  messagingSenderId: "503650196823",
  appId: "1:503650196823:web:70b9dc0f0bfd847c9a3212",
  measurementId: "G-7Q2C9XMW87"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);