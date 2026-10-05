import { auth, db, fetchUserProfile, onAuthStateChanged, signOutUser } from './firebase.js';
import { sessionIsTerminated } from './session-state.js';
import { doc, onSnapshot, setDoc } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

// Account controls must not wait for charts, maps, booking or push modules.
function initializeResidentAccount() {
  const element = id => document.getElementById(id);
  const modal = element('profileModal');
  const message = element('profileMessage');
  let unsubscribeProfile;
  let generation = 0;
  let authorizedUid = null;

  function showMessage(text, failed = false) {
    if (!message) return;
    message.textContent = text;
    message.style.color = failed ? '#b91c1c' : '#15803d';
  }

  function displayProfile(user, profile = {}, resident = {}) {
    const name = resident.username
      || [resident.first_name, resident.last_name].filter(Boolean).join(' ')
      || profile.full_name || profile.name || user.displayName || user.email || 'Resident';
    for (const id of ['headerName', 'recordName']) {
      if (element(id)) element(id).textContent = name;
    }
    const fields = {
      profileUsername: name, profileEmail: user.email || resident.email || '',
      profilePhone: resident.phone || profile.phone || '',
      profileBirthday: resident.birthday || '', profileGender: resident.gender || '',
      profileAddress: resident.address || ''
    };
    for (const [id, value] of Object.entries(fields)) {
      if (element(id)) element(id).value = value;
    }
  }

  const closeProfile = () => {
    modal?.classList.remove('open');
    modal?.setAttribute('aria-hidden', 'true');
    element('profileBtn')?.focus();
  };
  element('profileBtn')?.addEventListener('click', () => {
    modal?.classList.add('open');
    modal?.setAttribute('aria-hidden', 'false');
    element('profileUsername')?.focus();
  });
  element('profileClose')?.addEventListener('click', closeProfile);
  modal?.addEventListener('click', event => {
    if (event.target === modal) closeProfile();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal?.classList.contains('open')) closeProfile();
  });

  const signOutButton = element('signOutBtn');
  signOutButton?.addEventListener('click', async () => {
    if (signOutButton.disabled) return;
    const originalContent = signOutButton.innerHTML;
    signOutButton.disabled = true;
    signOutButton.textContent = 'Signing Out...';
    try {
      await signOutUser();
      window.location.replace('login.html');
    } catch (error) {
      console.error('Could not sign out resident:', error);
      signOutButton.disabled = false;
      signOutButton.innerHTML = originalContent;
      const status = element('residentDataStatus');
      if (status) {
        status.hidden = false;
        status.textContent = 'Could not sign out. Please try again.';
      }
    }
  });

  element('profileForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const user = auth.currentUser;
    if (!user || user.uid !== authorizedUid || sessionIsTerminated()) {
      showMessage('Your account is still loading. Please try again.', true);
      return;
    }
    const username = element('profileUsername').value.trim();
    if (!username) return;
    const button = event.currentTarget.querySelector('.profile-save-btn');
    button.disabled = true;
    showMessage('Saving profile...');
    try {
      // Older accounts may have a users document without a residents document.
      await setDoc(doc(db, 'residents', user.uid), {
        uid: user.uid,
        username,
        phone: element('profilePhone').value.trim(),
        birthday: element('profileBirthday').value,
        gender: element('profileGender').value,
        address: element('profileAddress').value.trim()
      }, { merge: true });
      if (auth.currentUser?.uid !== user.uid || sessionIsTerminated()) return;
      for (const id of ['headerName', 'recordName']) {
        if (element(id)) element(id).textContent = username;
      }
      showMessage('Profile saved successfully.');
    } catch (error) {
      showMessage('Could not save profile: ' + error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  onAuthStateChanged(auth, async user => {
    const run = ++generation;
    unsubscribeProfile?.();
    unsubscribeProfile = null;
    authorizedUid = null;
    if (!user || sessionIsTerminated()) return;
    displayProfile(user);
    try {
      const profile = await fetchUserProfile(user.uid);
      if (run !== generation || auth.currentUser?.uid !== user.uid || sessionIsTerminated()) return;
      if (profile?.role !== 'resident') return;
      authorizedUid = user.uid;
      displayProfile(user, profile);
      unsubscribeProfile = onSnapshot(doc(db, 'residents', user.uid), snapshot => {
        if (run !== generation || auth.currentUser?.uid !== user.uid || sessionIsTerminated()) return;
        displayProfile(user, profile, snapshot.exists() ? snapshot.data() : {});
      }, error => {
        console.error('Could not load resident profile:', error);
        showMessage('Could not load your profile. Check your connection and try again.', true);
      });
    } catch (error) {
      console.error('Could not load resident account:', error);
      showMessage('Could not load your account. Please refresh and try again.', true);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeResidentAccount, { once: true });
} else {
  initializeResidentAccount();
}
