function showTab(tab, el) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('panel-' + tab).classList.add('active');
    if (el) el.classList.add('active');
}
function approveUser(btn) {
    const card = btn.closest('.user-card');
    card.style.opacity = '0.5';
    btn.textContent = 'Approved ✓';
    btn.style.background = '#16a34a';
    btn.disabled = true;
}
const monthCtx = document.getElementById('monthlyChart').getContext('2d');
new Chart(monthCtx, {
    type: 'bar',
    data: {
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
        datasets: [
            {
                label: 'Rabies Cases',
                data: [12, 18, 15, 22, 19, 24, 17],
                backgroundColor: 'rgba(239,0,0,0.7)',
                borderRadius: 4,
                borderSkipped: false,
            },
            {
                label: 'Vaccinations',
                data: [45, 62, 55, 80, 72, 95, 53],
                backgroundColor: 'rgba(37,99,235,0.65)',
                borderRadius: 4,
                borderSkipped: false,
            }
        ]
    },
    options: {
        responsive: true,
        plugins: { legend: { position: 'top', labels: { font: { size: 12 } } } },
        scales: {
            y: { beginAtZero: true, grid: { color: '#f3f4f6' }, ticks: { font: { size: 11 } } },
            x: { grid: { display: false }, ticks: { font: { size: 11 } } }
        }
    }
});
const stockCtx = document.getElementById('stockChart').getContext('2d');
new Chart(stockCtx, {
    type: 'doughnut',
    data: {
        labels: ['Verorab', 'Rabipur', 'Speeda', 'Out of Stock'],
        datasets: [{
            data: [45, 30, 12, 0],
            backgroundColor: ['#2563eb', '#16a34a', '#f59e0b', '#ef4444'],
            borderWidth: 2,
            borderColor: '#fff',
            hoverOffset: 6
        }]
    },
    options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 12 }, padding: 12 } } },
        cutout: '60%'
    }
});