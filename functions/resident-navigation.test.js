const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '../scripts/residents.js'), 'utf8');
const navigation = fs.readFileSync(path.join(__dirname, '../scripts/resident-navigation.js'), 'utf8');

test('resident dashboard module parses before registering click handlers', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: source, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});

test('resident tabs switch panels without waiting for database data', () => {
  const tabs = ['overview', 'appointments', 'records', 'firstaid', 'notifications', 'booking-records'];
  const element = () => {
    const classes = new Set();
    return { classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name)
    } };
  };
  const panels = Object.fromEntries(tabs.map(tab => ['panel-' + tab, element()]));
  const links = tabs.map(element);
  const context = vm.createContext({
    document: {
      querySelectorAll: selector => selector === '.tab-panel' ? Object.values(panels) : links,
      getElementById: id => panels[id]
    },
    window: {}, renderCasesChart() {}
  });
  vm.runInContext(navigation, context);
  for (const [index, tab] of tabs.entries()) {
    context.window.showTab(tab, links[index]);
    for (const [otherIndex, otherTab] of tabs.entries()) {
      assert.equal(panels['panel-' + otherTab].classList.contains('active'), otherTab === tab);
      assert.equal(links[otherIndex].classList.contains('active'), otherIndex === index);
    }
  }
});

test('resident data listeners start even while the profile has not loaded', async () => {
  const subscriptions = [];
  const errors = [];
  const status = { hidden: true };
  const context = vm.createContext({
    currentUid: null, currentResidentName: '',
    auth: { currentUser: { uid: 'resident-1' } }, db: {},
    document: { getElementById: id => id === 'residentDataStatus' ? status : {} },
    window: {}, console: { error: (...args) => errors.push(args) },
    doc: (_, name) => name, collection: (_, name) => name,
    query: name => name, where() {},
    onSnapshot: (name, success, failure) => subscriptions.push({ name, failure }),
    loadResidentNotifications() {}, loadResidentBookings() {},
    listenToAnimalExposure() {}, listenToDashboardAnalytics() {},
    loadVaccinationDocuments() {}
  });
  vm.runInContext(source.slice(source.indexOf('async function loadResidentDashboard('), source.indexOf('function populateResidentProfile(')), context);
  await context.loadResidentDashboard('resident-1', { name: 'Resident' });
  assert.deepEqual(subscriptions.map(item => item.name), ['residents', 'appointments', 'treatments', 'vaccination_records']);
  subscriptions.find(item => item.name === 'residents').failure(new Error('offline'));
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /Could not load profile/);
  assert.equal(errors.length, 1);
});

test('dashboard initializes when its module arrives after DOMContentLoaded', () => {
  const boot = source.slice(source.indexOf("if (document.readyState === 'loading')"), source.indexOf("let appointmentDisplayKey ="));
  for (const readyState of ['loading', 'interactive', 'complete']) {
    let starts = 0;
    let listener;
    vm.runInNewContext(boot, {
      initializeResidentDashboard: () => starts++,
      document: { readyState, addEventListener: (event, callback, options) => {
        assert.equal(event, 'DOMContentLoaded');
        assert.equal(options.once, true);
        listener = callback;
      } }
    });
    assert.equal(starts, readyState === 'loading' ? 0 : 1);
    if (listener) { listener(); assert.equal(starts, 1); }
  }
});
