// Keep the dashboard shell usable while remote modules and data are loading.
function showTab(tab, el) {
  const panel = document.getElementById('panel-' + tab);
  if (!panel) return;
  document.querySelectorAll('.tab-panel').forEach(item => item.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(item => item.classList.remove('active'));
  panel.classList.add('active');
  if (el) el.classList.add('active');
  if (tab === 'overview') {
    if (window.refreshMaps) setTimeout(() => window.refreshMaps(), 150);
    window.renderResidentCasesChart?.();
  }
  if (tab === 'appointments') {
    const newView = document.getElementById('appt-new-resident');
    const activeView = document.getElementById('appt-active-patient');
    if (newView && activeView
        && window.getComputedStyle(newView).display === 'none'
        && window.getComputedStyle(activeView).display === 'none') {
      newView.style.display = 'block';
    }
  }
}
window.showTab = showTab;
