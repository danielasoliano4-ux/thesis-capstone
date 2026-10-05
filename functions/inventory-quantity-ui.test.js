const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/staff.js'), 'utf8');
const submitSource = source.slice(source.indexOf("vaccineForm.addEventListener('submit'"), source.indexOf('// The optional chaining matters:'));

function fixture({ current = {}, quantity = '60', changedMetadata = false } = {}) {
  const initial = { id: 'batch', clinic_id: 'clinic', type: 'Verorab', manufacturer: 'Manufacturer', batch: 'LOT1',
    quantity: 55, reserved_count: 1, expiry: '2099-01-01' };
  const values = { vaccineDocId: 'batch', vacType: 'Verorab (PVRV)', vacGeneric: 'PVRV', vacManufacturer: 'Manufacturer', vacBatch: 'LOT1', vacQuantity: quantity, vacExpiry: '2099-01-01' };
  const elements = Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value }]));
  const button = { disabled: false, textContent: 'Save Stock' };
  const writes = [], messages = [];
  let submit, closed = false;
  vm.runInNewContext(submitSource, {
    vaccineForm: { addEventListener: (_, handler) => { submit = handler; }, querySelector: () => button },
    document: { getElementById: id => elements[id] }, currentClinicId: 'clinic', inventoryItems: [initial],
    inventoryCategory: () => ({ expired: false }), manilaToday: () => '2026-10-05',
    vaccineBrandSelect: elements.vacType, vaccineGenericSelect: elements.vacGeneric,
    vaccineBrands: [{ value: 'Verorab (PVRV)', brand: 'Verorab', generic: 'PVRV' }],
    inventoryEditMetadata: 'original', inventoryFormMetadata: () => changedMetadata ? 'changed' : 'original',
    db: {}, doc: (_, collection, id) => ({ collection, id }), serverTimestamp: () => 'server-time',
    runTransaction: async (_, callback) => callback({
      get: async () => ({ exists: () => true, data: () => ({ ...initial, ...current }) }),
      update: (ref, patch) => writes.push({ ref, patch })
    }),
    closeModal: () => { closed = true; }, notifyDialog: message => messages.push(message), console: { error() {} }
  });
  return { writes, messages, button, closed: () => closed, submit: () => submit({ preventDefault() {} }) };
}

test('quantity updates on legacy reserved batches leave all protected metadata and reservations untouched', async () => {
  const f = fixture();
  await f.submit();
  assert.equal(f.writes.length, 1);
  assert.deepEqual(Object.keys(f.writes[0].patch).sort(), ['quantity', 'quantity_mode', 'updated_at']);
  assert.equal(f.writes[0].patch.quantity, 60);
  assert.equal(f.writes[0].patch.quantity_mode, 'on_hand');
  assert.equal(f.closed(), true);
  assert.equal(f.button.disabled, false);
});

test('fresh reservation counts prevent reducing stock below doses reserved since the form opened', async () => {
  const f = fixture({ quantity: '2', current: { reserved_count: 3 } });
  await f.submit();
  assert.equal(f.writes.length, 0);
  assert.match(f.messages[0], /3 doses currently reserved/);
  assert.equal(f.closed(), false);
});

test('reservations arriving during metadata edits require reopening rather than silently dropping edits', async () => {
  const f = fixture({ changedMetadata: true });
  await f.submit();
  assert.equal(f.writes.length, 0);
  assert.match(f.messages[0], /Reopen the form/);
  assert.equal(f.button.textContent, 'Save Stock');
});

test('batches without reservations can still update their vaccine and batch metadata', async () => {
  const f = fixture({ current: { reserved_count: 0 }, changedMetadata: true });
  await f.submit();
  assert.equal(f.writes[0].patch.type, 'Verorab (PVRV)');
  assert.equal(f.writes[0].patch.brand_name, 'Verorab');
});

test('fractional and negative quantities never write inventory', async () => {
  for (const quantity of ['1.5', '-1']) {
    const f = fixture({ quantity });
    await f.submit();
    assert.equal(f.writes.length, 0);
    assert.match(f.messages[0], /whole number/);
  }
});

test('updates reject batches that now belong to another clinic', async () => {
  const f = fixture({ current: { clinic_id: 'other' } });
  await f.submit();
  assert.equal(f.writes.length, 0);
  assert.match(f.messages[0], /another clinic/);
});
