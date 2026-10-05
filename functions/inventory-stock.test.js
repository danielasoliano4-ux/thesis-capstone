'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inventoryStockHandler } = require('./inventory-stock');

const batch = { clinic_id: 'clinic', type: 'Verorab', quantity: 50, reserved_count: 1, quantity_mode: 'on_hand', expiry: '2099-01-01' };
const event = (before, after) => ({ data: { before: { data: () => before }, after: { data: () => after } } });

function fixture() {
  const rows = new Map([
    ['clinics/clinic', { name: 'Clinic', stock_total: 50 }],
    ['inventory/batch', { ...batch }]
  ]);
  const db = {
    collection: name => ({
      doc: id => ({ path: name + '/' + id }),
      where: (field, operator, value) => ({ name, field, value })
    }),
    runTransaction: async callback => {
      const writes = [];
      const value = await callback({
        get: async target => {
          assert.equal(writes.length, 0, 'transaction reads must precede writes');
          if (target.field) return {
            docs: [...rows].filter(([path, item]) => path.startsWith(target.name + '/') && item[target.field] === target.value)
              .map(([path, item]) => ({ id: path.split('/')[1], data: () => structuredClone(item) }))
          };
          return { exists: rows.has(target.path), data: () => structuredClone(rows.get(target.path)) };
        },
        set: (target, data, options) => writes.push(() => rows.set(target.path, options?.merge ? { ...rows.get(target.path), ...data } : data))
      });
      writes.forEach(write => write());
      return value;
    }
  };
  return { rows, handle: inventoryStockHandler({ db, timestamp: () => 'server-time', now: () => new Date('2026-10-05T00:00:00Z') }) };
}

test('a delayed inventory event publishes current availability without modifying physical inventory', async () => {
  const f = fixture();
  f.rows.get('inventory/batch').reserved_count = 2;
  const physicalBefore = structuredClone(f.rows.get('inventory/batch'));
  await f.handle(event({ ...batch, reserved_count: 0 }, { ...batch, reserved_count: 1 }));
  assert.equal(f.rows.get('clinics/clinic').stock_total, 48);
  assert.equal(f.rows.get('clinics/clinic').stock_summary, 'Verorab: 48');
  assert.equal(f.rows.get('clinics/clinic').stock_status, 'available');
  assert.equal(f.rows.get('clinics/clinic').name, 'Clinic');
  assert.deepEqual(f.rows.get('inventory/batch'), physicalBefore);
});

test('completion and cancellation remain correct when older reservation events are retried', async () => {
  for (const quantity of [49, 50]) {
    const f = fixture();
    Object.assign(f.rows.get('inventory/batch'), { quantity, reserved_count: 0 });
    await f.handle(event({ ...batch, reserved_count: 0 }, batch));
    await f.handle(event(undefined, batch));
    assert.equal(f.rows.get('clinics/clinic').stock_total, quantity);
    assert.equal(f.rows.get('inventory/batch').quantity, quantity);
    assert.equal(f.rows.get('inventory/batch').reserved_count, 0);
  }
});

test('inventory additions and adjustments publish usable unreserved stock only', async () => {
  const f = fixture();
  f.rows.set('inventory/low', { ...batch, type: 'Speeda', quantity: 10, reserved_count: 1 });
  f.rows.set('inventory/expired', { ...batch, quantity: 500, expiry: '2026-10-05' });
  f.rows.set('inventory/archived', { ...batch, quantity: 500, archived: true });
  f.rows.set('inventory/other', { ...batch, clinic_id: 'other', quantity: 500 });
  await f.handle(event(undefined, batch));
  assert.equal(f.rows.get('clinics/clinic').stock_total, 58);
  Object.assign(f.rows.get('inventory/batch'), { quantity: 1, reserved_count: 1 });
  await f.handle(event(batch, { ...batch, quantity: 1 }));
  assert.equal(f.rows.get('clinics/clinic').stock_total, 9);
  assert.equal(f.rows.get('clinics/clinic').stock_status, 'low');
});

test('archiving or deleting the last usable batch publishes zero availability', async () => {
  for (const archived of [false, true]) {
    const f = fixture();
    if (archived) f.rows.get('inventory/batch').archived = true;
    else f.rows.delete('inventory/batch');
    await f.handle(event(batch, archived ? { ...batch, archived: true } : undefined));
    assert.equal(f.rows.get('clinics/clinic').stock_total, 0);
    assert.equal(f.rows.get('clinics/clinic').stock_status, 'out');
    assert.equal(f.rows.get('clinics/clinic').stock_summary, '0 doses');
  }
});

test('moving an unreserved batch refreshes both clinics and skips deleted clinics', async () => {
  const f = fixture();
  f.rows.set('clinics/other', { name: 'Other clinic' });
  Object.assign(f.rows.get('inventory/batch'), { clinic_id: 'other', reserved_count: 0 });
  await f.handle(event({ ...batch, reserved_count: 0 }, { ...batch, clinic_id: 'other', reserved_count: 0 }));
  assert.equal(f.rows.get('clinics/clinic').stock_total, 0);
  assert.equal(f.rows.get('clinics/other').stock_total, 50);
  f.rows.delete('clinics/other');
  await f.handle(event({ ...batch, clinic_id: 'other' }, undefined));
  assert.equal(f.rows.has('clinics/other'), false);
});
