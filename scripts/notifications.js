import { auth, db, onAuthStateChanged, fetchUserProfile, signOutUser } from './firebase.js';
import { collection, onSnapshot, query, where, doc, updateDoc } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

function markAllRead() {

    document.querySelectorAll('.notif-item.unread').forEach(item => {

        item.classList.remove('unread');

        const dot = item.querySelector('.unread-dot');

        if (dot) dot.remove();

    });

    const unread = document.getElementById('unreadCount');

    if (unread) unread.textContent = '0';

    document.querySelectorAll('.notif-item[data-id]').forEach(item => {
        updateDoc(doc(db, 'notifications', item.dataset.id), { read: true })
            .catch(error => console.warn('Could not mark notification as read:', error));
    });

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

        item.dataset.id = n.id;

        item.dataset.type = n.type || 'general';

        const icon = n.title?.toLowerCase().includes('reminder') ? 'fa-calendar-check' : n.type === 'vaccine' ? 'fa-syringe' : 'fa-circle-check';
        const createdAt = n.created_at?.toDate ? n.created_at.toDate().toLocaleString() : 'Just now';

        item.innerHTML = `

            <div class="notif-icon icon-blue"><i class="fa-solid ${icon}"></i></div>
            <div class="notif-body">
                <h4>${escapeHtml(n.title || 'Notification')}</h4>
                <p>${escapeHtml(n.message || n.body || '')}</p>
                <div class="notif-meta"><span class="notif-time"><i class="fa-regular fa-clock"></i> ${escapeHtml(createdAt)}</span><span class="notif-tag tag-${escapeHtml(n.type || 'system')}">${escapeHtml(n.type || 'system')}</span></div>
            </div>

            ${n.read ? '' : '<div class="unread-dot" style="width:10px;height:10px;background:#e60000;border-radius:50%;margin-left:12px;"></div>'}

        `;

        container.appendChild(item);

    });

}

function escapeHtml(value = '') {
    const element = document.createElement('div');
    element.textContent = value;
    return element.innerHTML;
}



// Listen for auth state and load user-specific notifications

onAuthStateChanged(auth, async (user) => {

    if (user) {

        onSnapshot(query(collection(db, 'notifications'), where('recipient_uid', '==', user.uid)), snapshot => {
            const list = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
                .sort((first, second) => {
                    const firstTime = first.created_at?.toMillis?.() || 0;
                    const secondTime = second.created_at?.toMillis?.() || 0;
                    return secondTime - firstTime;
                });
            renderNotifications(list);
            const unreadEl = document.getElementById('unreadCount');
            if (unreadEl) unreadEl.textContent = String(list.filter(n => !n.read).length);
        }, error => {
            console.error('Could not listen for notifications:', error);
            renderNotifications([]);
        });

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