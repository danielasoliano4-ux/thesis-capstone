'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicClinicStockHandler } = require('./public-clinic-stock');

test('guest totals match resident inventory calculations instead of stale clinic totals', async () => {
  const { availableStock } = await import('../scripts/dose-stock.mjs');
  const { availableQuantity } = await import('../scripts/stock-summary.mjs');
  const batch = { clinic_id: 'clinic', type: 'Verorab', expiry: '2099-01-01',
    quantity: 200, reserved_count: 3, quantity_mode: 'on_hand', staff_uid: 'private-staff' };
  const rows = [batch, { ...batch, quantity: 8, quantity_mode: 'legacy' },
    { ...batch, archived: true }, { ...batch, expiry: '2026-10-05' },
    { ...batch, expiry: '2026-02-30' }, { ...batch, reserved_count: 200 },
    { ...batch, clinic_id: 'other' }, { ...batch, type: '   ' }];
  const snapshots = {
    clinics: [{ id: 'clinic', data: () => ({ stock_total: 200 }) },
      { id: 'empty', data: () => ({ stock_total: 100 }) }],
    inventory: rows.map((item, index) => ({ id: 'batch-' + index, data: () => item }))
  };
  const handler = publicClinicStockHandler({
    db: { collection: name => ({ get: async () => ({ docs: snapshots[name] }) }) },
    now: () => new Date('2026-10-04T16:30:00Z')
  });
  // No authentication is required for public availability.
  const result = await handler({});
  const residentTotal = availableStock(rows, 'clinic', '2026-10-05')
    .reduce((sum, item) => sum + availableQuantity(item), 0);
  assert.equal(result.clinics[0].stock_total, residentTotal);
  assert.equal(residentTotal, 205);
  assert.equal(result.clinics[0].status, 'available');
  assert.equal(result.clinics[1].stock_total, 0);
  assert.equal(result.clinics[1].status, 'out');
  assert.deepEqual(Object.keys(result.clinics[0]).sort(),
    ['id', 'status', 'stock', 'stock_total', 'vaccineTypes'].sort());
  assert.equal(JSON.stringify(result).includes('private-staff'), false);
  assert.equal(JSON.stringify(result).includes('batch-'), false);
  // A reservation change is reflected on the next request.
  batch.reserved_count = 4;
  assert.equal((await handler()).clinics[0].stock_total, 204);
});
