import { db } from './firebase.js';
import { doc, onSnapshot } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

const defaultAnimals = [
  { name: 'Dog', percent: 68 }, { name: 'Cat', percent: 20 },
  { name: 'Bat', percent: 8 }, { name: 'Others', percent: 4 }
];

function escapeHtml(value = '') {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}

function renderAnimalExposure(data = {}) {
  const chart = document.getElementById('animalExposureChart');
  if (!chart) return;
  const colors = ['#e60000', '#d98a00', '#00b140', '#6b7280'];
  const animals = normalizeAnimals(Array.isArray(data.animals) && data.animals.length ? data.animals : defaultAnimals);
  let offset = 0;
  const stops = animals.map((animal, index) => {
    const start = offset;
    offset += Number(animal.percent) || 0;
    return `${colors[index % colors.length]} ${start}% ${offset}%`;
  }).join(', ');
  chart.innerHTML = `<div class="animal-donut" style="background:conic-gradient(${stops});"><div><strong>${escapeHtml(animals[0].percent)}%</strong><small>${escapeHtml(animals[0].name)}</small></div></div><div class="donut-legend">${animals.map((animal, index) => `<div class="donut-legend-item"><span class="donut-dot" style="background:${colors[index % colors.length]};"></span> ${escapeHtml(animal.name)} — ${escapeHtml(animal.percent)}%</div>`).join('')}</div>`;
}

onSnapshot(doc(db, 'system_settings', 'live_analytics'), snapshot => {
  const data = snapshot.exists() ? snapshot.data() : {};
  renderAnimalExposure(data);
  const defaults = { monthlyCases: Array(12).fill(0), monthlyVaccinations: Array(12).fill(0), caseTrend: Array(12).fill(0), ageGroups: [0, 0, 0, 0, 0], barangays: [] };
  const values = { ...defaults, ...data };
  setText('publicTotalCases', values.totalCases || 0);
  setText('publicDeaths', values.deaths || 0);
  setText('publicVaccinations', values.totalVaccinations || 0);
  setText('publicHighRiskBarangays', values.highRiskBarangays || 0);
  renderPublicRecords(Array.isArray(values.publicRecords) ? values.publicRecords : []);
  if (window.monthlyChart) {
    window.monthlyChart.data.datasets[0].data = values.monthlyCases;
    window.monthlyChart.data.datasets[1].data = values.monthlyVaccinations;
    window.monthlyChart.update();
  }
  renderList('barangayIncidentRate', values.barangays, item => `<div class="bgy-row"><div class="bgy-row-top"><span class="bgy-name">${escapeHtml(item.name)}</span><span class="bgy-count">${escapeHtml(item.cases)} cases</span></div><div class="bgy-bar-wrap"><div class="bgy-bar-fill fill-high" style="width:${Math.min(100, Number(item.cases) * 3)}%;"></div></div></div>`);
  renderList('caseTrendChart', values.caseTrend, (value, index) => `<div class="trend-bar" style="height:${Math.min(100, Number(value))}%;background:${index === 5 ? '#e60000' : '#d98a00'};" title="${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][index]}: ${escapeHtml(value)}"></div>`);
  renderList('ageGroupChart', values.ageGroups, (value, index) => `<div class="age-row"><span class="age-label">${['0–9','10–19','20–39','40–59','60+'][index]}</span><div class="age-bar-wrap"><div class="age-bar-fill" style="width:${Math.min(100, Number(value) * 2)}%;"></div></div><span class="age-count">${escapeHtml(value)}</span></div>`);
}, error => console.error('Failed to load dashboard analytics:', error));

function renderList(id, values, renderItem) {
  const element = document.getElementById(id);
  if (!element || !Array.isArray(values) || !values.length) return;
  element.innerHTML = values.map(renderItem).join('');
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function normalizeAnimals(animals) {
  const counts = new Map();
  animals.forEach(animal => {
    const rawName = String(animal.name || 'Others').trim().toLowerCase();
    const name = rawName === 'dog' ? 'Dog'
      : rawName === 'cat' ? 'Cat'
        : rawName === 'bat' ? 'Bat'
          : rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : 'Others';
    counts.set(name, (counts.get(name) || 0) + Number(animal.percent || 0));
  });
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1])
    .map(([name, value]) => ({ name, percent: total ? Math.round(value / total * 100) : 0 }));
}

function outcomeLabel(outcome) {
  return outcome === 'death' ? 'Death' : outcome === 'recovered' ? 'Recovered' : 'Ongoing';
}

function renderPublicRecords(records) {
  const body = document.getElementById('recordsTbody');
  if (!body) return;
  body.innerHTML = records.length ? records.map(record => {
    const severity = String(record.severity || 'Low').toLowerCase();
    const outcome = String(record.outcome || 'ongoing').toLowerCase();
    const pep = outcome === 'recovered' ? 'Full 5-dose course completed' : outcome === 'death' ? 'Reported fatal outcome' : `${Number(record.doseCount || 0)} of 5 doses recorded`;
    return `<tr class="accordion-row" data-outcome="${escapeHtml(outcome)}" tabindex="0"><td><strong>${escapeHtml(record.caseId)}</strong></td><td>${escapeHtml(record.year)}</td><td>${escapeHtml(record.barangay)}</td><td>${escapeHtml(record.animal)}</td><td>${escapeHtml(record.category)}</td><td><span class="severity-badge sev-${severity}">${escapeHtml(record.severity)}</span></td><td><span class="outcome-badge out-${outcome}">${outcomeLabel(outcome)}</span></td><td style="color:#94a3b8;font-size:12px;"><i class="fa-solid fa-chevron-down"></i></td></tr><tr class="accordion-detail" hidden><td colspan="8"><div class="accordion-detail-grid"><div class="detail-item"><label>Case date</label><span>${escapeHtml(record.date)}</span></div><div class="detail-item"><label>PEP progress</label><span>${escapeHtml(pep)}</span></div><div class="detail-item"><label>Vaccine used</label><span>${escapeHtml(record.vaccine)}</span></div><div class="detail-item"><label>Reporting facility</label><span>${escapeHtml(record.clinic)}</span></div><div class="detail-item"><label>Status</label><span style="font-weight:700;">${outcomeLabel(outcome)}</span></div></div></td></tr>`;
  }).join('') : '<tr><td colspan="8">No anonymized records are available yet.</td></tr>';
  body.querySelectorAll('.accordion-row').forEach(row => {
    row.addEventListener('click', () => toggleRecordRow(row));
    row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleRecordRow(row); } });
  });
  updateRecordCount();
}

function toggleRecordRow(row) {
  const detail = row.nextElementSibling;
  if (!detail?.classList.contains('accordion-detail')) return;
  detail.hidden = !detail.hidden;
  row.classList.toggle('expanded', !detail.hidden);
}

function updateRecordCount() {
  const rows = [...document.querySelectorAll('#recordsTbody .accordion-row')];
  const shown = rows.filter(row => row.style.display !== 'none').length;
  setText('recordsCount', `Showing ${shown} of ${rows.length} records`);
}

window.toggleRow = toggleRecordRow;
window.setFilter = (filter, button) => {
  document.querySelectorAll('.records-filter-btn').forEach(item => item.classList.toggle('active-filter', item === button));
  document.querySelectorAll('#recordsTbody .accordion-row').forEach(row => {
    const show = filter === 'all' || row.dataset.outcome === filter;
    row.style.display = show ? '' : 'none';
    const detail = row.nextElementSibling;
    if (detail?.classList.contains('accordion-detail')) { detail.style.display = show ? '' : 'none'; if (!show) detail.hidden = true; }
  });
  updateRecordCount();
};
window.filterRecords = query => {
  const needle = String(query || '').trim().toLowerCase();
  document.querySelectorAll('#recordsTbody .accordion-row').forEach(row => {
    const show = !needle || row.textContent.toLowerCase().includes(needle);
    row.style.display = show ? '' : 'none';
    const detail = row.nextElementSibling;
    if (detail?.classList.contains('accordion-detail')) { detail.style.display = show ? '' : 'none'; if (!show) detail.hidden = true; }
  });
  updateRecordCount();
};
