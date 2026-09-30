import { app, auth } from './firebase.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js';
const requestCode = httpsCallable(getFunctions(app), 'requestEmailOtp');
const verifyCode = httpsCallable(getFunctions(app), 'verifyEmailOtp');

export function openEmailOtp() {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'email-otp-dialog';
    dialog.setAttribute('aria-labelledby', 'otpTitle');
    dialog.innerHTML = `<h2 id="otpTitle">Verify your email</h2><p>Enter the six-digit code sent to <strong id="otpEmail"></strong>.</p><form><label for="otpCode">Verification code</label><input id="otpCode" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required placeholder="000000" autofocus><p class="otp-expiry"></p><p class="otp-message" role="status"></p><button type="submit" class="login-btn">Verify email</button></form><button type="button" class="otp-resend">Resend code</button><button type="button" class="otp-close">Return to sign in</button>`;
    dialog.querySelector('#otpEmail').textContent = auth.currentUser?.email || 'your email';
    const input = dialog.querySelector('input');
    const status = dialog.querySelector('.otp-message');
    const resend = dialog.querySelector('.otp-resend');
    const verify = dialog.querySelector('[type="submit"]');
    let resendAt = 0;
    let expiresAt = 0;
    let busy = false;
    let completed = false;
    const refresh = () => {
      const wait = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
      resend.disabled = busy || wait > 0;
      verify.disabled = busy;
      resend.textContent = wait ? `Resend code in ${wait}s` : 'Resend code';
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      dialog.querySelector('.otp-expiry').textContent = expiresAt ? (remaining ? `Code expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'Code expired. Request a new code.') : '';
    };
    const showError = error => {
      if (error.details?.retryAfterMs) resendAt = Date.now() + error.details.retryAfterMs;
      if (error.details?.expiresInMs) expiresAt = Date.now() + error.details.expiresInMs;
      status.textContent = ['functions/not-found', 'functions/internal'].includes(error.code)
        ? 'The verification service is unavailable. Please contact the administrator; your account has been saved.'
        : error.message || 'Unable to verify email. Please try again.';
    };
    async function send() {
      if (busy || Date.now() < resendAt) return;
      busy = true; status.textContent = 'Sending your code...'; refresh();
      try {
        const { data } = await requestCode();
        if (data.verified) { completed = true; dialog.close(); return; }
        resendAt = Date.now() + data.retryAfterMs;
        expiresAt = Date.now() + data.expiresInMs;
        input.value = '';
        status.textContent = 'Code sent. Check your inbox and spam folder. Only the newest code will work.';
        input.focus();
      } catch (error) { showError(error); }
      finally { busy = false; refresh(); }
    }
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      busy = true; status.textContent = 'Verifying...'; refresh();
      try {
        await verifyCode({ code: input.value.trim() });
        await auth.currentUser.reload();
        await auth.currentUser.getIdToken(true);
        completed = true;
        dialog.close();
      } catch (error) { showError(error); }
      finally { busy = false; refresh(); }
    });
    resend.addEventListener('click', send);
    dialog.querySelector('.otp-close').addEventListener('click', () => { if (!busy) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    const timer = setInterval(refresh, 1000);
    dialog.addEventListener('close', () => { clearInterval(timer); dialog.remove(); resolve(completed); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    send();
  });
}