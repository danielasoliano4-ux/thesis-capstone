(() => {
  const frame = document.getElementById('appFrame');
  // The shell starts on the guest side once. Child pages own authentication and
  // navigation; reacting to Firebase here would interrupt the login redirect.
  const guestPages = ['index', 'login', 'register', 'forgot-password', 'first-aid', 'notifications'];
  const isGuestPage = url => url.origin === location.origin
    && guestPages.includes(url.pathname.slice(1).replace(/\.html$/, ''));
  let initialPage = 'index.html';
  try {
    const saved = sessionStorage.getItem('appPage');
    if (saved && isGuestPage(new URL(saved, location.href))) initialPage = saved;
  } catch { /* Start at the locator if saved routing is unavailable. */ }
  frame.src = initialPage;
  frame.addEventListener('load', () => {
    try {
      const url = new URL(frame.contentWindow.location.href);
      if (isGuestPage(url)) sessionStorage.setItem('appPage', url.pathname.slice(1) + url.search + url.hash);
      else sessionStorage.removeItem('appPage');
    } catch { /* The child page handles its own session. */ }
  });
})();
