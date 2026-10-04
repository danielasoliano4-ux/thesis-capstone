const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../scripts', file), 'utf8');
const moduleSource = file => read(file).replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');

function shellFixture(saved) {
  const store = new Map([['appPage', saved]]);
  const loads = [];
  let listener;
  const frame = {
    set src(page) { loads.push(page); },
    contentWindow: { location: { href: 'https://example.test/index.html' } },
    addEventListener: (_, callback) => { listener = callback; }
  };
  vm.runInNewContext(read('app-navigation.js'), {
    URL, location: { origin: 'https://example.test', href: 'https://example.test/' },
    document: { getElementById: () => frame },
    sessionStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }
  });
  return { store, loads, load: url => { frame.contentWindow.location.href = 'https://example.test/' + url; listener(); } };
}

test('shell leaves child login navigation alone and never saves a private route', () => {
  const f = shellFixture('login.html');
  f.load('residents');
  assert.deepEqual(f.loads, ['login.html']);
  assert.equal(f.store.has('appPage'), false);
  f.load('login?session=expired');
  assert.equal(f.store.get('appPage'), 'login?session=expired');
  assert.deepEqual(f.loads, ['login.html']);
});

test('shell cannot restore private, external or nested saved URLs', () => {
  for (const saved of ['residents.html', 'residents?tab=history', 'staff', 'history.html',
    'admin', 'admin?report=patients', 'https://other.test/login.html', 'admin/login']) {
    assert.deepEqual(shellFixture(saved).loads, ['index.html'], saved);
  }
});

test('public guard clears restored credentials once without redirecting fresh sign-ins', async () => {
  let ready;
  let signOuts = 0;
  const auth = { currentUser: { uid: 'old' } };
  const context = {
    auth, authPersistenceReady: new Promise(resolve => { ready = resolve; }),
    signOutUser: async () => { signOuts++; auth.currentUser = null; },
    routes: { adminDashboard: '/admin' }, window: {}, console
  };
  vm.createContext(context);
  vm.runInContext(moduleSource('auth-route-guard.js'), context);
  const pending = context.redirectActiveUserFromPublicPage();
  assert.equal(pending, context.redirectActiveUserFromPublicPage());
  ready();
  await pending;
  assert.equal(signOuts, 1);
  auth.currentUser = { uid: 'fresh-login' };
  await context.redirectActiveUserFromPublicPage();
  assert.equal(signOuts, 1);
  assert.equal(auth.currentUser.uid, 'fresh-login');
});

function roleFixture(role, profile, state = 'active') {
  let callback;
  let errorCallback;
  let revealed = false;
  let signedOut = false;
  let destination;
  const auth = { currentUser: { uid: 'user-1' } };
  const store = new Map([['auth-session-state', state]]);
  const context = {
    auth, fetchUserProfile: async () => typeof profile === 'function' ? profile() : profile,
    onAuthStateChanged: (_, listener, error) => { callback = listener; errorCallback = error; },
    signOutUser: async () => { signedOut = true; context.terminateSession(); },
    sessionStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    routes: { adminDashboard: '/admin' }, console,
    window: { location: { replace: url => { destination = url; } }, finishSessionCheck: () => { revealed = true; } }
  };
  vm.createContext(context);
  vm.runInContext(moduleSource('session-state.js') + '\n' + moduleSource('role-guard.js'), context);
  context.protectPage(role, role === 'admin' ? '/admin/login' : '/login.html');
  return { context, store, run: () => callback(auth.currentUser), error: () => errorCallback(), revealed: () => revealed, signedOut: () => signedOut, destination: () => destination };
}

test('approved and legacy staff and administrator aliases pass role checks', async () => {
  for (const [role, profile] of [['clinic_staff', { role: 'clinic_staff' }],
    ['clinic_staff', { role: 'clinic_staff', approval_status: 'approved' }],
    ['admin', { role: 'administrator' }]]) {
    const f = roleFixture(role, profile);
    await f.run();
    assert.equal(f.revealed(), true);
    assert.equal(f.destination(), undefined);
  }
});

test('terminated, pending and denied staff sessions never reveal private pages', async () => {
  for (const [profile, state] of [[{ role: 'clinic_staff' }, 'terminated'],
    [{ role: 'clinic_staff', approval_status: 'pending' }, 'active'],
    [{ role: 'clinic_staff', approval_status: 'denied' }, 'active']]) {
    const f = roleFixture('clinic_staff', profile, state);
    await f.run();
    assert.equal(f.revealed(), false);
    assert.equal(f.signedOut(), true);
    assert.equal(f.destination(), '/login.html?session=expired');
  }
});

test('late profile validation after guest navigation cannot reactivate a terminated session', async () => {
  let respond;
  const f = roleFixture('clinic_staff', () => new Promise(resolve => { respond = resolve; }));
  const pending = f.run();
  f.context.terminateSession();
  respond({ role: 'clinic_staff' });
  await pending;
  assert.equal(f.revealed(), false);
  assert.equal(f.store.get('auth-session-state'), 'terminated');
  assert.equal(f.destination(), '/login.html?session=expired');
});

test('restored private pages revalidate authorization without a reload', async () => {
  const f = roleFixture('admin', { role: 'admin' });
  await f.context.window.revalidateSession();
  assert.equal(f.revealed(), true);
  f.store.set('auth-session-state', 'terminated');
  await f.context.window.revalidateSession();
  assert.equal(f.destination(), '/admin/login?session=expired');
});

test('guest notifications clear cached identity and never subscribe with restored credentials', async () => {
  let callback;
  let pageshow;
  let ready;
  let snapshots = 0;
  const user = { uid: 'old-user' };
  const auth = { currentUser: user };
  const headerName = { textContent: 'Previous resident' };
  const signOutBtn = { style: { display: 'inline-block' } };
  const unreadCount = { textContent: '5' };
  const elements = { headerName, signOutBtn, unreadCount };
  const context = {
    auth, sessionIsTerminated: () => true,
    renderNotifications: items => assert.equal(items.length, 0),
    document: { getElementById: id => elements[id] },
    window: { residentSignOutReady: new Promise(resolve => { ready = resolve; }), addEventListener: (_, listener) => { pageshow = listener; } },
    onAuthStateChanged: (_, listener) => { callback = listener; },
    onSnapshot: () => { snapshots++; }, console
  };
  vm.runInNewContext(read('notifications.js').slice(read('notifications.js').indexOf('let unsubscribeNotifications;')), context);
  const pending = callback(user);
  assert.equal(headerName.textContent, 'Guest');
  assert.equal(signOutBtn.style.display, 'none');
  auth.currentUser = null;
  ready();
  await pending;
  assert.equal(snapshots, 0);
  headerName.textContent = 'Cached resident';
  pageshow({ persisted: true });
  assert.equal(headerName.textContent, 'Guest');
  assert.equal(unreadCount.textContent, '0');
});
