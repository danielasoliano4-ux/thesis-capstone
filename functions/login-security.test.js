'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSecureLogin, nextAttempt, COOLDOWN_MS } = require('./login-security');
class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
function fixture(options = {}) {
  let time = 1000000;
  const documents = new Map();
  let queue = Promise.resolve();
  const calls = [];
  const tokens = [];
  const updates = [];
  const profile = options.profile === null ? null : options.profile || { role: 'resident', is_active: true, approval_status: 'approved' };
  const ref = (collection, id) => ({ key: `${collection}/${id}`, get: async () => ({ data: () => profile }), set: async value => Object.assign(profile, value), delete: async function () { documents.delete(this.key); } });
  const db = {
    collection: name => ({ doc: id => ref(name, id) }),
    runTransaction: callback => {
      const operation = queue.then(() => callback({
        getAll: async (...refs) => refs.map(ref => ({ data: () => documents.get(ref.key) })),
        set: (ref, value) => documents.set(ref.key, value)
      }));
      queue = operation.catch(() => {});
      return operation;
    }
  };
  const auth = {
    getUser: async () => ({ uid: 'resident-1', emailVerified: options.verified !== false, disabled: options.disabled || false, metadata: { creationTime: options.createdAt } }),
    updateUser: async (uid, changes) => { if (options.updateFails) throw new Error('Auth update failed'); updates.push({ uid, ...changes }); },
    createCustomToken: async (uid, claims) => { tokens.push({ uid, claims }); return 'custom-token'; }
  };
  const handler = createSecureLogin({ db, auth, HttpsError, apiKey: () => 'public-api-key', ...(options.cutoff === undefined ? {} : { legacyVerificationCutoff: () => options.cutoff }), now: () => time,
    fetchImpl: async (url, request) => {
      calls.push(url);
      const body = JSON.parse(request.body);
      if (options.offline) throw new Error('offline');
      const ok = url.includes('sendOobCode') || body.password === 'correct';
      return { ok, json: async () => ok ? { localId: 'resident-1', idToken: 'password-id-token' } : { error: { message: options.identityError || 'INVALID_LOGIN_CREDENTIALS' } } };
    }
  });
  const login = (data = {}) => handler({ data: { email: 'resident@example.com', password: 'wrong', role: 'resident', ...data }, rawRequest: { ip: '192.0.2.1' } });
  return { login, calls, tokens, documents, updates, profile, advance: ms => { time += ms; } };
}
test('fifth failed attempt locks account for sixty seconds; changing email case does not bypass', async () => {
  const f = fixture();
  for (let i = 1; i <= 4; i++) await assert.rejects(f.login(), error => error.code === 'unauthenticated' && error.details.remainingAttempts === 5 - i);
  await assert.rejects(f.login(), error => error.code === 'resource-exhausted' && error.details.retryAfterMs === COOLDOWN_MS);
  await assert.rejects(f.login({ email: 'RESIDENT@example.com', password: 'correct' }), { code: 'resource-exhausted' });
  assert.equal(f.calls.length, 5);
  f.advance(COOLDOWN_MS);
  assert.deepEqual(await f.login({ password: 'correct' }), { token: 'custom-token' });
});
test('concurrent attempts cannot exceed the account budget', async () => {
  const f = fixture();
  await Promise.allSettled(Array.from({ length: 12 }, () => f.login()));
  assert.equal(f.calls.length, 5);
  assert.equal(f.tokens.length, 0);
});
test('successful verified login resets account failures and issues gated token', async () => {
  const f = fixture();
  await assert.rejects(f.login());
  await f.login({ password: 'correct' });
  assert.deepEqual(f.tokens, [{ uid: 'resident-1', claims: { secure_login: true } }]);
  await assert.rejects(f.login(), error => error.details.remainingAttempts === 4);
});
test('sign-in rejects unverified accounts for every role without issuing an OTP token', async () => {
  for (const role of ['resident', 'clinic_staff', 'admin']) {
    const f = fixture({ verified: false, profile: { role, is_active: true } });
    await assert.rejects(f.login({ password: 'correct', role }), error => error.code === 'failed-precondition' && error.details.reason === 'email-unverified');
    assert.equal(f.tokens.length, 0);
  }
});
test('sign-in does not support resending verification codes', async () => {
  const f = fixture();
  await assert.rejects(f.login({ password: 'correct', action: 'resend' }), { code: 'invalid-argument' });
  assert.equal(f.tokens.length, 0);
});
test('pending, inactive and wrong-role accounts are rejected', async () => {
  for (const profile of [
    { role: 'resident', is_active: false },
    { role: 'clinic_staff', is_active: true, approval_status: 'pending' },
    { role: 'clinic_staff', is_active: true, approval_status: 'denied' },
    { role: 'admin', is_active: true }
  ]) {
    const f = fixture({ profile });
    await assert.rejects(f.login({ password: 'correct' }), { code: 'permission-denied' });
    assert.equal(f.tokens.length, 0);
  }
});
test('administrator alias is accepted only on admin login', async () => {
  const f = fixture({ profile: { role: 'administrator', is_active: true } });
  assert.ok((await f.login({ password: 'correct', role: 'admin' })).token);
});
test('unknown email and wrong password return the same message', async () => {
  const messages = [];
  for (const identityError of ['EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS']) {
    try { await fixture({ identityError }).login(); } catch (error) { messages.push(error.message); }
  }
  assert.equal(new Set(messages).size, 1);
});
test('invalid inputs and network failures never mint a token', async () => {
  const f = fixture();
  await assert.rejects(f.login({ email: 'not-email' }), { code: 'invalid-argument' });
  assert.equal(f.calls.length, 0);
  const offline = fixture({ offline: true });
  await assert.rejects(offline.login({ password: 'correct' }), { code: 'unavailable' });
  assert.equal(offline.tokens.length, 0);
});
test('IP budget limits rotation through different email addresses', async () => {
  const f = fixture();
  for (let i = 0; i < 30; i++) await assert.rejects(f.login({ email: `resident${i}@example.com` }));
  await assert.rejects(f.login({ email: 'another@example.com' }), { code: 'resource-exhausted' });
  assert.equal(f.calls.length, 30);
});
test('expired failure window resets the counter', () => {
  const result = nextAttempt({ count: 4, windowStarted: 1, blockedUntil: 0 }, 16 * 60_000);
  assert.equal(result.state.count, 1);
  assert.equal(result.remaining, 4);
});

test('legacy accounts migrate only after password, profile and role checks', async () => {
  for (const role of ['resident', 'clinic_staff', 'admin', 'administrator']) {
    const f = fixture({ verified: false, createdAt: '2026-09-01T00:00:00Z', profile: { role, is_active: true } });
    await assert.rejects(f.login());
    assert.equal(f.updates.length, 0);
    await f.login({ password: 'correct', role: role === 'administrator' ? 'admin' : role });
    assert.deepEqual(f.updates, [{ uid: 'resident-1', emailVerified: true }]);
    assert.equal(f.profile.email_verification_source, 'legacy_migration');
    assert.equal(f.profile.email_verification_required, false);
    assert.equal(f.tokens.length, 1);
  }
});

test('new, unknown-age and explicitly marked accounts cannot bypass verification', async () => {
  for (const options of [
    { createdAt: '2026-09-17T12:52:25Z' },
    { createdAt: '2026-09-18T00:00:00Z' },
    { createdAt: 'invalid' },
    {},
    { createdAt: '2026-09-01T00:00:00Z', profile: { role: 'resident', email_verification_required: true } },
    { createdAt: '2026-09-01T00:00:00Z', profile: { role: 'resident', email_verification_required: false } },
    { createdAt: '2026-09-01T00:00:00Z', cutoff: 'invalid' }
  ]) {
    const f = fixture({ verified: false, ...options });
    await assert.rejects(f.login({ password: 'correct' }), { code: 'failed-precondition' });
    assert.equal(f.updates.length, 0);
    assert.equal(f.tokens.length, 0);
  }
});

test('legacy migration preserves disabled, missing-profile, approval and role restrictions', async () => {
  for (const options of [
    { disabled: true }, { profile: null },
    { profile: { role: 'resident', is_active: false } },
    { profile: { role: 'resident', approval_status: 'pending' } },
    { profile: { role: 'resident', approval_status: 'denied' } },
    { profile: { role: 'admin', is_active: true } }
  ]) {
    const f = fixture({ verified: false, createdAt: '2026-09-01T00:00:00Z', ...options });
    await assert.rejects(f.login({ password: 'correct' }));
    assert.equal(f.updates.length, 0);
    assert.equal(f.tokens.length, 0);
  }
});

test('failed Auth migration never grants a secure session', async () => {
  const f = fixture({ verified: false, createdAt: '2026-09-01T00:00:00Z', updateFails: true });
  await assert.rejects(f.login({ password: 'correct' }));
  assert.equal(f.tokens.length, 0);
  assert.equal(f.profile.email_verification_source, undefined);
});
