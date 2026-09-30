import { app, auth } from './firebase.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js';
const $ = id => document.getElementById(id);
const call = async (name, data) => (await httpsCallable(getFunctions(app), name)(data)).data;
let recoveryId, resetToken, busy = false, resendAt = 0;
function step(form, title) {
  for (const id of ['findForm','channelForm','codeForm','passwordForm']) $(id).hidden = id !== form;
  $('title').textContent = title;
  $('restart').hidden = form === 'findForm' || !form;
  $(form)?.querySelector('input')?.focus();
}
function refresh() {
  document.querySelectorAll('button').forEach(b => b.disabled = busy);
  const seconds = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
  $('resend').disabled = busy || seconds > 0;
  $('resend').textContent = seconds ? 'Resend in ' + seconds + 's' : 'Resend code';
}
async function run(action) {
  if (busy) return;
  busy = true; refresh(); $('message').textContent = 'Please wait...';
  try { await action(); }
  catch (e) { $('message').textContent = ['functions/internal','functions/not-found'].includes(e.code) ? 'Recovery service is unavailable. Contact the administrator.' : e.message || 'Unable to complete recovery. Please try again.'; }
  finally { busy = false; refresh(); }
}
$('findForm').addEventListener('submit', e => { e.preventDefault(); run(async () => {
  const result = await call('findRecoveryAccount', { identifier: $('identifier').value.trim() });
  recoveryId = result.recoveryId; resetToken = undefined;
  $('account').textContent = 'Account found: ' + result.account;
  $('channels').replaceChildren();
  result.channels.forEach((channel, index) => {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'radio'; input.name = 'channel'; input.value = channel.id; input.checked = index === 0; input.required = true;
    label.append(input, ' ' + channel.label); $('channels').append(label);
  });
  step('channelForm','Confirm your account'); $('message').textContent = '';
}); });
async function send() {
  resendAt = Date.now() + 60000;
  const result = await call('sendRecoveryCode', { recoveryId, channel: document.querySelector('[name=channel]:checked').value });
  resendAt = Date.now() + result.retryAfterMs;
  $('code').value = ''; step('codeForm','Enter security code'); $('message').textContent = 'Code sent. Only the newest code will work.';
}
$('channelForm').addEventListener('submit', e => { e.preventDefault(); run(send); });
$('resend').addEventListener('click', () => { if (Date.now() >= resendAt) run(send); });
$('codeForm').addEventListener('submit', e => { e.preventDefault(); run(async () => {
  const result = await call('verifyRecoveryCode', { recoveryId, code: $('code').value.trim() });
  resetToken = result.resetToken; $('code').value = ''; step('passwordForm','Create a new password'); $('message').textContent = '';
}); });
$('passwordForm').addEventListener('submit', e => { e.preventDefault(); run(async () => {
  if ($('newPassword').value !== $('confirmPassword').value) throw new Error('The passwords do not match.');
  await call('resetRecoveryPassword', { recoveryId, resetToken, password: $('newPassword').value, confirmPassword: $('confirmPassword').value });
  $('passwordForm').reset(); resetToken = undefined; recoveryId = undefined;
  await signOut(auth).catch(() => {});
  step(null,'Password updated'); $('message').textContent = 'Your password has been changed. Sign in using your new password.';
}); });
$('restart').addEventListener('click', () => { recoveryId = undefined; resetToken = undefined; document.querySelectorAll('form').forEach(f => f.reset()); step('findForm','Find your account'); $('message').textContent = ''; });
setInterval(refresh, 1000);
