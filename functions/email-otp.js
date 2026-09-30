'use strict';
const { randomInt, randomBytes, createHmac, timingSafeEqual } = require('node:crypto');
const OTP_LIFETIME = 5 * 60_000;
const RESEND_DELAY = 60_000;
function createEmailOtp({ db, auth, HttpsError, secret, sendEmail, now = Date.now, generateCode = () => String(randomInt(100000, 1000000)) }) {
  const digest = (uid, email, nonce, code) => createHmac('sha256', secret()).update(JSON.stringify([uid, email, nonce, code])).digest('hex');
  async function getUser(request) {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in or create an account to verify your email.');
    const user = await auth.getUser(request.auth.uid);
    if (user.disabled || !user.email) throw new HttpsError('permission-denied', 'This account cannot verify an email.');
    return user;
  }
  async function requestCode(request) {
    const user = await getUser(request);
    if (user.emailVerified) return { verified: true };
    const code = generateCode();
    const nonce = randomBytes(16).toString('hex');
    const ref = db.collection('_email_verification').doc(user.uid);
    const result = await db.runTransaction(async tx => {
      const previous = (await tx.get(ref)).data() || {};
      const time = now();
      if (previous.nextSendAt > time) throw new HttpsError('resource-exhausted', 'A code was recently requested. Check your email or wait to resend.', { retryAfterMs: previous.nextSendAt - time, expiresInMs: Math.max(0, previous.codeExpiresAt - time) });
      const sameWindow = previous.windowStarted && time - previous.windowStarted < 60 * 60_000;
      if (sameWindow && previous.sendCount >= 5) throw new HttpsError('resource-exhausted', 'Too many verification emails requested. Please try again later.', { retryAfterMs: previous.windowStarted + 60 * 60_000 - time });
      tx.set(ref, {
        email: user.email, nonce, digest: digest(user.uid, user.email, nonce, code),
        attempts: 0, consumed: false, codeExpiresAt: time + OTP_LIFETIME,
        nextSendAt: time + RESEND_DELAY, windowStarted: sameWindow ? previous.windowStarted : time,
        sendCount: sameWindow ? previous.sendCount + 1 : 1,
        expiresAt: new Date(time + 24 * 60 * 60_000)
      });
      return { expiresInMs: OTP_LIFETIME, retryAfterMs: RESEND_DELAY };
    });
    try { await sendEmail(user.email, code); }
    catch { throw new HttpsError('unavailable', 'The verification email could not be sent. Please wait 60 seconds and resend.', { retryAfterMs: RESEND_DELAY }); }
    return result;
  }
  async function verifyCode(request) {
    const user = await getUser(request);
    if (user.emailVerified) return { verified: true };
    const code = request.data?.code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new HttpsError('invalid-argument', 'Enter the six-digit code from your email.');
    const ref = db.collection('_email_verification').doc(user.uid);
    const result = await db.runTransaction(async tx => {
      const challenge = (await tx.get(ref)).data();
      if (!challenge || challenge.email !== user.email || challenge.consumed || challenge.codeExpiresAt <= now()) return { error: 'This code has expired or was already used. Request a new code.' };
      if (challenge.attempts >= 5) return { error: 'Too many incorrect codes. Request a new code when the resend timer ends.' };
      const expected = Buffer.from(challenge.digest, 'hex');
      const actual = Buffer.from(digest(user.uid, user.email, challenge.nonce, code), 'hex');
      const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
      tx.update(ref, { attempts: challenge.attempts + 1, consumed: matches });
      return matches ? { valid: true } : { error: `Incorrect code. ${4 - challenge.attempts} attempts remaining.` };
    });
    if (!result.valid) throw new HttpsError('failed-precondition', result.error);
    const current = await auth.getUser(user.uid);
    if (current.email !== user.email || current.disabled) throw new HttpsError('failed-precondition', 'Your account changed. Request a new verification code.');
    try { await auth.updateUser(user.uid, { emailVerified: true }); }
    catch { throw new HttpsError('unavailable', 'Email verification could not be completed. Please request a new code.'); }
    return { verified: true };
  }
  return { requestCode, verifyCode };
}
module.exports = { createEmailOtp };