importScripts('/firebase-web-config.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

firebase.initializeApp(firebaseConfig);
firebase.messaging();

self.addEventListener('notificationclick', event => {
  if (event.notification.data?.source !== 'foreground') return;
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/residents.html', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => client.url === target);
    return existing ? existing.focus() : self.clients.openWindow(target);
  }));
});
