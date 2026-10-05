'use strict';

const { readStock, publishStock } = require('./stock-reservations');

function inventoryStockHandler({ db, timestamp, now = () => new Date() }) {
  return async event => {
    const clinicIds = new Set([
      event.data?.before?.data()?.clinic_id,
      event.data?.after?.data()?.clinic_id
    ].filter(id => typeof id === 'string' && id.trim() && !id.includes('/')));

    for (const clinicId of clinicIds) {
      await db.runTransaction(async tx => {
        const clinic = await tx.get(db.collection('clinics').doc(clinicId));
        if (!clinic.exists) return;
        const current = now();
        // Events can arrive late or be retried. Read current inventory rather
        // than publishing the event's older quantities over a reservation.
        const stock = await readStock(tx, db, clinicId, current);
        publishStock(tx, db, clinicId, stock.items, timestamp, current);
      });
    }
  };
}

module.exports = { inventoryStockHandler };
