'use strict';
const { randomBytes, randomInt, createHmac, timingSafeEqual } = require('node:crypto');
function createPasswordRecovery({ db, auth, HttpsError, secret, sendEmail, now = Date.now }) {
  const hash = value => createHmac('sha256', secret()).update(value).digest('hex');
  const fail = message => { throw new HttpsError('failed-precondition', message); };
  const token = () => randomBytes(32).toString('hex');
  const refFor = id => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) fail('Start again from Find your account.');
    return db.collection('_password_recovery').doc(id);
  };
  async function limit(key, max, window = 3600000) {
    const ref = db.collection('_recovery_limits').doc(hash(key));
    await db.runTransaction(async tx => {
      const old = (await tx.get(ref)).data() || {};
      const active = old.until > now();
      if (active && old.count >= max) throw new HttpsError('resource-exhausted', 'Too many requests. Please try again later.');
      tx.set(ref, { count: active ? old.count + 1 : 1, until: active ? old.until : now() + window, expiresAt: new Date(now() + 86400000) });
    });
  }
  async function current(challenge) {
    const user = await auth.getUser(challenge.uid);
    if (user.disabled || user.email !== challenge.email || (user.tokensValidAfterTime || '') !== challenge.version) fail('Your account changed. Start recovery again.');
    return user;
  }
  async function findAccount(request) {
    await limit('find:' + (request.rawRequest?.ip || 'unknown'), 20);
    const identifier = request.data?.identifier;
    if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 254) throw new HttpsError('invalid-argument', 'Enter your registered mobile number, email address, or username.');
    const value = identifier.trim();
    let user;
    if (value.includes('@')) {
      try { user = await auth.getUserByEmail(value.toLowerCase()); }
      catch (error) { if (error.code !== 'auth/user-not-found') throw error; }
    } else {
      const digits = value.replace(/[\s()+-]/g, '');
      const phone = /^\d{10,15}$/.test(digits);
      const variants = phone ? new Set([value, digits]) : new Set([value]);
      if (phone && /^(09\d{9}|639\d{9})$/.test(digits)) {
        const local = digits.startsWith('63') ? '0' + digits.slice(2) : digits;
        variants.add(local); variants.add('63' + local.slice(1)); variants.add('+63' + local.slice(1));
      }
      const matches = new Set();
      for (const candidate of variants) {
        const snap = await db.collection('users').where(phone ? 'phone' : 'username', '==', candidate).limit(2).get();
        snap.docs.forEach(doc => matches.add(doc.id));
      }
      if (matches.size > 1) fail('More than one account matches. Please use your email address.');
      if (matches.size === 1) user = await auth.getUser([...matches][0]);
    }
    if (!user || user.disabled || !user.email) fail('No recoverable account found. Check your details or contact the administrator.');
    const id = token();
    await refFor(id).set({ uid: user.uid, email: user.email, version: user.tokensValidAfterTime || '', stage: 'found', expires: now() + 900000, expiresAt: new Date(now() + 86400000) });
    const parts = user.email.split('@');
    return { recoveryId: id, account: (user.displayName || parts[0]).slice(0, 1) + '***', channels: [{ id: 'email', label: 'Email: ' + parts[0].slice(0, 1) + '***@' + parts[1] }] };
  }
  async function sendCode(request) {
    if (request.data?.channel !== 'email') throw new HttpsError('invalid-argument', 'Select an available verification channel.');
    const ref = refFor(request.data?.recoveryId);
    const challenge = (await ref.get()).data();
    if (!challenge || challenge.expires <= now() || !['found', 'code'].includes(challenge.stage)) fail('Recovery expired. Find your account again.');
    await current(challenge);
    await limit('send-minute:' + challenge.uid, 1, 60000);
    await limit('send-hour:' + challenge.uid, 5);
    const code = String(randomInt(100000, 1000000));
    await db.runTransaction(async tx => {
      const latest = (await tx.get(ref)).data();
      if (!latest || latest.expires <= now() || !['found','code'].includes(latest.stage)) fail('Start recovery again.');
      tx.update(ref, { stage: 'code', digest: hash(ref.id + code), attempts: 0, codeExpires: now() + 300000 });
    });
    try { await sendEmail(challenge.email, code); }
    catch { throw new HttpsError('unavailable', 'Email could not be sent. Wait 60 seconds and try again.'); }
    return { retryAfterMs: 60000, expiresInMs: 300000 };
  }
  async function verifyCode(request) {
    const ref = refFor(request.data?.recoveryId), code = request.data?.code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new HttpsError('invalid-argument', 'Enter the six-digit security code.');
    const grant = token();
    const valid = await db.runTransaction(async tx => {
      const c = (await tx.get(ref)).data();
      if (!c || c.stage !== 'code' || c.expires <= now() || c.codeExpires <= now() || c.attempts >= 5) return false;
      const match = timingSafeEqual(Buffer.from(c.digest, 'hex'), Buffer.from(hash(ref.id + code), 'hex'));
      tx.update(ref, { attempts: c.attempts + 1, ...(match ? { stage: 'verified', grant: hash(grant), grantExpires: now() + 300000 } : {}) });
      return match;
    });
    if (!valid) fail('Incorrect, expired, or exhausted code. Request a new code or start again.');
    return { resetToken: grant };
  }
  async function resetPassword(request) {
    const { recoveryId, resetToken, password, confirmPassword } = request.data || {};
    if (typeof password !== 'string' || password.length < 12 || password.length > 128 || password !== confirmPassword) throw new HttpsError('invalid-argument', 'Use 12?128 characters and make sure both passwords match.');
    if (typeof resetToken !== 'string' || !/^[a-f0-9]{64}$/.test(resetToken)) fail('Verify your code first.');
    const ref = refFor(recoveryId);
    const c = await db.runTransaction(async tx => {
      const challenge = (await tx.get(ref)).data();
      if (!challenge || challenge.stage !== 'verified' || challenge.grantExpires <= now() || challenge.grant !== hash(resetToken)) fail('Reset authorization expired or was used. Start again.');
      tx.update(ref, { stage: 'consumed' });
      return challenge;
    });
    await current(c);
    // Block already-issued ID tokens as well as refresh tokens.
    await db.collection('_session_revocations').doc(c.uid).set({ revokedAt: Math.floor(now() / 1000) });
    await auth.updateUser(c.uid, { password });
    await auth.revokeRefreshTokens(c.uid);
    return { complete: true };
  }
  return { findAccount, sendCode, verifyCode, resetPassword };
}
module.exports = { createPasswordRecovery };
