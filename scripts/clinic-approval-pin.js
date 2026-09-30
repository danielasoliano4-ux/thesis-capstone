export function viewClinicPin(clinic) {
  if (!clinic || !Number.isFinite(clinic.lat) || !Number.isFinite(clinic.lng)) {
    alert('No clinic-selected location is available for this record.'); return;
  }
  if (!window.L) { alert('The map could not load. Check your connection and try again.'); return; }
  const dialog = document.createElement('dialog');
  dialog.className = 'clinic-pin-dialog';
  dialog.setAttribute('aria-label', 'Clinic location');
  dialog.innerHTML = '<h2>Clinic location</h2><p class="pin-clinic"></p><div class="clinic-pin-map" aria-label="Clinic location map"></div><p class="pin-status"></p><div class="pin-actions"><button type="button">Close</button></div>';
  dialog.querySelector('.pin-clinic').textContent = [clinic.name, clinic.address].filter(Boolean).join(' - ');
  dialog.querySelector('.pin-status').textContent = clinic.lat.toFixed(6) + ', ' + clinic.lng.toFixed(6);
  document.body.append(dialog); dialog.showModal();
  const map = L.map(dialog.querySelector('.clinic-pin-map')).setView([clinic.lat, clinic.lng], 17);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  L.marker([clinic.lat, clinic.lng], { draggable: false }).addTo(map);
  dialog.querySelector('button').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { map.remove(); dialog.remove(); }, { once: true });
  requestAnimationFrame(() => map.invalidateSize());
}
