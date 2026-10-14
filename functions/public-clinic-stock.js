'use strict';
const { usable, availableQuantity } = require('./stock-reservations');

// Return only public availability, never batch details or staff information.
function publicClinicStockHandler({ db, now = () => new Date() }) {
  return async () => {
    const [clinics, inventory] = await Promise.all([
      db.collection('clinics').get(),
      db.collection('inventory').get()
    ]);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now());
    const byClinic = new Map();
    for (const doc of inventory.docs) {
      const item = { ...doc.data(), id: doc.id };
      const items = byClinic.get(item.clinic_id) || [];
      items.push(item);
      byClinic.set(item.clinic_id, items);
    }
    return { clinics: clinics.docs.map(doc => {
      const active = (byClinic.get(doc.id) || []).filter(item =>
        typeof item.type === 'string' && item.type.trim() && usable(item, today));
      const total = active.reduce((sum, item) => sum + availableQuantity(item), 0);
      return { id: doc.id, stock_total: total, status: total <= 0 ? 'out' : total <= 15 ? 'low' : 'available',
        stock: active.map(item => `${item.type}: ${availableQuantity(item)}`).join(' | ') || '0 doses',
        vaccineTypes: [...new Set(active.map(item => item.type))] };
    }) };
  };
}

module.exports = { publicClinicStockHandler };
