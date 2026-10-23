import { scheduleForDate } from './clinic-hours.js';

export function clinicOpeningStatus(clinic, now = new Date()) {
  const manila = new Date(+now + 8 * 60 * 60 * 1000);
  const date = manila.toISOString().slice(0, 10);
  const minute = manila.getUTCHours() * 60 + manila.getUTCMinutes();
  const schedule = scheduleForDate(clinic, date);
  return !schedule.known ? 'unknown'
    : schedule.ranges.some(([start, end]) => minute >= start && minute < end) ? 'open' : 'closed';
}

export function clinicDistanceKm(location, clinic) {
  const radians = value => value * Math.PI / 180;
  const [latitude, longitude] = location;
  const a = Math.sin(radians(clinic.lat - latitude) / 2) ** 2
    + Math.cos(radians(latitude)) * Math.cos(radians(clinic.lat)) * Math.sin(radians(clinic.lng - longitude) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export function recommendClinics(clinics, location = null, now = new Date()) {
  const hasLocation = Array.isArray(location) && location.length === 2 && location.every(Number.isFinite);
  const eligible = clinics.filter(clinic => Number.isFinite(clinic.lat) && Math.abs(clinic.lat) <= 90
    && Number.isFinite(clinic.lng) && Math.abs(clinic.lng) <= 180
    && ['available', 'low'].includes(clinic.status) && Number.isFinite(clinic.stock_total) && clinic.stock_total > 0)
    .map(clinic => ({ clinic, opening: clinicOpeningStatus(clinic, now), distance: hasLocation ? clinicDistanceKm(location, clinic) : null }));
  const byStock = (a, b) => b.clinic.stock_total - a.clinic.stock_total
    || (a.distance ?? 0) - (b.distance ?? 0) || a.clinic.name.localeCompare(b.clinic.name);
  const open = eligible.filter(item => item.opening === 'open');
  return {
    best: [...open].sort(byStock)[0] || null,
    nearest: hasLocation ? [...open].sort((a, b) => a.distance - b.distance || byStock(a, b))[0] || null : null,
    highest: [...eligible].sort(byStock)[0] || null
  };
}

export function recommendForBarangay(clinics, barangay, location = null, now = new Date()) {
  const local = clinics.filter(clinic => String(clinic.barangay || '').toLowerCase() === String(barangay || '').toLowerCase());
  const inStock = clinic => Number.isFinite(clinic.stock_total) && clinic.stock_total > 0;
  const localAvailable = local.filter(inStock).sort((a, b) => b.stock_total - a.stock_total)[0] || null;
  const localReady = localAvailable && localAvailable.stock_total > 15 ? localAvailable : null;
  if (localReady && clinicOpeningStatus(localReady, now) === 'open') {
    return { clinic: localReady, localClinic: localAvailable, fallback: false, distance: null };
  }

  const hasLocation = Array.isArray(location) && location.length === 2 && location.every(Number.isFinite);
  const origins = hasLocation ? [location] : local.filter(clinic => Number.isFinite(clinic.lat) && Number.isFinite(clinic.lng)).map(clinic => [clinic.lat, clinic.lng]);
  const candidates = clinics.filter(clinic => clinic.barangay !== barangay && Number.isFinite(clinic.lat) && Number.isFinite(clinic.lng)
    && Number.isFinite(clinic.stock_total) && clinic.stock_total > 15 && clinicOpeningStatus(clinic, now) === 'open');
  const ranked = candidates.map(clinic => {
    const distance = origins.length ? Math.min(...origins.map(origin => clinicDistanceKm(origin, clinic))) : null;
    return { clinic, distance };
  }).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || b.clinic.stock_total - a.clinic.stock_total || a.clinic.name.localeCompare(b.clinic.name));
  return { clinic: ranked[0]?.clinic || null, distance: ranked[0]?.distance ?? null, localClinic: localAvailable, fallback: true };
}
