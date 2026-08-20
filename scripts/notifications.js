import { auth, fetchNotificationsFor, onAuthStateChanged, fetchUserProfile, signOutUser } from './firebase.js';

function markAllRead() {

    document.querySelectorAll('.notif-item.unread').forEach(item => {

        item.classList.remove('unread');

        const dot = item.querySelector('.unread-dot');

        if (dot) dot.remove();

    });

    const unread = document.getElementById('unreadCount');

    if (unread) unread.textContent = '0';

}

function filterNotifs(type, btn) {

    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));

    if (btn) btn.classList.add('active');

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

    const emptyState = document.getElementById('emptyState');
    if (emptyState) {
        emptyState.style.display = visible === 0 ? 'block' : 'none';
    }

    document.querySelectorAll('.notif-group-label').forEach(g => {

        g.style.display = type === 'all' ? 'block' : 'none';

    });

}

function bindNotificationControls() {
    const markAllBtn = document.getElementById('markAllReadBtn');
    if (markAllBtn) {
        markAllBtn.addEventListener('click', markAllRead);
    }

    document.querySelectorAll('.filter-tab').forEach(button => {
        button.addEventListener('click', () => {
            filterNotifs(button.dataset.filter || 'all', button);
        });
    });
}

bindNotificationControls();
window.markAllRead = markAllRead;
window.filterNotifs = filterNotifs;



// Render notifications into the DOM

function renderNotifications(list) {

    const container = document.getElementById('notificationsList');

    const empty = document.getElementById('emptyState');

    if (!container) return;

    container.innerHTML = '';

    if (!list || list.length === 0) {

        if (empty) empty.style.display = 'block';

        return;

    }

    if (empty) empty.style.display = 'none';

    list.forEach(n => {

        const item = document.createElement('div');

        item.className = 'notif-item' + (n.read ? '' : ' unread');

        item.dataset.type = n.type || 'general';

        item.innerHTML = `

            <div style="flex:1">

                <div style="font-weight:700">${n.title || 'Notification'}</div>

                <div style="font-size:13px;color:#6b7280">${n.body || ''}</div>

            </div>

            ${n.read ? '' : '<div class="unread-dot" style="width:10px;height:10px;background:#e60000;border-radius:50%;margin-left:12px;"></div>'}

        `;

        container.appendChild(item);

    });

}



// Listen for auth state and load user-specific notifications

onAuthStateChanged(auth, async (user) => {

    if (user) {

        const list = await fetchNotificationsFor(user.uid);

        renderNotifications(list);

        const unreadCount = list.filter(n => !n.read).length;

        const unreadEl = document.getElementById('unreadCount');

        if (unreadEl) unreadEl.textContent = String(unreadCount);

                // Set header name if present

                const headerName = document.getElementById('headerName');

                const signOutBtn = document.getElementById('signOutBtn');

                try {

                    const profile = await fetchUserProfile(user.uid);

                    const name = (profile && (profile.full_name || profile.fullName || profile.name)) || user.displayName || user.email || 'Resident';

                    if (headerName) headerName.textContent = name;

                    if (signOutBtn) { signOutBtn.style.display = 'inline-block'; signOutBtn.addEventListener('click', async () => { await signOutUser(); window.location.href = 'index.html'; }); }

                } catch (err) {

                    console.warn('Could not load profile for header', err);

                }

    } else {

        // Public view: show empty state or placeholder

        renderNotifications([]);

    }

});