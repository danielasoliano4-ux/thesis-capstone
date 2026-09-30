import { routes } from './routes.js';
import { createLoginController } from './login-security.js';
const button = document.getElementById('loginBtn');
function showMessage(message) {
  document.getElementById('loginMessageText').textContent = message;
  document.getElementById('loginMessage').hidden = false;
}
const controller = createLoginController(button, showMessage, () => 'admin');
document.getElementById('passwordToggle').addEventListener('click', () => {
  const input = document.getElementById('passwordInput');
  input.type = input.type === 'password' ? 'text' : 'password';
  document.querySelector('#passwordToggle i').className = input.type === 'password' ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash';
});
document.getElementById('adminLoginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const email = document.getElementById('emailInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  if (!email || !password) return showMessage('Please enter your email and password.');
  if (await controller.attempt(email, password)) window.location.replace(routes.adminDashboard);
});
