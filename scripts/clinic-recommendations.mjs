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
