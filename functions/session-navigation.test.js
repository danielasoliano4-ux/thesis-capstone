const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/session-navigation.js'), 'utf8')
  .replace("import('./firebase.js')", 'clearAuth()');
function fixture(page, state, sharedStore) {
  const store = sharedStore || new Map([['resident-session-state', state], ['appPage', 'residents.html']]);
  const events = {};
  let cleared = 0;
  let destination;
  let reloads = 0;
  const style = {};
  let startupCallback;
  let timerCleared = false;
  let elementsCreated = 0;
  let revalidations = 0;
  const user = { uid: 'resident-1' };
  const auth = { currentUser: state === 'active' ? user : null };
  const password = { value: 'old-password' };
  const window = { addEventListener: (name, callback) => { events[name] = callback; }, revalidateSession: () => { revalidations++; } };
  vm.runInNewContext(source, {
    location: { pathname: '/' + page, hostname: 'anti-rabies-locator.web.app', replace: path => { destination = path; }, reload: () => reloads++ },
    sessionStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    document: { getElementById: () => password, createElement: () => { elementsCreated++; return { style: {}, setAttribute() {}, remove() {} }; }, documentElement: { style, append() {} } },
    window,
    setTimeout: callback => { startupCallback = callback; return 1; }, clearTimeout() { timerCleared = true; },
    clearAuth: async () => ({ auth, authPersistenceReady: Promise.resolve(), signOutUser: async () => { cleared++; auth.currentUser = null; } }), console
  });
  return { store, events, style, window, auth, user, password, elementsCreated: () => elementsCreated, revalidations: () => revalidations, startup: () => startupCallback(), timerCleared: () => timerCleared, cleared: () => cleared, destination: () => destination, reloads: () => reloads };
}

test('verified resident session reveals the portal and cancels the startup fallback', () => {
  const f = fixture('residents', 'active');
  f.window.finishResidentSessionCheck();
  assert.equal(f.style.visibility, '');
  assert.equal(f.timerCleared(), true);
  assert.equal(f.elementsCreated(), 0);
  assert.equal(f.destination(), undefined);
});

test('all dashboards render their shell during background validation without a loading overlay', () => {
  for (const page of ['residents', 'staff.html', 'clinic-profile', 'patient-tracking.html',
    'confirmed-appointments', 'clinic-notifications.html', 'history', 'admin', 'admin.html']) {
    for (const state of ['active', null]) {
      const f = fixture(page, state);
      assert.notEqual(f.style.visibility, 'hidden', `${page}: ${state}`);
      assert.equal(f.elementsCreated(), 0, page);
      assert.equal(f.destination(), undefined, page);
      f.window.finishSessionCheck();
      assert.equal(f.timerCleared(), true, page);
    }
  }
});

test('failed portal startup returns to login instead of staying blank', () => {
  const f = fixture('residents', 'active');
  f.startup();
  assert.equal(f.destination(), '/login.html?session=expired');
  assert.equal(f.style.visibility, 'hidden');
});
test('guest navigation terminates the resident session and clears saved portal routing', async () => {
  const f = fixture('index.html', 'active');
  assert.equal(f.store.get('resident-session-state'), 'terminated');
  assert.equal(f.store.has('appPage'), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.cleared(), 1);
});
test('cached guest pages terminate sessions on history restoration', async () => {
  const f = fixture('login', null);
  await f.window.residentSignOutReady;
  f.store.set('resident-session-state', 'active');
  f.auth.currentUser = f.user;
  f.events.pageshow({ persisted: true });
  assert.equal(f.store.get('resident-session-state'), 'terminated');
  assert.equal(f.password.value, '');
  await f.window.residentSignOutReady;
  assert.equal(f.auth.currentUser, null);
});
test('terminated resident history entries remain hidden and redirect to login', () => {
  const f = fixture('residents.html', 'terminated');
  assert.equal(f.style.visibility, 'hidden');
  assert.equal(f.destination(), '/login.html?session=expired');
  f.events.pageshow({ persisted: true });
  assert.equal(f.destination(), '/login.html?session=expired');
  assert.equal(f.reloads(), 0);
});
test('active portal is hidden before caching and revalidated when restored', () => {
  const f = fixture('residents', 'active');
  f.style.visibility = '';
  f.events.pagehide();
  assert.equal(f.style.visibility, 'hidden');
  f.events.pageshow({ persisted: true });
  assert.equal(f.revalidations(), 1);
  assert.equal(f.reloads(), 0);
});

test('initial pageshow during a fresh login does not terminate the new session', async () => {
  const f = fixture('login', null);
  await f.window.residentSignOutReady;
  f.store.set('auth-session-state', 'active');
  f.auth.currentUser = f.user;
  f.events.pageshow({ persisted: false });
  assert.equal(f.store.get('auth-session-state'), 'active');
  assert.equal(f.cleared(), 0);
});

test('Back to guest and Back again cannot reveal a cached private page', async () => {
  const portal = fixture('residents', 'active');
  portal.window.finishSessionCheck();
  portal.events.pagehide();
  const guest = fixture('index', 'active', portal.store);
  portal.events.pageshow({ persisted: true });
  portal.window.finishSessionCheck(); // A late auth response must not reveal it.
  assert.equal(portal.style.visibility, 'hidden');
  assert.equal(portal.destination(), '/login.html?session=expired');
  assert.equal(portal.reloads(), 0);
  await guest.window.residentSignOutReady;
  assert.equal(guest.auth.currentUser, null);
});

test('all private routes block terminated history entries, including clean URLs', () => {
  for (const page of ['residents', 'staff.html', 'clinic-profile', 'patient-tracking.html',
    'confirmed-appointments', 'clinic-notifications.html', 'history', 'admin']) {
    const f = fixture(page, 'terminated');
    assert.equal(f.style.visibility, 'hidden', page);
    assert.equal(f.destination(), page === 'admin' ? '/admin/login?session=expired' : '/login.html?session=expired', page);
  }
});

test('administrator login is a guest route and never redirects to itself', async () => {
  const f = fixture('admin/login', 'active');
  assert.equal(f.store.get('auth-session-state'), 'terminated');
  assert.equal(f.destination(), undefined);
  await f.window.residentSignOutReady;
  assert.equal(f.auth.currentUser, null);
});

test('pending validation cannot reveal a page while it is being cached', () => {
  const f = fixture('residents', 'active');
  f.events.pagehide();
  f.window.finishSessionCheck();
  assert.equal(f.style.visibility, 'hidden');
});
