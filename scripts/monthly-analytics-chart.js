const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let monthlyCases = Array(12).fill(0);
let monthlyVaccinations = Array(12).fill(0);

function monthCounts(values) {
  return months.map((_, index) => Math.max(0, Number(values?.[index]) || 0));
}

export function initializeMonthlyChart() {
  const canvas = document.getElementById('monthlyChart');
  if (!canvas) return;
  const status = document.getElementById('monthlyChartStatus');
  if (!window.Chart) {
    if (status) {
      status.textContent = 'The monthly chart could not load. Refresh the page to try again.';
      status.hidden = false;
      canvas.hidden = true;
    }
    return;
  }
  canvas.hidden = false;
  if (status) status.hidden = true;

  // Both dashboards and their live listeners share one chart per canvas.
  const existing = window.Chart.getChart(canvas);
  if (existing) {
    window.publicMonthlyChart = existing;
    existing.resize();
    return existing;
  }
  window.publicMonthlyChart = new window.Chart(canvas, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [
        { label: 'Rabies Cases', data: monthlyCases, backgroundColor: 'rgba(239,0,0,0.75)', borderRadius: 4, borderSkipped: false },
        { label: 'Vaccinations', data: monthlyVaccinations, backgroundColor: 'rgba(52,211,153,0.75)', borderRadius: 4, borderSkipped: false }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: !canvas.parentElement.classList.contains('monthly-chart-container'),
      plugins: {
        legend: { position: 'top', labels: { font: { size: 11 }, padding: 10 } },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: '#f3f4f6' }, ticks: { precision: 0, font: { size: 11 } } },
        x: { grid: { display: false }, ticks: { font: { size: 11 } } }
      }
    }
  });
  return window.publicMonthlyChart;
}

export function updateMonthlyChart(data = {}) {
  // Keep the latest snapshot even if the chart library is still unavailable.
  monthlyCases = monthCounts(data.monthlyCases);
  monthlyVaccinations = monthCounts(data.monthlyVaccinations);
  const chart = initializeMonthlyChart();
  if (!chart) return;
  chart.data.datasets[0].data = monthlyCases;
  chart.data.datasets[1].data = monthlyVaccinations;
  chart.update();
}
