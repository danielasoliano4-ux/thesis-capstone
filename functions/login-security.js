'use strict';
const { createHash } = require('node:crypto');
const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 60_000;
const WINDOW_MS = 15 * 60_000;
const INVALID_LOGIN = 'The email or mobile number you entered isn’t connected to an account.';

function nextAttempt(previous = {}, now, limit = MAX_ATTEMPTS) {
  if (previous.blockedUntil > now) return { allowed: false, retryAfterMs: previous.blockedUntil - now };
  const expired = previous.blockedUntil > 0 || !previous.windowStarted || now - previous.windowStarted >= WINDOW_MS;
  const count = (expired ? 0 : previous.count || 0) + 1;
  return { allowed: true, remaining: Math.max(0, limit - count), state: {
    count, windowStarted: expired ? now : previous.windowStarted,
    blockedUntil: count >= limit ? now + COOLDOWN_MS : 0,
    expiresAt: new Date(now + 24 * 60 * 60_000)
  } };
}

// Last committed registration version without email verification. Use an earlier
// cutoff if verification was enabled earlier in production. Never use deployment time.
const LEGACY_VERIFICATION_CUTOFF = '2026-09-17T12:52:25Z';

function createSecureLogin({ db, auth, HttpsError, apiKey, legacyVerificationCutoff = () => LEGACY_VERIFICATION_CUTOFF, fetchImpl = fetch, now = Date.now }) {
  return async request => {
    const { email: rawEmail, password, role, action = 'login' } = request.data || {};
    if (typeof rawEmail !== 'string' || rawEmail.length > 254 || !rawEmail.includes('@')
      || typeof password !== 'string' || !password || password.length > 4096
      || action !== 'login' || !['resident', 'clinic_staff', 'admin'].includes(role)) {
      throw new HttpsError('invalid-argument', 'Enter a valid email address and password.');
    }
    const email = rawEmail.trim().toLowerCase();
    const key = apiKey();
    if (!key) throw new HttpsError('unavailable', 'Login is not configured. Contact the administrator.');
    const hash = value => createHash('sha256').update(value).digest('hex');
    const accountRef = db.collection('_login_limits').doc(hash(`account:${email}`));
    // Use the platform request IP, never an IP supplied in the request body.
    const ipRef = db.collection('_login_limits').doc(hash(`ip:${request.rawRequest.ip || 'unknown'}`));
    const reservation = await db.runTransaction(async transaction => {
      const [account, ip] = await transaction.getAll(accountRef, ipRef);
      const timestamp = now();
      const nextAccount = nextAttempt(account.data(), timestamp);
      const nextIp = nextAttempt(ip.data(), timestamp, 30);
      const retryAfterMs = Math.max(nextAccount.retryAfterMs || 0, nextIp.retryAfterMs || 0);
      if (retryAfterMs) throw new HttpsError('resource-exhausted', 'Too many attempts. Please wait before trying again.', { retryAfterMs });
      transaction.set(accountRef, nextAccount.state);
      transaction.set(ipRef, nextIp.state);
      return nextAccount;
    });
    const failure = () => {
      if (!reservation.remaining) throw new HttpsError('resource-exhausted', INVALID_LOGIN, { retryAfterMs: COOLDOWN_MS, remainingAttempts: 0 });
      throw new HttpsError('unauthenticated', INVALID_LOGIN, { remainingAttempts: reservation.remaining });
    };
    const identityRequest = async (method, body) => {
      try {
        const response = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${encodeURIComponent(key)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
        });
        const data = await response.json();
        return { ok: response.ok, data };
      } catch {
        throw new HttpsError('unavailable', 'Login service is unavailable. Please try again shortly.');
      }
    };
    const result = await identityRequest('signInWithPassword', { email, password, returnSecureToken: true });
    if (!result.ok) {
      const code = result.data.error?.message || '';
      if (['INVALID_EMAIL', 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'USER_DISABLED'].includes(code)) return failure();
      if (code.startsWith('TOO_MANY_ATTEMPTS')) throw new HttpsError('resource-exhausted', 'Too many attempts. Please wait before trying again.', { retryAfterMs: COOLDOWN_MS });
      throw new HttpsError('unavailable', 'Login service is unavailable. Please contact the administrator.');
    }
    const user = await auth.getUser(result.data.localId);
    if (user.disabled) return failure();
    const profileRef = db.collection('users').doc(user.uid);
    const snapshot = await profileRef.get();
    const profile = snapshot.data();
    if (!profile) throw new HttpsError('permission-denied', 'Your account profile is missing. Contact the administrator.');
    if (profile.is_active === false || ['pending', 'denied'].includes(profile.approval_status)) {
      throw new HttpsError('permission-denied', profile.approval_status === 'pending'
        ? 'Your account is pending administrator approval.' : 'Your account is inactive or was not approved. Contact the administrator.');
    }
    if (profile.role !== role && !(role === 'admin' && profile.role === 'administrator')) {
      throw new HttpsError('permission-denied', 'This account does not have access to the selected role.');
    }

    if (!user.emailVerified) {
      const cutoff = Date.parse(legacyVerificationCutoff());
      const createdAt = Date.parse(user.metadata?.creationTime || '');
      // Missing schema fields alone are not proof of a legacy account.
      // Auth metadata cannot be backdated by a registering client.
      const legacy = Number.isFinite(cutoff) && Number.isFinite(createdAt)
        && createdAt < cutoff && profile.email_verification_required === undefined;
      if (!legacy) {
        throw new HttpsError('failed-precondition', 'Email verification is incomplete. Complete verification on the registration page or contact your administrator.', { reason: 'email-unverified' });
      }
      await auth.updateUser(user.uid, { emailVerified: true });
      await profileRef.set({
        email_verification_required: false,
        email_verification_source: 'legacy_migration',
        email_verification_migrated_at: new Date(now())
      }, { merge: true });
    }

    // This per-session claim cannot be obtained through direct password sign-in.
    const token = await auth.createCustomToken(user.uid, { secure_login: true });
    await accountRef.delete();
    return { token };
  };
}
module.exports = { createSecureLogin, nextAttempt, MAX_ATTEMPTS, COOLDOWN_MS };
