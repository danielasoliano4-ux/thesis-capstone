function setPublicUI() {
  const headerName = document.getElementById('headerName');
  if (headerName) headerName.textContent = 'Guest';

  const previewName = document.getElementById('faUserName');
  const modalName = document.getElementById('faModalUserName');
  if (previewName) previewName.textContent = 'Guest';
  if (modalName) modalName.textContent = 'Guest';

  const btns = document.getElementById('faModalButtons');
  if (btns) btns.innerHTML = '';
  document.body.classList.remove('logged-in');
}

function initModalHandlers() {
  const previewBtn = document.getElementById('faOpenBtn');
  const modal = document.getElementById('firstAidModal');
  const close = modal ? modal.querySelector('.modal-close') : null;

  if (previewBtn && modal) {
    previewBtn.addEventListener('click', () => modal.classList.add('open'));
  }

  if (close && modal) {
    close.addEventListener('click', () => modal.classList.remove('open'));
  }

  if (modal) {
    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) modal.classList.remove('open');
    });
  }
}

setPublicUI();
initModalHandlers();

export { setPublicUI, initModalHandlers };
