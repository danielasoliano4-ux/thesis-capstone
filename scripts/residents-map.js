import { simplifyStockText, clinicStockStatus } from './stock-summary.mjs';
import { auth, db, onAuthStateChanged, fetchUserProfile } from './firebase.js';
import { clinicBooking } from './booking-status.js';
import { collection, onSnapshot, query, where } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

let bookingRows = [];
let bookingState = 'loading';
let bookingUnsubscribe;
const bookingWidgets = new Set();
function refreshBookingWidgets() {
  for (const widget of bookingWidgets) {
    if (!widget.host.isConnected) bookingWidgets.delete(widget);
    else widget.render();
  }
}
onAuthStateChanged(auth, async user => {
  bookingUnsubscribe?.();
  bookingRows = [];
  bookingState = user ? 'loading' : 'ready';
  refreshBookingWidgets();
  if (!user) return;
  const profile = await fetchUserProfile(user.uid);
  if (auth.currentUser?.uid !== user.uid) return;
  if (profile?.role !== 'resident') {
    bookingState = 'error';
    refreshBookingWidgets();
    return;
  }
  // One live resident query serves all clinic markers; each widget filters by clinic_id.
  bookingUnsubscribe = onSnapshot(query(collection(db, 'appointments'), where('resident_uid', '==', user.uid)), { includeMetadataChanges: true }, snapshot => {
    bookingRows = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    bookingState = snapshot.metadata.fromCache ? 'loading' : 'ready';
    refreshBookingWidgets();
  }, error => {
    console.error('Unable to check booking status:', error);
    bookingState = 'error';
    refreshBookingWidgets();
  });
});
function mountBookingWidget(host, clinic, mapId) {
  for (const widget of bookingWidgets) {
    if (!widget.host.isConnected || widget.host === host) bookingWidgets.delete(widget);
  }
  const render = () => {
    host.replaceChildren();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const booking = clinicBooking(bookingRows, clinic.id, today);
    if (bookingState === 'ready' && booking && booking.status !== 'pending') {
      const status = document.createElement('div');
      status.style.cssText = 'margin-top:12px;padding:12px;border-radius:8px;background:#ecfdf5;color:#166534;';
      status.textContent = 'Scheduled: ' + (booking.preferred_date || 'Contact clinic') + ' at ' + (booking.preferred_time || 'Contact clinic');
      host.append(status);
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-book-button';
    button.disabled = bookingState !== 'ready' || Boolean(booking) || clinic.status === 'out';
    button.textContent = bookingState === 'loading' ? 'Checking booking...' : bookingState === 'error' ? 'Unable to check booking' : booking ? 'Pending' : clinic.status === 'out' ? 'Out of Stock' : 'Book Appointment';
    if (button.disabled) button.style.cssText = 'background:#e5e7eb;color:#4b5563;cursor:not-allowed;';
    button.addEventListener('click', () => {
      if (mapId === 'googleMap') window.checkAuthAndBook?.(clinic.name, clinic.id);
      else window.openBookingModal?.(clinic.name, clinic.id);
    });
    host.append(button);
  };
  host.setAttribute('aria-live', 'polite');
  bookingWidgets.add({ host, render });
  render();
}
let CLINICS = [];
let clinicProfileData = [];
let inventoryByClinic = new Map();
let inventoryUnsubscribe = null;

const STATUS_COLOR = { available: '#00b140', low: '#d98a00', out: '#e60000' };
const STATUS_LABEL = { available: 'Available', low: 'Low Stock', out: 'Out of Stock' };

const mapsData = [];
let selectedDestination = null;
let activeStockFilter = 'all';

function initMap() {
  const containers = [
    { mapId: 'googleMapOverview', sidebarId: 'clinicSidebarOverview' },
    { mapId: 'googleMap',         sidebarId: 'clinicSidebar'         }
  ];
  if (!CLINICS.length) return;
  containers.forEach(c => {
    if (document.getElementById(c.mapId) && !mapsData.some(entry => entry.mapId === c.mapId)) createMap(c.mapId, c.sidebarId);
  });
}

function loadClinics() {
  onSnapshot(collection(db, 'clinics'), (snapshot) => {
    clinicProfileData = snapshot.docs.map(clinicDoc => {
      const data = clinicDoc.data();
      return {
        id: clinicDoc.id,
        name: data.name || 'Unnamed Clinic',
        type: normalizeClinicType(data.type || data.clinic_type || data.facility_type, data.name),
        ...getCoordinates(data),
        status: normalizeStatus(data.stock_status || data.status, data.stock_total),
        address: data.address || '',
        hours: data.weekdayHours || data.hours || 'Contact clinic',
        weekendHours: data.weekendHours || '',
        operatingHours: { weekdayHours: data.weekdayHours || '', weekendHours: data.weekendHours || '', hours: data.hours || '' },
        barangay: extractBarangay(data.address || '', data.barangay || ''),
        phone: data.contact || '',
        priceRange: data.priceRange || data.vaccination_price_range || 'Price not provided',
        vaccineTypes: normalizeVaccineTypes(data.vaccine_types || data.vaccines || data.services || []),
        stock: simplifyStockText(data.stock_summary || data.stock || `${Number(data.stock_total || 0)} doses`),
        stock_total: Number(data.stock_total || 0),
        staff_uid: data.staff_uid || ''
      };
    });
    rebuildClinicDirectory();
  }, (error) => console.error('Failed to load clinics:', error));

  inventoryUnsubscribe?.();
  inventoryUnsubscribe = onSnapshot(collection(db, 'inventory'), snapshot => {
    inventoryByClinic = new Map();
    snapshot.docs.forEach(item => {
      const data = item.data();
      const list = inventoryByClinic.get(data.clinic_id) || [];
      if (Number(data.quantity || 0) > 0) list.push(data.type || '');
      inventoryByClinic.set(data.clinic_id, list);
    });
    rebuildClinicDirectory();
  }, error => console.error('Failed to load clinic vaccine inventory:', error));
}

function rebuildClinicDirectory() {
    CLINICS = clinicProfileData.map(clinic => ({
      ...clinic,
      vaccineTypes: [...new Set([...(clinic.vaccineTypes || []), ...(inventoryByClinic.get(clinic.id) || [])])]
    }));

    window.clinicDirectory = CLINICS;
    if (window.updateNearestClinicSummary) window.updateNearestClinicSummary(CLINICS);
    if (window.populateClinicOptions) window.populateClinicOptions(CLINICS);
    mapsData.forEach(entry => {
      entry.markers.forEach(item => item.marker.remove());
      entry.markers = CLINICS.filter(clinic => Number.isFinite(clinic.lat) && Number.isFinite(clinic.lng)).map(clinic => createMarkerForMap(entry.map, clinic, entry.mapId));
      buildSidebarFor(entry);
    });
    if (window.L) initMap();
    populateMapDirectoryFilters();
}

// Complete Cabuyao list, including barangays without registered clinics.
// Source: https://psa.gov.ph/classification/psgc/barangays/0403404000
const CABUYAO_BARANGAYS = [
  'Baclaran', 'Banaybanay', 'Banlic', 'Barangay Dos', 'Barangay Tres',
  'Barangay Uno', 'Bigaa', 'Butong', 'Casile', 'Diezmo', 'Gulod',
  'Mamatid', 'Marinig', 'Niugan', 'Pittland', 'Pulo', 'Sala', 'San Isidro'
];

function normalizeBarangay(value) {
  const name = String(value).toLowerCase()
    .replace(/\b(?:brgy|barangay|poblacion|pob)\b\.?/g, '')
    .replace(/\b(?:city of cabuyao|cabuyao(?: city)?|laguna)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  return CABUYAO_BARANGAYS.find(barangay =>
    barangay.toLowerCase().replace(/^barangay /, '').replace(/[^a-z0-9]/g, '') === name
  ) || '';
}

function extractBarangay(value, explicitValue = '') {
  const match = String(value).match(/(?:brgy\.?|barangay)\s+([^,]+)/i);
  const candidates = [explicitValue, match?.[1], ...String(value).split(',')];
  for (const candidate of candidates) {
    const barangay = normalizeBarangay(candidate || '');
    if (barangay) return barangay;
  }
  return String(explicitValue || match?.[1] || '').trim();
}

function normalizeVaccineTypes(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return values.map(item => String(item).trim()).filter(Boolean);
}

function createMap(mapId, sidebarId) {
  const CABUYAO_CENTER = { lat: 14.2718, lng: 121.1246 };
  const map = L.map(mapId, { zoomControl: false }).setView([CABUYAO_CENTER.lat, CABUYAO_CENTER.lng], 14);
  L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    attribution: '&copy; Google Maps | Clinic geocoding: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 20
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
  if (total !== null && total !== undefined && total !== '' && Number.isFinite(Number(total))) return clinicStockStatus(total);
  return STATUS_COLOR[status] ? status : 'out';
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
  if (data.lat != null && data.lng != null && data.lat !== '' && data.lng !== '' && Number.isFinite(Number(data.lat)) && Number.isFinite(Number(data.lng))) {
    return { lat: Number(data.lat), lng: Number(data.lng) };
  }

  if (data.location && Number.isFinite(Number(data.location.latitude)) && Number.isFinite(Number(data.location.longitude))) {
    return { lat: Number(data.location.latitude), lng: Number(data.location.longitude) };
  }

  if (typeof data.location === 'string') {
    const matches = data.location.match(/-?\d+(?:\.\d+)?/g);
    if (matches?.length >= 2) return { lat: Number(matches[0]), lng: Number(matches[1]) };
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
  const bookingButton = '<div class="clinic-booking-status"></div>';
  const directionsButton = '<button type="button" class="map-directions-button">Get Directions</button>';
  marker.bindPopup(`<section class="clinic-popup-card"><header><span class="clinic-popup-type">${escapeHtml(clinic.type)}</span><h3>${escapeHtml(clinic.name)}</h3><span class="clinic-popup-status" style="color:${color}">${STATUS_LABEL[clinic.status]}</span></header><dl><div><dt>Address</dt><dd>${escapeHtml(clinic.address)}</dd></div><div><dt>Hours</dt><dd>${escapeHtml(clinic.hours)}</dd></div><div><dt>Phone</dt><dd>${escapeHtml(clinic.phone)}</dd></div><div><dt>Price</dt><dd>${escapeHtml(clinic.priceRange)}</dd></div><div><dt>Stock</dt><dd>${escapeHtml(clinic.stock)}</dd></div></dl><div class="clinic-popup-actions">${bookingButton}${directionsButton}</div><div class="route-summary" aria-live="polite"></div></section>`, { className: 'clinic-popup', maxWidth: 310, minWidth: 210, maxHeight: 330, autoPanPadding: [16, 16] });
  marker.on('popupopen', event => {
    const host = event.popup.getElement()?.querySelector('.clinic-booking-status');
    if (host) mountBookingWidget(host, clinic, mapId);
    const routeButton = event.popup.getElement()?.querySelector('.map-directions-button');
    if (routeButton) routeButton.addEventListener('click', () => {
      selectedDestination = clinic;
      locateUser(false);
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

    const oldButton = row.querySelector('.book-btn');
    if (oldButton) {
      const host = document.createElement('div');
      oldButton.replaceWith(host);
      mountBookingWidget(host, mobj.clinic, entry.mapId);
    }
    sidebar.appendChild(row);
  });
}

function filterMarkers(filter, btn) {
  activeStockFilter = filter;
  document.querySelectorAll('.map-filter button').forEach(b => { b.classList.remove('active-btn'); b.style.fontWeight = ''; });
  if (btn) btn.classList.add('active-btn');
  applyMapDirectoryFilters();
}

function populateMapDirectoryFilters() {
  const barangays = [...new Set([...CABUYAO_BARANGAYS, ...CLINICS.map(clinic => clinic.barangay).filter(Boolean)])].sort();
  document.querySelectorAll('.map-directory-barangay').forEach(select => {
    const currentValue = select.value;
    select.innerHTML = '<option value="all">All barangays</option>' + barangays.map(barangay => `<option value="${escapeHtml(barangay)}">${escapeHtml(barangay)}</option>`).join('');
    select.value = barangays.includes(currentValue) ? currentValue : 'all';
  });
  applyMapDirectoryFilters();
}

function applyMapDirectoryFilters() {
  const getValue = selector => document.querySelector(selector)?.value || 'all';
  const search = (document.querySelector('.map-directory-search')?.value || '').trim().toLowerCase();
  const barangay = getValue('.map-directory-barangay');
  const hours = getValue('.map-directory-hours');
  const price = getValue('.map-directory-price');
  mapsData.forEach(entry => {
    entry.markers.forEach((mobj, index) => {
      const clinic = mobj.clinic;
      const haystack = `${clinic.name} ${clinic.address}`.toLowerCase();
      const hoursText = `${clinic.hours} ${clinic.weekendHours || ''}`.toLowerCase();
      const matches = (!search || haystack.includes(search))
        && (barangay === 'all' || clinic.barangay === barangay)
        && (hours === 'all' || hours === 'open' && !hoursText.includes('closed') || hours === 'weekday' && Boolean(clinic.hours) || hours === 'weekend' && Boolean(clinic.weekendHours) && !String(clinic.weekendHours).toLowerCase().includes('closed'))
        && matchesMapPrice(clinic.priceRange, price)
        && (activeStockFilter === 'all' || clinic.status === activeStockFilter);
      if (matches) mobj.marker.addTo(entry.map);
      else mobj.marker.remove();
      const row = document.getElementById(`${entry.sidebarId}-row-${index}`);
      if (row) row.style.display = matches ? 'flex' : 'none';
    });
  });
}

function matchesMapPrice(value, filter) {
  if (filter === 'all') return true;
  const text = String(value || '').toLowerCase();
  if (filter === 'free') return text.includes('free') || text.includes('government');
  const amounts = [...text.matchAll(/(?:php|₱)?\s*([\d,]+)/gi)].map(match => Number(match[1].replace(/,/g, ''))).filter(Number.isFinite);
  if (!amounts.length) return false;
  const lowest = Math.min(...amounts);
  const highest = Math.max(...amounts);
  if (filter === 'under500') return lowest < 500;
  if (filter === '500to1500') return lowest <= 1500 && highest >= 500;
  return highest > 1500;
}

document.querySelectorAll('.map-directory-search, .map-directory-barangay, .map-directory-hours, .map-directory-price').forEach(control => {
  control.addEventListener('input', () => {
    document.querySelectorAll('.map-directory-search, .map-directory-barangay, .map-directory-hours, .map-directory-price').forEach(other => {
      if (other !== control && other.className === control.className) other.value = control.value;
    });
    applyMapDirectoryFilters();
  });
  control.addEventListener('change', () => {
    document.querySelectorAll('.map-directory-search, .map-directory-barangay, .map-directory-hours, .map-directory-price').forEach(other => {
      if (other !== control && other.className === control.className) other.value = control.value;
    });
    applyMapDirectoryFilters();
  });
});
document.querySelectorAll('.map-directory-clear').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.map-directory-search').forEach(control => { control.value = ''; });
  document.querySelectorAll('.map-directory-barangay, .map-directory-hours, .map-directory-price').forEach(control => { control.value = 'all'; });
  applyMapDirectoryFilters();
}));

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
    L.DomEvent.on(button, 'click', () => locateUser(true));
    return button;
  };
  control.addTo(entry.map);
}

let userLocation = null;
let locationWatchId = null;
// Location updates keep the blue marker accurate, but should never take over
// the viewport unless the resident explicitly pressed the location control.
let centerOnNextLocationUpdate = false;
function locateUser(centerMap = true) {
  if (!navigator.geolocation) return alert('Location is not supported by this browser.');
  centerOnNextLocationUpdate = centerMap;
  if (centerMap && userLocation) {
    mapsData.forEach(entry => entry.map.setView(userLocation, 17));
    centerOnNextLocationUpdate = false;
  }
  const updateLocation = position => {
    userLocation = [position.coords.latitude, position.coords.longitude];
    mapsData.forEach(entry => {
      if (!entry.userMarker) entry.userMarker = L.circleMarker(userLocation, { radius: 8, color: '#fff', weight: 3, fillColor: '#2878e8', fillOpacity: 1 }).addTo(entry.map);
      else entry.userMarker.setLatLng(userLocation);
      if (centerOnNextLocationUpdate) entry.map.setView(userLocation, 17);
    });
    centerOnNextLocationUpdate = false;
    if (selectedDestination) updateRoutes();
  };
  if (locationWatchId !== null) return;
  locationWatchId = navigator.geolocation.watchPosition(updateLocation, () => {
    alert('Please allow location access to show your current position.');
    locationWatchId = null;
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
}

let findingNearestClinic = false;
async function focusNearestClinic() {
  if (findingNearestClinic) return;
  window.showTab?.('overview', document.querySelectorAll('.nav-tab')[0]);
  const container = document.getElementById('googleMapOverview') || document.getElementById('googleMap');
  container?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const card = document.getElementById('nearestClinicCard');
  const distanceLabel = document.getElementById('nearestClinicDistance');
  let status = document.getElementById('nearestClinicStatus');
  if (!status && container) {
    status = document.createElement('p');
    status.id = 'nearestClinicStatus';
    status.setAttribute('role', 'status');
    status.className = 'nearest-clinic-status';
    const mapFrame = container.closest('.map-box') || container;
    mapFrame.insertAdjacentElement('beforebegin', status);
  }
  const message = text => { if (status) status.textContent = text; };
  findingNearestClinic = true;
  card?.setAttribute('aria-busy', 'true');
  message('Finding your location. Please allow location access when prompted.');
  try {
    if (!navigator.geolocation) throw new Error('Location is not supported by this browser. Select a clinic on the map.');
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }));
    userLocation = [position.coords.latitude, position.coords.longitude];
    const nearest = CLINICS.filter(clinic => Number.isFinite(clinic.lat) && Number.isFinite(clinic.lng))
      .map(clinic => ({ clinic, distance: mapDistanceInKm(...userLocation, clinic.lat, clinic.lng) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!nearest) throw new Error('No clinic locations are available yet. Please try again after the clinics load.');
    const entry = mapsData.find(item => item.mapId === container?.id);
    const markerEntry = entry?.markers.find(item => item.clinic.id === nearest.clinic.id);
    if (!markerEntry) throw new Error('The map is still loading. Please try again in a moment.');
    document.querySelectorAll('.map-directory-search').forEach(control => { control.value = ''; });
    document.querySelectorAll('.map-directory-barangay, .map-directory-hours, .map-directory-price').forEach(control => { control.value = 'all'; });
    activeStockFilter = 'all';
    document.querySelectorAll('.map-filter').forEach(group => group.querySelectorAll('button').forEach((button, index) => { button.classList.toggle('active-btn', index === 0); }));
    applyMapDirectoryFilters();
    selectedDestination = nearest.clinic;
    if (entry.routeLayer) { entry.routeLayer.remove(); entry.routeLayer = null; }
    if (!entry.userMarker) entry.userMarker = L.circleMarker(userLocation, { radius: 8, color: '#fff', weight: 3, fillColor: '#2878e8', fillOpacity: 1 }).addTo(entry.map).bindPopup('Your location');
    else entry.userMarker.setLatLng(userLocation);
    entry.map.invalidateSize();
    entry.map.setView(markerEntry.marker.getLatLng(), 16);
    markerEntry.marker.openPopup();
    if (distanceLabel) distanceLabel.textContent = nearest.distance.toFixed(1) + ' km';
    message('Nearest clinic: ' + nearest.clinic.name + ' - approximately ' + nearest.distance.toFixed(1) + ' km away in a straight line.');
  } catch (error) {
    if (distanceLabel) distanceLabel.textContent = 'Tap to try again';
    message(error.code === 1 ? 'Location access was denied. Allow location access in your browser, then click Nearest Clinic again.' : error.code === 2 ? 'Your location is unavailable. Turn on location services and try again.' : error.code === 3 ? 'Finding your location timed out. Please try again.' : error.message);
  } finally {
    findingNearestClinic = false;
    card?.removeAttribute('aria-busy');
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
populateMapDirectoryFilters();
loadClinics();
