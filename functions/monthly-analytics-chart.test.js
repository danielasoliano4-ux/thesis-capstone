const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const readScript = name => fs.readFileSync(path.join(__dirname, '../scripts', name), 'utf8');
const chartSource = readScript('monthly-analytics-chart.js').replace(/^export /gm, '');
const publicSource = readScript('public-analytics.js').replace(/^import .*;\r?\n/gm, '');
const residentSource = readScript('residents.js');

function fixture({ libraryAvailable = true, existingChart = false } = {}) {
  const charts = new Map();
  const subscriptions = new Map();
  const loadListeners = [];
  const canvas = { hidden: false, parentElement: { classList: { contains: () => true } } };
  const status = { hidden: true, textContent: '' };
  let creations = 0;
  class Chart {
    static getChart(element) { return charts.get(element); }
    constructor(element, configuration) {
      if (charts.has(element)) throw new Error('Canvas is already in use');
      creations++;
      Object.assign(this, configuration);
      this.updates = 0;
      this.resizes = 0;
      charts.set(element, this);
    }
    update() { this.updates++; }
    resize() { this.resizes++; }
  }
  if (existingChart) new Chart(canvas, { data: { datasets: [{ data: [] }, { data: [] }] } });
  const context = vm.createContext({
    window: { Chart: libraryAvailable ? Chart : undefined },
    document: {
      getElementById: id => ({ monthlyChart: canvas, monthlyChartStatus: status })[id],
      querySelector: () => ({ addEventListener: (_, listener) => loadListeners.push(listener) })
    },
    db: {}, doc: (_, collection, id) => id,
    onSnapshot: (id, listener) => subscriptions.set(id, listener),
    renderLiveCaptions() {}, console
  });
  vm.runInContext(chartSource, context);
  vm.runInContext(publicSource, context);
  vm.runInContext(residentSource.slice(
    residentSource.indexOf('function renderCasesChart()'),
    residentSource.indexOf('function renderResVizChart()')
  ), context);
  return {
    context, canvas, status, chart: () => charts.get(canvas), creations: () => creations,
    snapshot(data) { subscriptions.get('live_analytics')({ exists: () => data !== null, data: () => data }); },
    loadLibrary() { context.window.Chart = Chart; loadListeners.forEach(listener => listener()); }
  };
}

test('shared analytics renders the resident monthly chart before account initialization', () => {
  const f = fixture();
  assert.equal(f.creations(), 1);
  f.snapshot({ monthlyCases: [0, 2, 3], monthlyVaccinations: [1, 4, 9] });
  assert.deepEqual(Array.from(f.chart().data.datasets[0].data), [0, 2, 3, ...Array(9).fill(0)]);
  assert.deepEqual(Array.from(f.chart().data.datasets[1].data), [1, 4, 9, ...Array(9).fill(0)]);
  assert.equal(f.chart().options.maintainAspectRatio, false);
});

test('repeated resident initialization and tab refresh preserve the existing live chart', () => {
  const f = fixture();
  f.snapshot({ monthlyCases: [7], monthlyVaccinations: [12] });
  const original = f.chart();
  f.context.renderCasesChart();
  f.context.renderCasesChart();
  assert.equal(f.creations(), 1);
  assert.equal(f.chart(), original);
  assert.equal(f.context.window.residentMonthlyChart, original);
  assert.equal(original.data.datasets[0].data[0], 7);
  assert.equal(original.data.datasets[1].data[0], 12);
  assert.ok(original.resizes >= 2);
});

test('public landing page chart is reused by the shared analytics listener', () => {
  const f = fixture({ existingChart: true });
  f.snapshot({ monthlyCases: [3], monthlyVaccinations: [8] });
  assert.equal(f.creations(), 1);
  assert.equal(f.context.window.publicMonthlyChart, f.chart());
  assert.equal(f.chart().data.datasets[1].data[0], 8);
});

test('late chart library loading restores the most recent analytics snapshot', () => {
  const f = fixture({ libraryAvailable: false });
  f.snapshot({ monthlyCases: [2], monthlyVaccinations: [5] });
  f.snapshot({ monthlyCases: [4], monthlyVaccinations: [11] });
  assert.equal(f.creations(), 0);
  assert.equal(f.status.hidden, false);
  assert.match(f.status.textContent, /could not load/);
  f.loadLibrary();
  assert.equal(f.creations(), 1);
  assert.equal(f.canvas.hidden, false);
  assert.equal(f.status.hidden, true);
  assert.equal(f.chart().data.datasets[0].data[0], 4);
  assert.equal(f.chart().data.datasets[1].data[0], 11);
});

test('an empty analytics snapshot clears previous cases and vaccinations', () => {
  const f = fixture();
  f.snapshot({ monthlyCases: [3], monthlyVaccinations: [8] });
  f.snapshot(null);
  assert.deepEqual(Array.from(f.chart().data.datasets[0].data), Array(12).fill(0));
  assert.deepEqual(Array.from(f.chart().data.datasets[1].data), Array(12).fill(0));
});
