export function expiryReminders(items, clinicId, today) {
  const day = Date.parse(today + 'T00:00:00Z');
  return items.filter(item => item.clinic_id === clinicId && !item.archived && Number(item.quantity) > 0).flatMap(item => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.expiry || '')) return [];
    const expiration = Date.parse(item.expiry + 'T00:00:00Z');
    if (!Number.isFinite(expiration) || new Date(expiration).toISOString().slice(0,10) !== item.expiry) return [];
    const daysRemaining = Math.round((expiration - day) / 86400000);
    return daysRemaining <= 30 ? [{ ...item, daysRemaining, expired: daysRemaining <= 0 }] : [];
  }).sort((a,b) => a.daysRemaining - b.daysRemaining || String(a.batch).localeCompare(String(b.batch)));
}
