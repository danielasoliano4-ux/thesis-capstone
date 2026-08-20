import { auth, db, onAuthStateChanged } from './firebase.js';
import { collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

let CLINICS = [];

const STATUS_COLOR = { available: '#00b140', low: '#d98a00', out: '#e60000' };
const STATUS_LABEL = { available: 'Available', low: 'Low Stock', out: 'Out of Stock' };

const mapsData = [];

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
        lat: Number(data.lat),
        lng: Number(data.lng),
        status: data.stock_status || data.status || 'out',
        address: data.address || '',
        hours: data.weekdayHours || data.hours || 'Contact clinic',
        phone: data.contact || '',
        stock: data.stock_summary || data.stock || `${Number(data.stock_total || 0)} doses`,
        stock_total: Number(data.stock_total || 0),
        staff_uid: data.staff_uid || ''
      };
    });

    window.clinicDirectory = CLINICS;
    if (window.populateClinicOptions) window.populateClinicOptions(CLINICS);
    mapsData.splice(0).forEach(entry => entry.markers.forEach(marker => marker.marker.setMap(null)));
    mapsData.splice(0);
    if (window.google && google.maps) initMap();
  }, (error) => console.error('Failed to load clinics:', error));
}

function createMap(mapId, sidebarId) {
  const CABUYAO_CENTER = { lat: 14.2718, lng: 121.1246 };
  const map = new google.maps.Map(document.getElementById(mapId), {
    center: CABUYAO_CENTER,
    zoom: 14,
    styles: [
      { featureType: 'poi',       elementType: 'labels',   stylers: [{ visibility: 'off' }] },
      { featureType: 'transit',                            stylers: [{ visibility: 'off' }] },
      { featureType: 'road',      elementType: 'geometry', stylers: [{ color: '#f5f5f5' }] },
      { featureType: 'water',     elementType: 'geometry', stylers: [{ color: '#dff1f7' }] },
      { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#f9f9f9' }] }
    ],
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    mapTypeId: 'roadmap'
  });

  const entry = { mapId, sidebarId, map, markers: [] };
  entry.center = CABUYAO_CENTER;
  CLINICS.filter(clinic => Number.isFinite(clinic.lat) && Number.isFinite(clinic.lng)).forEach(clinic => {
    entry.markers.push(createMarkerForMap(map, clinic));
  });
  mapsData.push(entry);
  buildSidebarFor(entry);
}

function createMarkerForMap(map, clinic) {
  const color = STATUS_COLOR[clinic.status];
  const svgMarker = {
    path: google.maps.SymbolPath.CIRCLE,
    fillColor: color, fillOpacity: 1,
    strokeColor: '#ffffff', strokeWeight: 2.5, scale: 12
  };
  const marker = new google.maps.Marker({
    position: { lat: clinic.lat, lng: clinic.lng },
    map, title: clinic.name, icon: svgMarker,
    zIndex: clinic.status === 'available' ? 10 : clinic.status === 'low' ? 5 : 1
  });

  const badgeBg = clinic.status === 'available' ? '#eefcf3' : clinic.status === 'low' ? '#fffbe9' : '#fff1f1';
  const badgeColor = color;
  const infoContent = `
    <div style="font-family:Arial,sans-serif;padding:4px;min-width:220px;">
      <div style="font-weight:bold;font-size:14px;color:#111827;margin-bottom:6px;">${clinic.name}</div>
      <span style="background:${badgeBg};color:${badgeColor};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:bold;display:inline-block;margin-bottom:10px;">${STATUS_LABEL[clinic.status]}</span>
      <div style="font-size:12px;color:#374151;line-height:1.8;">
        <div><b>Address:</b> ${clinic.address}</div>
        <div><b>Hours:</b> ${clinic.hours}</div>
        <div><b>Phone:</b> ${clinic.phone}</div>
        <div style="margin-top:6px;padding:8px;background:#f9fafb;border-radius:8px;"><b>Stock:</b> ${clinic.stock}</div>
      </div>
      <div style="font-size:11px;color:#9ca3af;margin-top:8px;">© Google Maps</div>
    </div>
  `;
  const infoWindow = new google.maps.InfoWindow({ content: infoContent });
  marker.addListener('click', () => {
    mapsData.forEach(d => d.markers.forEach(mm => mm.infoWindow.close()));
    infoWindow.open(map, marker);
    map.panTo(marker.getPosition());
  });
  return { marker, infoWindow, clinic };
}

function buildSidebarFor(entry) {
  const sidebar = document.getElementById(entry.sidebarId);
  if (!sidebar) return;
  sidebar.innerHTML = '';
  entry.markers.forEach((mobj, index) => {
    const color = STATUS_COLOR[mobj.clinic.status];
    const row = document.createElement('div');
    row.id = `${entry.sidebarId}-row-${index}`;
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;background:white;border:1px solid #ddd;border-radius:12px;padding:12px 16px;cursor:pointer;transition:border-color 0.2s;gap:12px;';

    const leftHtml = `
      <div style="display:flex;flex-direction:column;gap:4px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:13px;font-weight:bold;color:#111827;">${mobj.clinic.name}</span>
        </div>
        <div style="font-size:12px;color:#6b7280;">${mobj.clinic.address} &nbsp;|&nbsp; ${mobj.clinic.hours}</div>
      </div>
    `;

    const rightHtml = mobj.clinic.status === 'out'
      ? `<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:12px;color:${color};font-weight:bold;">Out of Stock</span><button class="book-btn" disabled style="background:#d1d5db;border:none;color:#6b7280;cursor:not-allowed;">Out of Stock</button></div>`
      : `<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:12px;color:${color};font-weight:bold;">${STATUS_LABEL[mobj.clinic.status]}</span><button class="book-btn" onclick="openBookingModal('${mobj.clinic.name.replace(/'/g, "\\'")}', '${mobj.clinic.id}')">Book</button></div>`;

    row.innerHTML = `<div style="display:flex;align-items:center;gap:12px;flex:1;">${leftHtml}</div><div style="display:flex;align-items:center;gap:12px;">${rightHtml}</div>`;

    row.addEventListener('click', (e) => {
      if (e.target && (e.target.tagName === 'BUTTON' || e.target.closest('button'))) return;
      mapsData.forEach(d => d.markers.forEach(mm => mm.infoWindow.close()));
      mobj.infoWindow.open(entry.map, mobj.marker);
      entry.map.panTo(mobj.marker.getPosition());
      entry.map.setZoom(16);
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
      mobj.marker.setVisible(show);
      mobj.infoWindow.close();
      const row = document.getElementById(`${entry.sidebarId}-row-${i}`);
      if (row) row.style.display = show ? 'flex' : 'none';
    });
  });
}

// Call this if a map's container was hidden during initialization
function refreshMaps() {
  if (!window.google || !google.maps) return;
  mapsData.forEach(entry => {
    try {
      google.maps.event.trigger(entry.map, 'resize');
      if (entry.center) entry.map.setCenter(entry.center);
    } catch (e) {
      // ignore
    }
  });
}

window.refreshMaps = refreshMaps;
window.initMap = initMap;
onAuthStateChanged(auth, (user) => {
  if (user) loadClinics();
});