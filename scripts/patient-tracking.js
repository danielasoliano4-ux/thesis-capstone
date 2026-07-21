document.getElementById('todayDate').textContent =
    new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

const appointmentData = {
    1: {
        hasRecord: true, dosesCompleted: 1,
        patientName: 'John Cruz',
        startDate: new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }),
        vaccine: 'Verorab', clinic: 'Cabuyao City Health Center',
        nextDoseDate: (() => { const d = new Date(); d.setDate(d.getDate() + 3); return d.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) + ' at 9:00 AM'; })(),
        category: 'III', biteAnimal: 'Dog', biteSite: 'Left hand'
    },
    2: {
        hasRecord: true, dosesCompleted: 3,
        patientName: 'Maria Santos', startDate: 'June 26, 2026',
        vaccine: 'Rabipur', clinic: 'Cabuyao City Health Center',
        nextDoseDate: (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) + ' at 10:30 AM'; })(),
        category: 'II', biteAnimal: 'Cat', biteSite: 'Right forearm'
    }
};

let pendingCount = 2;

function markAdministered(id) {
    const btn    = document.getElementById('markBtn' + id);
    const badge  = document.getElementById('badge' + id);
    const card   = document.getElementById('apptCard' + id);
    const avatar = document.getElementById('apptAvatar' + id);

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating…';

    setTimeout(() => {
        localStorage.setItem('resident_vaccination_status', JSON.stringify(appointmentData[id]));

        badge.textContent = 'Completed';
        badge.className = 'status-badge completed';
        card.classList.add('completed-card');
        avatar.style.background = '#f0fdf4';
        avatar.style.color = '#22c55e';

        btn.classList.add('done');
        btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Administered';

        pendingCount = Math.max(0, pendingCount - 1);
        document.getElementById('pendingCount').textContent = pendingCount;
        if (pendingCount === 0) document.getElementById('pendingCount').style.background = '#22c55e';

        showToast();
    }, 800);
}

function showToast() {
    const toast = document.getElementById('toast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4000);
}