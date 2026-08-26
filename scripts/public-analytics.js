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
  const animals = Array.isArray(data.animals) && data.animals.length ? data.animals : defaultAnimals;
  let offset = 0;
  const stops = animals.map((animal, index) => {
    const start = offset;
    offset += Number(animal.percent) || 0;
    return `${colors[index % colors.length]} ${start}% ${offset}%`;
  }).join(', ');
  chart.innerHTML = `<div class="animal-donut" style="background:conic-gradient(${stops});"><div><strong>${escapeHtml(animals[0].percent)}%</strong><small>${escapeHtml(animals[0].name)}</small></div></div><div class="donut-legend">${animals.map((animal, index) => `<div class="donut-legend-item"><span class="donut-dot" style="background:${colors[index % colors.length]};"></span> ${escapeHtml(animal.name)} — ${escapeHtml(animal.percent)}%</div>`).join('')}</div>`;
}

onSnapshot(doc(db, 'system_settings', 'animal_exposure'), snapshot => {
  renderAnimalExposure(snapshot.exists() ? snapshot.data() : {});
}, error => console.error('Failed to load animal exposure data:', error));

onSnapshot(doc(db, 'system_settings', 'dashboard_analytics'), snapshot => {
  const data = snapshot.exists() ? snapshot.data() : {};
  const defaults = { monthlyCases: [12, 18, 15, 22, 19, 24, 17], monthlyVaccinations: [45, 62, 55, 80, 72, 95, 53], caseTrend: [38, 57, 47, 69, 60, 75, 53], ageGroups: [18, 24, 33, 27, 13], barangays: [] };
  const values = { ...defaults, ...data };
  if (window.monthlyChart) {
    window.monthlyChart.data.datasets[0].data = values.monthlyCases;
    window.monthlyChart.data.datasets[1].data = values.monthlyVaccinations;
    window.monthlyChart.update();
  }
  renderList('barangayIncidentRate', values.barangays, item => `<div class="bgy-row"><div class="bgy-row-top"><span class="bgy-name">${escapeHtml(item.name)}</span><span class="bgy-count">${escapeHtml(item.cases)} cases</span></div><div class="bgy-bar-wrap"><div class="bgy-bar-fill fill-high" style="width:${Math.min(100, Number(item.cases) * 3)}%;"></div></div></div>`);
  renderList('caseTrendChart', values.caseTrend, (value, index) => `<div class="trend-bar" style="height:${Math.min(100, Number(value))}%;background:${index === 5 ? '#e60000' : '#d98a00'};" title="${['Jan','Feb','Mar','Apr','May','Jun','Jul'][index]}: ${escapeHtml(value)}"></div>`);
  renderList('ageGroupChart', values.ageGroups, (value, index) => `<div class="age-row"><span class="age-label">${['0–9','10–19','20–39','40–59','60+'][index]}</span><div class="age-bar-wrap"><div class="age-bar-fill" style="width:${Math.min(100, Number(value) * 2)}%;"></div></div><span class="age-count">${escapeHtml(value)}</span></div>`);
}, error => console.error('Failed to load dashboard analytics:', error));

function renderList(id, values, renderItem) {
  const element = document.getElementById(id);
  if (!element || !Array.isArray(values) || !values.length) return;
  element.innerHTML = values.map(renderItem).join('');
}