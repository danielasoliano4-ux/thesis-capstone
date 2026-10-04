'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../scripts/login-security.js'), 'utf8').trimStart()
  .replace(/^import .*;\r?\n/gm, '').replace(/^const secureLogin = .*;\r?\n/m, '').replace('export function', 'function');
function fixture(handler, storage = new Map(), remember = false) {
  const persistence = [];
  const sessions = [];
  const events = {};
  let time = 1000000;
  let tick;
  let calls = 0;
  let resend;
  const messages = [];
  const button = { textContent: 'Sign In', disabled: false, insertAdjacentElement: (_, element) => { resend = element; } };
  const context = {
    Date: { now: () => time }, Math, Number, console: { error: () => {} },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    window: { addEventListener: (name, callback) => { events[name] = callback; } },
    document: { createElement: () => ({ addEventListener: () => {} }) },
    setInterval: callback => { tick = callback; },
    auth: {}, authPersistenceReady: Promise.resolve(),
    activateSession: role => sessions.push(role),
    browserLocalPersistence: "local", browserSessionPersistence: "session",
    setPersistence: async (_, mode) => { persistence.push(mode); },
    secureLogin: async args => { calls++; return handler(args); },
    signInWithCustomToken: async () => ({ user: { uid: 'resident' } })
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const controller = context.createLoginController(button, message => messages.push(message), () => 'resident', () => remember);
  return { controller, button, messages, storage, persistence, sessions, context, events, resend: () => resend, calls: () => calls, advance: ms => { time += ms; tick(); } };
}
test('server cooldown disables login, persists on reload, counts down and expires', async () => {
  const f = fixture(async () => { throw { code: 'functions/resource-exhausted', message: 'Wait', details: { retryAfterMs: 60000 } }; });
  await f.controller.attempt('a@example.com', 'wrong');
  assert.equal(f.button.disabled, true);
  assert.equal(f.button.textContent, 'Try again in 60s');
  await f.controller.attempt('other@example.com', 'correct');
  assert.equal(f.calls(), 1);
  const reloaded = fixture(async () => ({ data: { token: 'token' } }), f.storage);
  assert.equal(reloaded.button.disabled, true);
  reloaded.advance(59000);
  assert.equal(reloaded.button.textContent, 'Try again in 1s');
  reloaded.advance(1000);
  assert.equal(reloaded.button.disabled, false);
  assert.equal(reloaded.button.textContent, 'Sign In');
});
test('unverified login shows a message without creating verification controls', async () => {
  const f = fixture(async () => { throw { code: 'functions/failed-precondition', message: 'Verify email', details: { reason: 'email-unverified' } }; });
  await f.controller.attempt('a@example.com', 'correct');
  assert.equal(f.resend(), undefined);
  assert.equal(f.button.disabled, false);
  const invalid = fixture(async () => { throw { code: 'functions/unauthenticated', message: 'Invalid credentials', details: { remainingAttempts: 4 } }; });
  await invalid.controller.attempt('a@example.com', 'wrong');
  assert.equal(invalid.resend(), undefined);
  assert.ok(invalid.messages[0].includes('4 attempts remaining'));
});
test('double clicks cannot create parallel login requests', async () => {
  let complete;
  const f = fixture(() => new Promise(resolve => { complete = resolve; }));
  const first = f.controller.attempt('a@example.com', 'correct');
  await Promise.resolve();
  assert.equal(await f.controller.attempt('a@example.com', 'correct'), null);
  assert.equal(f.calls(), 1);
  complete({ data: { token: 'token' } });
  assert.ok((await first).user);
});

test('remember me selects persistent authentication; unchecked uses session authentication', async () => {
  for (const remember of [false, true]) {
    const f = fixture(async () => ({ data: { token: 'token' } }), new Map(), remember);
    assert.ok(await f.controller.attempt('a@example.com', 'correct'));
    assert.deepEqual(f.persistence, [remember ? 'local' : 'session']);
    assert.deepEqual(f.sessions, ['resident']);
  }
});

test('fresh sign-in waits for guest-side sign-out before creating new credentials', async () => {
  let finishSignOut;
  const f = fixture(async () => ({ data: { token: 'token' } }));
  f.context.window.residentSignOutReady = new Promise(resolve => { finishSignOut = resolve; });
  const login = f.controller.attempt('a@example.com', 'correct');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.sessions, []);
  finishSignOut();
  assert.ok((await login).user);
  assert.deepEqual(f.sessions, ['resident']);
});

test('leaving the login page while the server is responding cancels sign-in', async () => {
  let respond;
  const f = fixture(() => new Promise(resolve => { respond = resolve; }));
  const login = f.controller.attempt('a@example.com', 'correct');
  await new Promise(resolve => setImmediate(resolve));
  f.events.pagehide();
  respond({ data: { token: 'token' } });
  assert.equal(await login, null);
  assert.deepEqual(f.sessions, []);
  assert.deepEqual(f.persistence, []);
});
