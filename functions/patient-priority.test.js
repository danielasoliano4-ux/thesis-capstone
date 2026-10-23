const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = import('../scripts/patient-priority.mjs');
const appointment = overrides => ({ id: 'a', clinic_id: 'clinic-a', status: 'in_progress', patient_category: 'Category III', ...overrides });

test('category labels come from assessment fields, intake, or saved priority metadata', async () => {
  const { patientCategory } = await model;
  assert.equal(patientCategory({ patient_category: 'category 3' }), 'Category III');
  assert.equal(patientCategory({ course_intake_data: { patient_category: 'Category II' } }), 'Category II');
  assert.equal(patientCategory({ patient_category: 'Category I', priority_category: 'Category III' }), 'Category I');
  assert.equal(patientCategory({}, { patient_category: 'Category III' }), 'Category III');
  assert.equal(patientCategory({ patient_category: 'Unknown' }), '');
});

test('manual priorities appear first and higher categories order ties without automatically prioritizing patients', async () => {
  const { comparePatientPriority, isPriority } = await model;
  const normal = appointment({ id: 'normal', patient_category: 'Category III' });
  const low = appointment({ id: 'low', queue_priority: 'high', patient_category: 'Category I' });
  const high = appointment({ id: 'high', queue_priority: 'high' });
  const completed = appointment({ id: 'completed', queue_priority: 'high', status: 'completed' });
  assert.deepEqual([normal, low, high].sort(comparePatientPriority).map(item => item.id), ['high', 'low', 'normal']);
  assert.equal(isPriority(normal), false);
  assert.equal(isPriority(completed), false);
  assert.equal(comparePatientPriority(normal, completed), 0);
});

test('priority writes affect only active appointments and preserve scheduling and treatment data', async () => {
  const { priorityUpdates } = await model;
  const records = [appointment(), appointment({ id: 'confirmed', status: 'confirmed' }), appointment({ id: 'pending', status: 'pending' }), appointment({ id: 'completed', status: 'completed' })];
  const original = JSON.stringify(records);
  const updates = priorityUpdates(records, 'clinic-a', 'Category III', true, 'staff-a', 'timestamp');
  assert.deepEqual(updates.map(item => item.id), ['a', 'confirmed']);
  assert.deepEqual(updates[0].data, { queue_priority: 'high', priority_category: 'Category III', priority_updated_by: 'staff-a', priority_updated_at: 'timestamp' });
  assert.equal(JSON.stringify(records), original);
  assert.equal(priorityUpdates([appointment()], 'clinic-a', '', false, 'staff-a', 'timestamp')[0].data.queue_priority, 'normal');
});

test('cross-clinic, inactive, and unassessed priority changes fail', async () => {
  const { priorityUpdates } = await model;
  assert.throws(() => priorityUpdates([appointment()], 'clinic-b', 'Category III', true, 'staff-a', 1), /your clinic/);
  for (const status of ['pending', 'completed', 'expired', 'cancelled']) {
    assert.throws(() => priorityUpdates([appointment({ status })], 'clinic-a', 'Category III', true, 'staff-a', 1), /no longer has an active/);
  }
  assert.throws(() => priorityUpdates([appointment()], 'clinic-a', '', true, 'staff-a', 1), /category/);
  assert.throws(() => priorityUpdates([appointment()], 'clinic-a', 'Category III', true, '', 1), /Sign in/);
});

async function serviceFixture(records) {
  const writes = [];
  const reads = [];
  const { priorityUpdates } = await model;
  const context = vm.createContext({
    auth: { currentUser: { uid: 'staff-a' } }, db: {}, priorityUpdates,
    doc: (_db, _collection, id) => id, serverTimestamp: () => 'timestamp',
    runTransaction: async (_db, callback) => callback({
      async get(id) { reads.push(id); return { id, exists: () => Boolean(records[id]), data: () => records[id] }; },
      update(id, data) { writes.push({ id, data }); }
    })
  });
  const source = fs.readFileSync(path.join(__dirname, '../scripts/clinic-priority.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('export async function')).replace('export ', ''), context);
  return { context, writes, reads };
}

test('transaction rechecks current status, skips finished appointments and deduplicates writes', async () => {
  const { context, writes, reads } = await serviceFixture({ a: appointment(), b: appointment({ id: 'b', status: 'completed' }) });
  await context.savePatientPriority(['a', 'b', 'a'], 'clinic-a', 'Category III', true);
  assert.deepEqual(reads, ['a', 'b']);
  assert.deepEqual(writes.map(item => item.id), ['a']);
  const stale = await serviceFixture({ a: appointment({ status: 'completed' }) });
  await assert.rejects(stale.context.savePatientPriority(['a'], 'clinic-a', 'Category III', true), /no longer has an active/);
  assert.equal(stale.writes.length, 0);
  const otherClinic = await serviceFixture({ a: appointment({ clinic_id: 'clinic-b' }) });
  await assert.rejects(otherClinic.context.savePatientPriority(['a'], 'clinic-a', 'Category III', true), /your clinic/);
  assert.equal(otherClinic.writes.length, 0);
});
