const isLocalDevelopment = ['127.0.0.1', 'localhost'].includes(window.location.hostname);

const routes = {
  adminDashboard: isLocalDevelopment ? 'admin.html' : '/admin',
  adminLogin: isLocalDevelopment ? 'admin-login.html' : '/admin/login'
};

export { routes };
