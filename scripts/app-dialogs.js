const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = new URL('./app-dialogs.css', import.meta.url).href;
document.head.append(stylesheet);

let queue = Promise.resolve();
let sequence = 0;

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
    dialog.querySelector('.app-dialog__icon').textContent = destructive || error ? '!' : success ? '?' : kind === 'prompt' ? '?' : 'i';
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
