import { auth, db } from './firebase-config.js';
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

window.togglePw = function(id) {
    const input = document.getElementById(id);
    input.type = input.type === 'password' ? 'text' : 'password';
};

window.handleRegister = async function(e) {
    e.preventDefault();

    const firstName = document.getElementById('firstName').value.trim();
    const lastName = document.getElementById('lastName').value.trim();
    const email = document.getElementById('emailInput').value.trim();
    const phone = document.getElementById('phoneInput').value.trim();
    const barangay = document.getElementById('barangaySelect').value;
    const password = document.getElementById('pw').value;
    const confirmPassword = document.getElementById('pw2').value;
    const registerBtn = document.querySelector('.register-btn');

    if (!firstName || !lastName || !email || !password) {
        alert('Please fill in all required fields.');
        return;
    }
    if (password.length < 8) {
        alert('Password must be at least 8 characters.');
        return;
    }
    if (password !== confirmPassword) {
        alert('Passwords do not match.');
        return;
    }

    try {
        registerBtn.textContent = 'Creating account...';
        registerBtn.disabled = true;

        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const uid = userCredential.user.uid;

        await setDoc(doc(db, 'users', uid), {
            uid: uid,
            email: email,
            role: 'resident',
            is_active: true,
            created_at: serverTimestamp(),
            updated_at: serverTimestamp()
        });

        await setDoc(doc(db, 'residents', uid), {
            uid: uid,
            first_name: firstName,
            last_name: lastName,
            middle_name: '',
            birthdate: null,
            sex: '',
            address: '',
            barangay: barangay,
            phone: phone,
            created_at: serverTimestamp(),
            updated_at: serverTimestamp()
        });

        alert('Account created successfully! Please sign in.');
        window.location.href = 'login.html';

    } catch (error) {
        registerBtn.textContent = 'Create Account';
        registerBtn.disabled = false;

        if (error.code === 'auth/email-already-in-use') {
            alert('This email is already registered. Please sign in instead.');
        } else if (error.code === 'auth/invalid-email') {
            alert('Invalid email address.');
        } else if (error.code === 'auth/weak-password') {
            alert('Password is too weak. Use at least 8 characters.');
        } else {
            alert('Registration failed: ' + error.message);
        }
    }
};