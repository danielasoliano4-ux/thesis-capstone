const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/resident-account.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');

function fixture({ readyState = 'complete', profile = { role: 'resident', full_name: 'Maria Santos' }, signOutError } = {}) {
  const ids = ['headerName', 'recordName', 'profileModal', 'profileMessage', 'profileUsername',
    'profileEmail', 'profilePhone', 'profileBirthday', 'profileGender', 'profileAddress',
    'profileBtn', 'profileClose', 'profileForm', 'signOutBtn', 'residentDataStatus'];
  const elements = Object.fromEntries(ids.map(id => {
    const classes = new Set();
    return [id, { value: '', textContent: '', innerHTML: 'Sign Out', style: {}, events: {}, attributes: {},
      addEventListener(event, callback) { this.events[event] = callback; },
      setAttribute(key, value) { this.attributes[key] = value; }, focus() {},
      classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) }
    }];
  }));
  const saveButton = {};
  elements.profileForm.querySelector = () => saveButton;
  const events = {};
  let authListener, snapshotListener, destination, signOuts = 0, unsubscribed = 0;
  const writes = [];
  const user = { uid: 'resident-1', email: 'maria@example.test' };
  const auth = { currentUser: user };
  vm.runInNewContext(source, {
    auth, db: {}, sessionIsTerminated: () => false,
    fetchUserProfile: async () => typeof profile === 'function' ? profile() : profile,
    onAuthStateChanged: (_, callback) => { authListener = callback; },
    onSnapshot: (_, callback) => { snapshotListener = callback; return () => unsubscribed++; },
    doc: (_, collection, uid) => ({ collection, uid }),
    setDoc: async (...args) => writes.push(args),
    signOutUser: async () => { signOuts++; if (signOutError) throw signOutError; auth.currentUser = null; },
    document: { readyState, getElementById: id => elements[id], addEventListener: (event, callback) => { events[event] = callback; } },
    window: { location: { replace: url => { destination = url; } } }, console: { error() {} }
  });
  if (readyState === 'loading') events.DOMContentLoaded();
  return { elements, events, auth, user, writes, saveButton,
    authenticate: () => authListener(auth.currentUser),
    snapshot: data => snapshotListener({ exists: () => !!data, data: () => data }),
    destination: () => destination, signOuts: () => signOuts, unsubscribed: () => unsubscribed };
}

test('account name and profile work without loading the dashboard module, including late DOM startup', async () => {
  for (const readyState of ['loading', 'interactive', 'complete']) {
    const f = fixture({ readyState });
    await f.authenticate();
    assert.equal(f.elements.headerName.textContent, 'Maria Santos');
    f.snapshot({ first_name: 'Maria', last_name: 'Santos', username: 'Maria S.', phone: '09123456789' });
    assert.equal(f.elements.headerName.textContent, 'Maria S.');
    assert.equal(f.elements.profilePhone.value, '09123456789');
    f.elements.profileBtn.events.click();
    assert.equal(f.elements.profileModal.classList.contains('open'), true);
    assert.equal(f.elements.profileModal.attributes['aria-hidden'], 'false');
    f.events.keydown({ key: 'Escape' });
    assert.equal(f.elements.profileModal.classList.contains('open'), false);
  }
});

test('profile opens and sign out works even while profile lookup is stalled', async () => {
  const f = fixture({ profile: () => new Promise(() => {}) });
  f.authenticate();
  assert.equal(f.elements.headerName.textContent, 'maria@example.test');
  f.elements.profileBtn.events.click();
  assert.equal(f.elements.profileModal.classList.contains('open'), true);
  await f.elements.signOutBtn.events.click();
  assert.equal(f.signOuts(), 1);
  assert.equal(f.destination(), 'login.html');
});

test('sign out failure restores the button and displays a retry message', async () => {
  const f = fixture({ signOutError: new Error('offline') });
  await f.elements.signOutBtn.events.click();
  assert.equal(f.elements.signOutBtn.disabled, false);
  assert.equal(f.elements.signOutBtn.innerHTML, 'Sign Out');
  assert.equal(f.elements.residentDataStatus.hidden, false);
  assert.equal(f.destination(), undefined);
});

test('profile saves merge details and can create a missing resident document with its owner UID', async () => {
  const f = fixture();
  await f.authenticate();
  f.snapshot(null);
  f.elements.profileUsername.value = '  Maria S.  ';
  await f.elements.profileForm.events.submit({ preventDefault() {}, currentTarget: f.elements.profileForm });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0][0].uid, f.user.uid);
  assert.equal(f.writes[0][1].uid, f.user.uid);
  assert.equal(f.writes[0][1].username, 'Maria S.');
  assert.equal(f.writes[0][2].merge, true);
  assert.equal(f.elements.headerName.textContent, 'Maria S.');
  assert.equal(f.saveButton.disabled, false);
});

test('late profile responses after sign out cannot attach resident listeners', async () => {
  let respond;
  const f = fixture({ profile: () => new Promise(resolve => { respond = resolve; }) });
  const pending = f.authenticate();
  await f.elements.signOutBtn.events.click();
  respond({ role: 'resident', full_name: 'Old name' });
  await pending;
  assert.equal(f.elements.headerName.textContent, 'maria@example.test');
});
