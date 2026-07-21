function markAllRead() {
    document.querySelectorAll('.notif-item.unread').forEach(item => {
        item.classList.remove('unread');
        const dot = item.querySelector('.unread-dot');
        if (dot) dot.remove();
    });
    document.getElementById('unreadCount').textContent = '0';
}

function filterNotifs(type, btn) {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');

    const items = document.querySelectorAll('.notif-item');
    let visible = 0;
    items.forEach(item => {
        if (type === 'all' || item.dataset.type === type) {
            item.style.display = 'flex';
            visible++;
        } else {
            item.style.display = 'none';
        }
    });

    document.getElementById('emptyState').style.display = visible === 0 ? 'block' : 'none';

    document.querySelectorAll('.notif-group-label').forEach(g => {
        g.style.display = type === 'all' ? 'block' : 'none';
    });
}
