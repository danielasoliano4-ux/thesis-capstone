const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const staff = fs.readFileSync(path.join(__dirname, '../scripts/staff.js'), 'utf8');
const source = staff.slice(staff.indexOf('const pendingInventoryActions'), staff.indexOf('function renderInventory()'));

function fixture(item = {}, overrides = {}) {
  const batch = { batch: 'B1', quantity: 55, expiry: '2099-01-01', reserved_count: 0, ...item };
  const messages = [], confirmations = [], writes = [];
  let renders = 0;
  const context = {
    db: {}, doc: (_, collection, id) => ({ collection, id }),
    getDoc: async () => ({ exists: () => true, data: () => batch }),
    updateDoc: async (ref, data) => writes.push({ action: 'archive', ref, data }),
    deleteDoc: async ref => writes.push({ action: 'delete', ref }),
    serverTimestamp: () => 'server-time',
    inventoryCategory: data => ({ usable: !data.archived && data.quantity > 0 && data.expiry > '2026-10-05' }),
    confirmDialog: async text => { confirmations.push(text); return true; },
    notifyDialog: async text => messages.push(text),
    renderInventory: () => renders++, console: { error() {} }, ...overrides
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const button = action => ({ dataset: action === 'delete' ? { deleteId: 'batch-1' } : { archiveId: 'batch-1' }, textContent: action === 'delete' ? 'Delete' : batch.archived ? 'Restore' : 'Archive', disabled: false });
  return { context, messages, confirmations, writes, renders: () => renders,
    button, run: (action, target = button(action)) => context.manageInventoryBatch(target, action) };
}

test('reserved batches explain why archive and delete are blocked without changing inventory', async () => {
  for (const action of ['archive', 'delete']) {
    const f = fixture({ reserved_count: 1 });
    const button = f.button(action);
    await f.run(action, button);
    assert.equal(f.writes.length, 0);
    assert.equal(f.confirmations.length, 0);
    assert.match(f.messages[0], /1 dose reserved/);
    assert.match(f.messages[0], /completed or cancelled/);
    assert.equal(button.disabled, false);
  }
});

test('unreserved archive and restore use the latest batch state', async () => {
  for (const archived of [false, true]) {
    const f = fixture({ archived });
    await f.run('archive');
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].data.archived, !archived);
    assert.equal(f.writes[0].data.updated_at, 'server-time');
    assert.match(f.messages[0], /successfully/);
  }
});

test('unreserved deletion requires confirmation and cancel preserves the batch', async () => {
  const f = fixture();
  await f.run('delete');
  assert.match(f.confirmations[0], /cannot be undone/);
  assert.equal(f.writes[0].action, 'delete');
  const cancelled = fixture({}, { confirmDialog: async () => false });
  await cancelled.run('delete');
  assert.equal(cancelled.writes.length, 0);
});

test('permission failures show feedback and restore action controls', async () => {
  const f = fixture({}, { updateDoc: async () => { throw Object.assign(new Error('denied'), { code: 'permission-denied' }); } });
  const button = f.button('archive');
  await f.run('archive', button);
  assert.match(f.messages[0], /Could not archive/);
  assert.match(f.messages[0], /reserved doses/);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Archive');
});

test('simultaneous clicks cannot archive and delete the same batch', async () => {
  let respond;
  const f = fixture({}, { getDoc: () => new Promise(resolve => { respond = resolve; }) });
  const pending = f.run('archive');
  await f.run('delete');
  respond({ exists: () => true, data: () => ({ batch: 'B1', reserved_count: 0 }) });
  await pending;
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].action, 'archive');
});

test('empty or expired archived batches cannot be restored to active stock', async () => {
  for (const item of [{ archived: true, quantity: 0 }, { archived: true, expiry: '2026-10-05' }]) {
    const f = fixture(item);
    await f.run('archive');
    assert.equal(f.writes.length, 0);
    assert.match(f.messages[0], /expired or has no doses/);
  }
});

test('a batch removed by another staff member gives feedback without another write', async () => {
  const f = fixture({}, { getDoc: async () => ({ exists: () => false }) });
  await f.run('delete');
  assert.equal(f.writes.length, 0);
  assert.match(f.messages[0], /no longer exists/);
});
