const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { localAppointmentHistory } = require('./redact-clinic-history');

test('cleanup removes only foreign history copies and preserves original records', () => {
  const own = { clinic_id: 'clinic-a', dose_number: 2 };
  const foreign = { clinic_id: 'clinic-b', dose_number: 1 };
  const history = [foreign, own, { dose_number: 3 }];
  const appointment = { clinic_id: 'clinic-a', course_vaccination_history: history };
  assert.deepEqual(localAppointmentHistory(appointment), [own]);
  assert.equal(history.length, 3);
  assert.equal(localAppointmentHistory({ clinic_id: 'clinic-a', course_vaccination_history: [own] }), null);
});

test('missing clinic IDs never enter a Firestore stock query', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/dose-completion.js'), 'utf8');
  const stock = source.slice(source.indexOf('let unsubscribe;'), source.indexOf('const manageTreatment'))
    .replace('export function', 'function');
  let queried = 0;
  const select = { replaceChildren() {}, disabled: false };
  const context = { document: { getElementById: () => select }, Option: function(text, value) { this.text = text; this.value = value; },
    collection: () => ({}), db: {}, query: () => ({}), where: (_, __, value) => { assert.equal(value, 'clinic-a'); queried++; },
    onSnapshot: () => () => {} };
  vm.runInNewContext(stock, context);
  for (const value of [undefined, null, '']) assert.throws(() => context.watchDoseStock(value), /clinic account is still loading/);
  assert.equal(queried, 0);
  context.watchDoseStock('clinic-a');
  assert.equal(queried, 1);
});
