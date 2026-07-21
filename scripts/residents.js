function getVacStatus() {
  try { return JSON.parse(localStorage.getItem('resident_vaccination_status') || '{}'); }
  catch (e) { return {}; }
}

const vacStatus = getVacStatus();
const hasRecord = vacStatus.hasRecord === true;
const dosesCompleted = vacStatus.dosesCompleted || 1;

function initView() {
  updateDemoBanner();

  if (hasRecord) {
    document.getElementById('view-new').style.display = 'none';
    document.getElementById('view-active').style.display = 'block';
    document.getElementById('nav-records').style.display = 'flex';
    document.getElementById('appt-new-resident').style.display = 'none';
    document.getElementById('appt-active-patient').style.display = 'block';
    document.getElementById('notifDot').style.display = 'block';
    document.getElementById('notifBadge').style.display = 'inline';
    populateActivePatientData(vacStatus);
  } else {
    document.getElementById('view-new').style.display = 'block';
    document.getElementById('view-active').style.display = 'none';
    document.getElementById('nav-records').style.display = 'none';
    document.getElementById('panel-records').style.display = 'none';
    document.getElementById('appt-new-resident').style.display = 'block';
    document.getElementById('appt-active-patient').style.display = 'none';
    setTimeout(renderCasesChart, 150);
  }
}

function updateDemoBanner() {
  const dot = document.getElementById('demoDot');
  const label = document.getElementById('demoStateLabel');
  if (hasRecord) {
    dot.className = 'demo-dot active';
    label.textContent = 'Active Patient State — Vaccination record exists (triggered by clinic staff)';
  } else {
    dot.className = 'demo-dot new';
    label.textContent = 'New Resident State — No vaccination history';
  }
}

function populateActivePatientData(data) {
  const doses = data.dosesCompleted || 1;
  const total = 5;
  const pct = Math.round((doses / total) * 100);
  if (document.getElementById('activeDosesCount')) document.getElementById('activeDosesCount').textContent = doses;
  if (document.getElementById('progressLabel')) document.getElementById('progressLabel').textContent = `Treatment Progress — ${doses} of ${total} doses`;
  if (document.getElementById('progressBar')) document.getElementById('progressBar').style.width = pct + '%';
  if (document.getElementById('progressPct')) document.getElementById('progressPct').textContent = pct + '% Complete';
  if (document.getElementById('recordPct')) document.getElementById('recordPct').textContent = pct + '%';
  if (document.getElementById('recordDoses')) document.getElementById('recordDoses').textContent = `${doses} / ${total} doses`;
  for (let i = 1; i <= 5; i++) {
    const pip = document.getElementById('pip' + i);
    if (!pip) continue;
    if (i <= doses) pip.className = 'dose-pip done';
    else if (i === doses + 1) pip.className = 'dose-pip current';
    else pip.className = 'dose-pip';
  }
  if (data.patientName && document.getElementById('recordName')) document.getElementById('recordName').textContent = data.patientName;
  if (data.startDate && document.getElementById('recordStart')) document.getElementById('recordStart').textContent = data.startDate;
  if (data.vaccine && document.getElementById('recordVaccine')) document.getElementById('recordVaccine').textContent = data.vaccine;
  if (data.biteAnimal && document.getElementById('recordAnimal')) document.getElementById('recordAnimal').textContent = data.biteAnimal;
  if (data.biteSite && document.getElementById('recordBiteSite')) document.getElementById('recordBiteSite').textContent = data.biteSite;
  if (data.category && document.getElementById('recordCategory')) document.getElementById('recordCategory').textContent = data.category;
  if (data.nextDoseDate) {
    if (document.getElementById('activeNextAppt')) document.getElementById('activeNextAppt').textContent = data.nextDoseDate.replace('2026', '').trim().replace(',','').split(' ').slice(0,2).join(' ');
    if (document.getElementById('nextDoseLabel')) document.getElementById('nextDoseLabel').innerHTML = `<i class="fa-regular fa-calendar"></i> Next: Dose ${doses + 1} on ${data.nextDoseDate}`;
  }
}

function renderCasesChart() {
  const ctx = document.getElementById('monthlyChart');
  if (!ctx || !window.Chart) return;
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
      datasets: [
        { label: 'Rabies Cases', data: [12, 18, 15, 22, 19, 24, 17], backgroundColor: 'rgba(239,0,0,0.75)', borderRadius: 4, borderSkipped: false },
        { label: 'Vaccinations', data: [45, 62, 55, 80, 72, 95, 53], backgroundColor: 'rgba(52,211,153,0.75)', borderRadius: 4, borderSkipped: false }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'top', labels: { font: { size: 11 }, padding: 10 } } },
      scales: {
        y: { beginAtZero: true, grid: { color: '#f3f4f6' }, ticks: { font: { size: 11 } } },
        x: { grid: { display: false }, ticks: { font: { size: 11 } } }
      }
    }
  });
}

function renderResVizChart() {
  const ctx = document.getElementById('resVizChart');
  if (!ctx || !window.Chart) return;
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul'],
      datasets: [
        { label:'Rabies Cases', data:[12,18,15,22,19,24,17], backgroundColor:'rgba(239,0,0,0.75)', borderRadius:4 },
        { label:'Vaccinations', data:[45,62,55,80,72,95,53], backgroundColor:'rgba(52,211,153,0.75)', borderRadius:4 }
      ]
    },
    options: {
      responsive:true,
      plugins:{ legend:{ position:'top', labels:{ font:{size:11}, padding:10 } } },
      scales:{
        y:{ beginAtZero:true, grid:{color:'#f3f4f6'}, ticks:{font:{size:11}} },
        x:{ grid:{display:false}, ticks:{font:{size:11}} }
      }
    }
  });
}

function showTab(tab, el) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const panel = document.getElementById('panel-' + tab);
  if (panel) panel.classList.add('active');
  if (el) el.classList.add('active');
}

function openBookingModal(clinic) {
  const sel = document.getElementById('modalClinic');
  if (clinic && sel) {
    for (let o of sel.options) {
      if (o.text.startsWith(clinic)) { sel.value = o.value; break; }
    }
  }
  document.getElementById('bookingModal').classList.add('open');
}
function closeBookingModal() {
  document.getElementById('bookingModal').classList.remove('open');
}
function confirmBooking() {
  closeBookingModal();
  alert('Appointment booked successfully! (Demo mode)\n\nYou will receive a confirmation notification once the clinic confirms your schedule.');
}

function filterMap(btn) {
  document.querySelectorAll('.map-filter button').forEach(b => b.classList.remove('active-btn'));
  btn.classList.add('active-btn');
}

function handleUpload(input) {
  if (input.files.length) alert('File "' + input.files[0].name + '" selected for upload. (Demo mode)');
}
function resetDemoState() {
  localStorage.removeItem('resident_vaccination_status');
  location.reload();
}

function toggleResRow(row) {
  const next = row.nextElementSibling;
  const icon = row.querySelector('.fa-chevron-down, .fa-chevron-up');
  const isOpen = next.style.display === 'table-row';
  document.querySelectorAll('.res-accordion-detail').forEach(d => d.style.display = 'none');
  document.querySelectorAll('.res-accordion-row i.fa-chevron-up').forEach(i => {
    i.className = i.className.replace('fa-chevron-up','fa-chevron-down');
  });
  if (!isOpen) {
    next.style.display = 'table-row';
    if (icon) icon.className = icon.className.replace('fa-chevron-down','fa-chevron-up');
  }
}

let resCurrentFilter = 'all';
function resSetFilter(filter, btn) {
  resCurrentFilter = filter;
  document.querySelectorAll('.res-filter-btn').forEach(b => b.classList.remove('active-filter'));
  btn.classList.add('active-filter');
  resApplyFilter();
}
function resFilterRecords(q) { resApplyFilter(q.toLowerCase().trim()); }
function resApplyFilter(q = '') {
  const rows = document.querySelectorAll('#resTbody .res-accordion-row');
  let shown = 0;
  rows.forEach(row => {
    const outcome = row.dataset.outcome || '';
    const text = row.textContent.toLowerCase();
    const matchFilter = resCurrentFilter === 'all' || outcome === resCurrentFilter;
    const matchSearch = !q || text.includes(q);
    const show = matchFilter && matchSearch;
    row.style.display = show ? '' : 'none';
    const detail = row.nextElementSibling;
    if (detail && detail.classList.contains('res-accordion-detail')) {
      if (!show) detail.style.display = 'none';
    }
    if (show) shown++;
  });
  document.getElementById('resRecordsCount').textContent = 'Showing ' + shown + ' of 5 records';
}

document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('bookingModal').addEventListener('click', function(e) {
    if (e.target === this) closeBookingModal();
  });

  window.addEventListener('storage', function(e) {
    if (e.key === 'resident_vaccination_status') location.reload();
  });

  initView();
  if (location.hash === '#panel-appointments') {
    const apptTab = document.querySelectorAll('.nav-tab')[1];
    if (apptTab) showTab('appointments', apptTab);
  }
  renderCasesChart();
  setTimeout(renderResVizChart, 300);
});