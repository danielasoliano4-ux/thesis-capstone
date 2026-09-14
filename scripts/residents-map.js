import { db } from './firebase.js';
import { collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

let CLINICS = [];

const STATUS_COLOR = { available: '#00b140', low: '#d98a00', out: '#e60000' };
const STATUS_LABEL = { available: 'Available', low: 'Low Stock', out: 'Out of Stock' };

const mapsData = [];
let selectedDestination = null;

function initMap() {
  const containers = [
    { mapId: 'googleMapOverview', sidebarId: 'clinicSidebarOverview' },
    { mapId: 'googleMap',         sidebarId: 'clinicSidebar'         },
    { mapId: 'googleMapNew',      sidebarId: 'clinicSidebarNew'      }
  ];
  if (!CLINICS.length) return;
  containers.forEach(c => {
    if (document.getElementById(c.mapId)) createMap(c.mapId, c.sidebarId);
  });
}

function loadClinics() {
  onSnapshot(collection(db, 'clinics'), (snapshot) => {
    CLINICS = snapshot.docs.map(clinicDoc => {
      const data = clinicDoc.data();
      return {
        id: clinicDoc.id,
        name: data.name || 'Unnamed Clinic',
        type: normalizeClinicType(data.type || data.clinic_type || data.facility_type, data.name),
        ...getCoordinates(data),
        status: normalizeStatus(data.stock_status || data.status, data.stock_total),
        address: data.address || '',
        hours: data.weekdayHours || data.hours || 'Contact clinic',
        phone: data.contact || '',
        priceRange: data.priceRange || data.vaccination_price_range || 'Price not provided',
        stock: data.stock_summary || data.stock || `${Number(data.stock_total || 0)} doses`,
        stock_total: Number(data.stock_total || 0),
        staff_uid: data.staff_uid || ''
      };
    });

    window.clinicDirectory = CLINICS;
    if (window.updateNearestClinicSummary) window.updateNearestClinicSummary(CLINICS);
    if (window.populateClinicOptions) window.populateClinicOptions(CLINICS);
    mapsData.splice(0).forEach(entry => entry.markers.forEach(marker => marker.marker.remove()));
    mapsData.splice(0);
    if (window.L) initMap();
  }, (error) => console.error('Failed to load clinics:', error));
}

function createMap(mapId, sidebarId) {
  const CABUYAO_CENTER = { lat: 14.2718, lng: 121.1246 };
  const map = L.map(mapId, { zoomControl: false }).setView([CABUYAO_CENTER.lat, CABUYAO_CENTER.lng], 14);
  L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    attribution: '&copy; Google Maps', maxZoom: 20
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);

  const entry = { mapId, sidebarId, map, markers: [] };
  entry.center = CABUYAO_CENTER;
  CLINICS.filter(clinic => Number.isFinite(clinic.lat) && Number.isFinite(clinic.lng)).forEach(clinic => {
    entry.markers.push(createMarkerForMap(map, clinic, mapId));
  });
  addLocationControl(entry);
  mapsData.push(entry);
  buildSidebarFor(entry);
  if (!entry.markers.length) {
    const message = document.createElement('div');
    message.className = 'map-empty-message';
    message.textContent = 'No clinic locations available yet. Add numeric lat/lng fields or a location such as [14.2312° N, 121.1345° E].';
    document.getElementById(mapId).appendChild(message);
  }
}

function normalizeStatus(status, total) {
  if (STATUS_COLOR[status]) return status;
  const stock = Number(total || 0);
  return stock === 0 ? 'out' : stock <= 15 ? 'low' : 'available';
}

function normalizeClinicType(type, name = '') {
  const value = String(type || '').toLowerCase();
  if (value.includes('private')) return 'Private';
  if (value.includes('public') || value.includes('government') || value.includes('treatment center')) return 'Public';
  if (value.includes('animal bite center')) return 'Private';
  const clinicName = String(name).toLowerCase();
  if (clinicName.includes('animal bite treatment center')) return 'Public';
  if (clinicName.includes('animal bite center')) return 'Private';
  return 'Clinic type not specified';
}

function getCoordinates(data) {
  if (Number.isFinite(Number(data.lat)) && Number.isFinite(Number(data.lng))) {
    return { lat: Number(data.lat), lng: Number(data.lng) };
  }

  if (data.location && Number.isFinite(Number(data.location.latitude)) && Number.isFinite(Number(data.location.longitude))) {
    return { lat: Number(data.location.latitude), lng: Number(data.location.longitude) };
  }

  if (typeof data.location === 'string') {
    const matches = data.location.match(/-?\d+(?:\.\d+)?/g);
    if (matches) return { lat: Number(matches[1]), lng: Number(matches[2]) };
  }

  if (Array.isArray(data.location) && data.location.length >= 2) {
    const lat = Number(data.location[0]);
    const lng = Number(data.location[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }

  return { lat: NaN, lng: NaN };
}

function createMarkerForMap(map, clinic, mapId) {
  const color = STATUS_COLOR[clinic.status] || STATUS_COLOR.out;
  const icon = L.divIcon({ className: 'clinic-map-marker', html: `<span class="clinic-pin" style="--marker-color:${color}"><i class="fa-solid fa-hospital"></i></span>`, iconSize: [30, 38], iconAnchor: [15, 36] });
  const marker = L.marker([clinic.lat, clinic.lng], { icon, title: clinic.name }).addTo(map);
  const bookingButton = clinic.status === 'out'
    ? ''
    : `<button type="button" class="map-book-button" data-clinic-id="${escapeHtml(clinic.id)}">Book Appointment</button>`;
  const directionsButton = '<button type="button" class="map-directions-button">Get Directions</button>';
  marker.bindPopup(`<strong>${escapeHtml(clinic.name)}</strong><br><b>${escapeHtml(clinic.type)}</b><br><b style="color:${color}">${STATUS_LABEL[clinic.status]}</b><br><br><b>Address:</b> ${escapeHtml(clinic.address)}<br><b>Hours:</b> ${escapeHtml(clinic.hours)}<br><b>Phone:</b> ${escapeHtml(clinic.phone)}<br><b>Vaccination price:</b> ${escapeHtml(clinic.priceRange)}<br><br><b>Stock:</b> ${escapeHtml(clinic.stock)}${bookingButton}${directionsButton}<div class="route-summary" aria-live="polite"></div><br><small>&copy; Google Maps</small>`);
  marker.on('popupopen', event => {
    const button = event.popup.getElement()?.querySelector('.map-book-button');
    if (button) button.addEventListener('click', () => {
      if (mapId === 'googleMap') {
        // Public map - check authentication first
        if (window.checkAuthAndBook) window.checkAuthAndBook(clinic.name, clinic.id);
      } else {
        // Residents or other authenticated pages - open booking modal directly
        if (window.openBookingModal) window.openBookingModal(clinic.name, clinic.id);
      }
    });
    const routeButton = event.popup.getElement()?.querySelector('.map-directions-button');
    if (routeButton) routeButton.addEventListener('click', () => {
      selectedDestination = clinic;
      locateUser();
      if (userLocation) updateRoutes();
    });
  });
  return { marker, clinic };
}

function buildSidebarFor(entry) {
  const sidebar = document.getElementById(entry.sidebarId);
  if (!sidebar) return;
  sidebar.innerHTML = '';
  entry.markers.forEach((mobj, index) => {
    const color = STATUS_COLOR[mobj.clinic.status] || STATUS_COLOR.out;
    const row = document.createElement('div');
    row.id = `${entry.sidebarId}-row-${index}`;
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;background:white;border:1px solid #ddd;border-radius:12px;padding:12px 16px;cursor:pointer;transition:border-color 0.2s;gap:12px;';

    const leftHtml = `
      <div style="display:flex;flex-direction:column;gap:4px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:13px;font-weight:bold;color:#111827;">${mobj.clinic.name}</span>
          <span style="font-size:11px;color:#6b7280;">(${mobj.clinic.type})</span>
        </div>
        <div style="font-size:12px;color:#6b7280;">${mobj.clinic.address} &nbsp;|&nbsp; ${mobj.clinic.hours}</div>
        <div style="font-size:12px;color:#374151;"><strong>Vaccination price:</strong> ${mobj.clinic.priceRange}</div>
      </div>
    `;

    const doseLabel = `${mobj.clinic.stock_total} doses available`;
    const rightHtml = mobj.clinic.status === 'out'
      ? `<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:12px;color:${color};font-weight:bold;">Out of Stock</span><button class="book-btn" disabled style="background:#d1d5db;border:none;color:#6b7280;cursor:not-allowed;">Out of Stock</button></div>`
      : entry.sidebarId === 'clinicSidebar'
        ? `<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:12px;color:${color};font-weight:bold;text-align:right;">${STATUS_LABEL[mobj.clinic.status]}<br><span style="color:#6b7280;font-weight:normal;">${doseLabel}</span></span><button class="book-btn" onclick="checkAuthAndBook('${mobj.clinic.name.replace(/'/g, "\\'")}', '${mobj.clinic.id}')">Book</button></div>`
        : `<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:12px;color:${color};font-weight:bold;text-align:right;">${STATUS_LABEL[mobj.clinic.status]}<br><span style="color:#6b7280;font-weight:normal;">${doseLabel}</span></span><button class="book-btn" onclick="openBookingModal('${mobj.clinic.name.replace(/'/g, "\\'")}', '${mobj.clinic.id}')">Book</button></div>`;

    row.innerHTML = `<div style="display:flex;align-items:center;gap:12px;flex:1;">${leftHtml}</div><div style="display:flex;align-items:center;gap:12px;">${rightHtml}</div>`;

    row.addEventListener('click', (e) => {
      if (e.target && (e.target.tagName === 'BUTTON' || e.target.closest('button'))) return;
      entry.map.setView(mobj.marker.getLatLng(), 16);
      mobj.marker.openPopup();
      document.querySelectorAll(`#${entry.sidebarId} > div`).forEach(r => { r.style.borderColor = '#ddd'; r.style.background = 'white'; });
      row.style.borderColor = color;
      row.style.background = color === '#00b140' ? '#eefcf3' : color === '#d98a00' ? '#fffbe9' : '#fff1f1';
    });

    sidebar.appendChild(row);
  });
}

function filterMarkers(filter, btn) {
  document.querySelectorAll('.map-filter button').forEach(b => { b.classList.remove('active-btn'); b.style.fontWeight = ''; });
  if (btn) btn.classList.add('active-btn');
  mapsData.forEach(entry => {
    entry.markers.forEach((mobj, i) => {
      const show = filter === 'all' || mobj.clinic.status === filter;
      if (show) mobj.marker.addTo(entry.map);
      else mobj.marker.remove();
      const row = document.getElementById(`${entry.sidebarId}-row-${i}`);
      if (row) row.style.display = show ? 'flex' : 'none';
    });
  });
}

// Call this if a map's container was hidden during initialization
function refreshMaps() {
  if (!window.L) return;
  mapsData.forEach(entry => {
    setTimeout(() => entry.map.invalidateSize(), 0);
  });
}

function addLocationControl(entry) {
  const control = L.control({ position: 'bottomright' });
  control.onAdd = () => {
    const button = L.DomUtil.create('button', 'location-control');
    button.type = 'button';
    button.title = 'Use my current location';
    button.setAttribute('aria-label', 'Use my current location');
    button.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i>';
    L.DomEvent.on(button, 'click', locateUser);
    return button;
  };
  control.addTo(entry.map);
}

let userLocation = null;
let locationWatchId = null;
function locateUser() {
  if (!navigator.geolocation) return alert('Location is not supported by this browser.');
  const updateLocation = position => {
    userLocation = [position.coords.latitude, position.coords.longitude];
    mapsData.forEach(entry => {
      if (!entry.userMarker) entry.userMarker = L.circleMarker(userLocation, { radius: 8, color: '#fff', weight: 3, fillColor: '#2878e8', fillOpacity: 1 }).addTo(entry.map);
      else entry.userMarker.setLatLng(userLocation);
      if (!selectedDestination) entry.map.setView(userLocation, 16);
    });
    if (selectedDestination) updateRoutes();
  };
  if (locationWatchId !== null) return;
  locationWatchId = navigator.geolocation.watchPosition(updateLocation, () => {
    alert('Please allow location access to show your current position.');
    locationWatchId = null;
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
}

function focusNearestClinic() {
  if (window.showTab) window.showTab('overview', document.querySelectorAll('.nav-tab')[0]);
  const fallback = { latitude: 14.2718, longitude: 121.1246 };
  const showNearest = position => {
    const origin = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    CLINICS.filter(clinic => Number.isFinite(clinic.lat) && Number.isFinite(clinic.lng)).forEach(clinic => {
      const distance = mapDistanceInKm(origin.latitude, origin.longitude, clinic.lat, clinic.lng);
      if (distance < nearestDistance) {
        nearest = clinic;
        nearestDistance = distance;
      }
    });
    if (!nearest) return;
    selectedDestination = nearest;
    mapsData.forEach(entry => {
      const markerEntry = entry.markers.find(item => item.clinic.id === nearest.id);
      if (markerEntry) {
        entry.map.setView(markerEntry.marker.getLatLng(), 16);
        markerEntry.marker.openPopup();
      }
    });
  };
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(showNearest, () => showNearest({ coords: fallback }), { enableHighAccuracy: true, timeout: 8000, maximumAge: 300000 });
  } else {
    showNearest({ coords: fallback });
  }
}

function mapDistanceInKm(latitude, longitude, clinicLatitude, clinicLongitude) {
  const earthRadius = 6371;
  const latDelta = (clinicLatitude - latitude) * Math.PI / 180;
  const lngDelta = (clinicLongitude - longitude) * Math.PI / 180;
  const value = Math.sin(latDelta / 2) ** 2 + Math.cos(latitude * Math.PI / 180) * Math.cos(clinicLatitude * Math.PI / 180) * Math.sin(lngDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

async function updateRoutes() {
  if (!userLocation || !selectedDestination) return;
  const destination = [selectedDestination.lng, selectedDestination.lat];
  const origin = [userLocation[1], userLocation[0]];
  const url = `https://router.project-osrm.org/route/v1/driving/${origin.join(',')};${destination.join(',')}?overview=full&geometries=geojson`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Route request failed');
    const data = await response.json();
    const route = data.routes?.[0];
    if (!route) throw new Error('No route found');
    mapsData.forEach(entry => {
      if (entry.routeLayer) entry.routeLayer.remove();
      entry.routeLayer = L.geoJSON(route.geometry, { style: { color: '#2878e8', weight: 5, opacity: .85 } }).addTo(entry.map);
      entry.map.fitBounds(entry.routeLayer.getBounds(), { padding: [30, 30] });
      const popup = entry.map.getPopup();
      const summary = popup?.getElement()?.querySelector('.route-summary');
      if (summary) summary.textContent = `Route: ${(route.distance / 1000).toFixed(1)} km, about ${Math.ceil(route.duration / 60)} min`;
    });
  } catch (error) {
    console.error('Failed to load route:', error);
  }
}

function escapeHtml(value = '') {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}

window.refreshMaps = refreshMaps;
window.initMap = initMap;
window.filterMarkers = filterMarkers;
window.focusNearestClinic = focusNearestClinic;
loadClinics();