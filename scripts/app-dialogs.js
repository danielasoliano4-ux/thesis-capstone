const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = new URL('./app-dialogs.css', import.meta.url).href;
document.head.append(stylesheet);

let queue = Promise.resolve();
let sequence = 0;

// Inline icons keep every dialog consistent without relying on an icon font.
const dialogIcons = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7h.01"/>',
  confirm: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  warning: '<path d="m10.3 4.5-8 14A1.7 1.7 0 0 0 3.8 21h16.4a1.7 1.7 0 0 0 1.5-2.5l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  prompt: '<path d="M12 20h9M16 3l5 5M4 16 16 4a2.1 2.1 0 0 1 3 3L7 19l-4 1Z"/>'
};

function showDialog(kind, message, options = {}) {
  const task = queue.then(() => new Promise(resolve => {
    const id = 'app-dialog-' + (++sequence);
    const destructive = kind === 'confirm' && /delete|decline|remove/i.test(message);
    const success = kind === 'alert' && /successfully|saved and|appointment confirmed/i.test(message);
    const error = kind === 'alert' && /error|failed|could not|cannot|invalid/i.test(message);
    const title = options.title || (kind === 'prompt' ? 'Enter details' : destructive ? (/decline/i.test(message) ? 'Decline Confirmation' : 'Delete Confirmation') : kind === 'confirm' ? 'Confirm action' : success ? 'Success' : error ? 'Unable to complete action' : 'Please note');
    const dialog = document.createElement('dialog');
    dialog.className = 'app-dialog' + (destructive || error ? ' app-dialog--danger' : success ? ' app-dialog--success' : '');
    dialog.setAttribute('aria-labelledby', id + '-title');
    dialog.setAttribute('aria-describedby', id + '-message');
    dialog.innerHTML = '<form method="dialog" class="app-dialog__card"><div class="app-dialog__icon" aria-hidden="true"></div><h2 class="app-dialog__title"></h2><p class="app-dialog__message"></p><div class="app-dialog__field" hidden><label></label><input class="app-dialog__input"></div><div class="app-dialog__actions"><button type="button" class="app-dialog__cancel">Cancel</button><button type="submit" class="app-dialog__accept"></button></div></form>';
    const heading = dialog.querySelector('h2');
    heading.id = id + '-title'; heading.textContent = title;
    const description = dialog.querySelector('p');
    description.id = id + '-message'; description.textContent = String(message);
    const iconKind = destructive || error ? 'warning' : success ? 'success' : kind === 'prompt' ? 'prompt' : kind === 'confirm' ? 'confirm' : 'info';
    dialog.querySelector('.app-dialog__icon').innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + dialogIcons[iconKind] + '</svg>';
    const input = dialog.querySelector('input');
    const cancel = dialog.querySelector('.app-dialog__cancel');
    const accept = dialog.querySelector('.app-dialog__accept');
    accept.textContent = options.confirmText || (kind === 'prompt' ? 'Continue' : destructive ? (/decline/i.test(message) ? 'Decline' : 'Delete') : kind === 'confirm' ? 'Confirm' : 'Got it');
    cancel.hidden = kind === 'alert';
    if (kind === 'prompt') {
      dialog.querySelector('.app-dialog__field').hidden = false;
      const label = dialog.querySelector('label');
      label.htmlFor = id + '-input'; label.textContent = options.label || 'Your response';
      input.id = id + '-input'; input.value = options.defaultValue || '';
      input.type = options.inputType || (/password/i.test(message) ? 'password' : /email/i.test(message) ? 'email' : 'text');
      input.autocomplete = input.type === 'password' ? 'new-password' : 'off';
      if (input.type === 'password') input.minLength = 6;
    }
    let result = kind === 'confirm' ? false : kind === 'prompt' ? null : undefined;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.append(dialog);
    document.body.style.overflow = 'hidden';
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      result = kind === 'prompt' ? input.value : kind === 'confirm' ? true : undefined;
      dialog.close();
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove(); document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(result);
    }, { once: true });
    dialog.showModal();
    (kind === 'prompt' ? input : kind === 'confirm' ? cancel : accept).focus();
    if (kind === 'prompt') input.select();
  }));
  queue = task.catch(() => {});
  return task;
}

export function notifyDialog(message, options) { return showDialog('alert', message, options); }
export function confirmDialog(message, options) { return showDialog('confirm', message, options); }
export function promptDialog(message, defaultValue = '', options = {}) { return showDialog('prompt', message, { ...options, defaultValue }); }
