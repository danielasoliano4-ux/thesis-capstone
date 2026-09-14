import { auth, db, fetchUserProfile } from './firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { collection, onSnapshot, query, where } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { protectPage } from './role-guard.js';

protectPage('clinic_staff');

const list = document.getElementById('historyList');
const escapeHtml = (value = '') => { const element = document.createElement('div'); element.textContent = value; return element.innerHTML; };

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  const profile = await fetchUserProfile(user.uid);
  const clinicId = profile?.clinic_id || user.uid;
  onSnapshot(query(collection(db, 'history'), where('clinic_id', '==', clinicId)), (snapshot) => {
      const entries = snapshot.docs.map(item => item.data()).sort((first, second) => (second.created_at?.toMillis?.() || 0) - (first.created_at?.toMillis?.() || 0));
      if (!entries.length) {
        list.innerHTML = '<p class="empty-state">No history yet. Save a clinic profile change or process an appointment.</p>';
        return;
      }
      list.innerHTML = entries.map(entry => {
        const isProfile = entry.type === 'clinic_profile';
        const title = isProfile ? 'Clinic profile updated' : `Appointment ${entry.action}`;
        const detail = isProfile ? 'Business profile settings were saved.' : `${entry.resident_name || 'Resident'} appointment was ${entry.action}.`;
        const profileChanges = isProfile ? normalizeChanges(entry.changes) : [];
        const changeMarkup = isProfile
          ? (profileChanges.length
            ? `<ul class="history-changes">${profileChanges.map(change => `<li><strong>${escapeHtml(change.label)}</strong><span>${escapeHtml(change.before)} <i class="fa-solid fa-arrow-right"></i> ${escapeHtml(change.after)}</span></li>`).join('')}</ul>`
            : '<p class="history-no-changes">No profile values changed.</p>')
          : '';
        const timestamp = entry.created_at?.toDate ? entry.created_at.toDate().toLocaleString() : 'Recently';
        return `<article class="history-item"><div class="history-icon"><i class="fa-solid ${isProfile ? 'fa-building' : 'fa-calendar-check'}"></i></div><div class="history-content"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)} <span class="history-action">${escapeHtml(entry.action)}</span><br>${escapeHtml(timestamp)}</p>${changeMarkup}</div></article>`;
      }).join('');
    }, (error) => {
      list.innerHTML = `<p class="empty-state">Could not load history: ${escapeHtml(error.code || error.message)}</p>`;
    });
});

function normalizeChanges(changes) {
  if (Array.isArray(changes)) return changes;
  if (!changes || typeof changes !== 'object') return [];
  return Object.entries(changes).map(([field, value]) => ({
    label: field,
    before: 'Previously recorded',
    after: Array.isArray(value) ? value.join(', ') : String(value ?? 'Not set')
  }));
}

document.getElementById('signOutBtn').addEventListener('click', async () => {
  await signOut(auth);
  window.location.href = 'login.html';
});
