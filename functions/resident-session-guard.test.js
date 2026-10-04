const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/resident-session-guard.js'), 'utf8').replace(/^import .*;\r?\n/gm, '');
function fixture(profile, state = 'active') {
  let callback;
  let revealed = false;
  let destination;
  let signedOut = false;
  const user = { uid: 'resident-1' };
  vm.runInNewContext(source, {
    auth: { currentUser: user },
    fetchUserProfile: async () => profile,
    onAuthStateChanged: (_, listener) => { callback = listener; },
    signOutUser: async () => { signedOut = true; },
    sessionIsTerminated: () => state === 'terminated',
    activateSession: () => { state = 'active'; },
    sessionStorage: { getItem: () => state, setItem: (_, value) => { state = value; } },
    document: { documentElement: { style: {} } }, console,
    window: { location: { replace: path => { destination = path; } }, finishResidentSessionCheck: () => { revealed = true; } }
  });
  return { run: () => callback(user), revealed: () => revealed, destination: () => destination, signedOut: () => signedOut };
}
test('valid residents are revealed without dashboard initialization', async () => {
  const f = fixture({ role: 'resident' });
  await f.run();
  assert.equal(f.revealed(), true);
  assert.equal(f.destination(), undefined);
});
test('invalid profiles redirect without waiting for a hidden dialog', async () => {
  const f = fixture(null);
  await f.run();
  assert.equal(f.revealed(), false);
  assert.equal(f.signedOut(), true);
  assert.equal(f.destination(), '/login.html?session=expired');
});
test('terminated sessions cannot reveal resident content', async () => {
  const f = fixture({ role: 'resident' }, 'terminated');
  await f.run();
  assert.equal(f.revealed(), false);
  assert.equal(f.destination(), '/login.html?session=expired');
});
