const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const recommendations = import(pathToFileURL(path.join(__dirname, '../scripts/clinic-recommendations.mjs')).href);
const now = new Date('2026-10-07T02:00:00Z'); // 10 AM in Manila.
const clinic = (id, stock, lat, hours = '24 hours', status = 'available') => ({ id, name: id, stock_total: stock, lat, lng: 121.12, hours, status });

test('nearest considers open clinics with usable stock; best prioritizes stock among open clinics', async () => {
  const { recommendClinics } = await recommendations;
  const rows = [clinic('Empty', 0, 14.27, '24 hours', 'out'), clinic('Closed', 1000, 14.271, 'Closed'),
    clinic('Nearby', 5, 14.272, '24 hours', 'low'), clinic('Best', 200, 14.28), clinic('Unknown stock', 5000, 14.273, '24 hours', 'unknown'),
    clinic('Unknown hours', 900, 14.273, 'Contact clinic'), clinic('Missing location', 8000, NaN)];
  const result = recommendClinics(rows, [14.27, 121.12], now);
  assert.equal(result.nearest.clinic.id, 'Nearby');
  assert.equal(result.best.clinic.id, 'Best');
  assert.equal(result.highest.clinic.id, 'Closed');
  assert.equal(result.highest.opening, 'closed');
  assert.ok(result.nearest.distance < result.best.distance);
  assert.equal(rows[0].id, 'Empty');
});

test('location is optional for stock recommendations and unknown availability yields no recommendation', async () => {
  const { recommendClinics } = await recommendations;
  const withoutLocation = recommendClinics([clinic('Open', 30, 14.27)], null, now);
  assert.equal(withoutLocation.best.clinic.id, 'Open');
  assert.equal(withoutLocation.best.distance, null);
  assert.equal(withoutLocation.nearest, null);
  const result = recommendClinics([clinic('Loading', null, 14.27, '24 hours', 'unknown'), clinic('Bad coordinates', 90, 100)], [14.27, 121.12], now);
  assert.deepEqual(result, { best: null, nearest: null, highest: null });
  const closed = recommendClinics([clinic('Closed', 30, 14.27, 'Closed')], [14.27, 121.12], now);
  assert.equal(closed.nearest, null);
  assert.equal(closed.best, null);
  assert.equal(closed.highest.clinic.id, 'Closed');
});

test('opening status respects Manila time, weekends, overnight shifts, and closing boundaries', async () => {
  const { clinicOpeningStatus } = await recommendations;
  const weekday = { operatingHours: { weekdayHours: '8 AM - 5 PM', weekendHours: 'Closed' } };
  assert.equal(clinicOpeningStatus(weekday, now), 'open');
  assert.equal(clinicOpeningStatus(weekday, new Date('2026-10-07T09:00:00Z')), 'closed');
  assert.equal(clinicOpeningStatus(weekday, new Date('2026-10-10T02:00:00Z')), 'closed');
  const overnight = { weekdayHours: '10 PM - 6 AM', weekendHours: 'Closed' };
  assert.equal(clinicOpeningStatus(overnight, new Date('2026-10-09T20:00:00Z')), 'open'); // Saturday 4 AM.
  assert.equal(clinicOpeningStatus(overnight, new Date('2026-10-09T22:00:00Z')), 'closed');
  assert.equal(clinicOpeningStatus({ hours: 'Contact clinic' }, now), 'unknown');
});

test('stock ties prefer shorter distance and nearest ties prefer higher stock', async () => {
  const { recommendClinics } = await recommendations;
  const result = recommendClinics([clinic('Far', 40, 14.3), clinic('Near', 40, 14.271), clinic('Same distance, low stock', 4, 14.271)], [14.27, 121.12], now);
  assert.equal(result.best.clinic.id, 'Near');
  assert.equal(result.nearest.clinic.id, 'Near');
  assert.equal(result.highest.clinic.id, 'Near');
});
