import { notifyDialog } from './app-dialogs.js';
import { signOutUser } from './firebase.js';
// Shared header owns sign-out, including pages with legacy button handlers.
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-clinic-signout]');
  if (!button) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (button.disabled) return;
  button.disabled = true; button.textContent = 'Signing out...';
  try { await signOutUser(); window.location.href = 'login.html'; }
  catch { button.disabled = false; button.textContent = 'Sign Out'; notifyDialog('Could not sign out. Please try again.'); }
}, true);
