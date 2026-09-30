const { createHash, randomUUID } = require('node:crypto');
function normalize(value) { return String(value || '').toLowerCase().replace(/barangay|brgy\.?|poblacion/g, '').replace(/[^a-z0-9]/g, '').replace(/^banaybanay$/, 'banaybanay'); }
function selectClinicLocation(results, input, HttpsError) {
  if (!Array.isArray(results)) throw new HttpsError('unavailable', 'Unexpected address lookup response. Please retry.');
  const candidates = results.filter(row => {
    const address = row.address || {};
    const locality = address.city || address.town || address.municipality || '';
    const barangays = ['suburb','quarter','neighbourhood','village','city_district'].map(key => normalize(address[key]));
    const precise = Number(row.place_rank) === 30 && (Boolean(address.house_number) || row.category === 'building' || ['clinic','hospital','doctors'].includes(row.type));
    return precise && address.country_code === 'ph' && /cabuyao/i.test(locality)
      && barangays.includes(normalize(input.barangay))
      && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon));
  });
  const unique = [...new Map(candidates.map(row => [row.osm_type + ':' + row.osm_id, row])).values()];
  if (unique.length !== 1) throw new HttpsError('failed-precondition', 'No unique building-level match was found for this address and barangay. Check the street/building details before approving. The registration remains pending.');
  const row = unique[0];
  return { lat: Number(row.lat), lng: Number(row.lon), precise: true, city: 'Cabuyao', country: 'PH', provider: 'nominatim', accuracy: 'building_or_clinic', osm_id: String(row.osm_id), osm_type: row.osm_type };
}
function createClinicGeocoder({ db, HttpsError, fetchImpl = fetch, now = Date.now }) {
  return async input => {
    // Console-managed configuration permits switching provider hosts without a code release.
    const config = (await db.collection('_geocoding_config').doc('nominatim').get()).data() || {};
    const endpoint = config.endpoint || 'https://nominatim.openstreetmap.org/search';
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new HttpsError('failed-precondition', 'The geocoding endpoint must use HTTPS.');
    const address = [input.address, 'Barangay ' + input.barangay, input.city, input.province, 'Philippines'].join(', ');
    const key = createHash('sha256').update(endpoint + '|' + address.toLowerCase()).digest('hex');
    const cacheRef = db.collection('_geocoding_cache').doc(key);
    const cached = (await cacheRef.get()).data();
    if (cached?.validUntil > now()) return selectClinicLocation(cached.results, input, HttpsError);
    const lockRef = db.collection('_geocoding_limits').doc('nominatim');
    const owner = randomUUID();
    await db.runTransaction(async tx => {
      const lock = (await tx.get(lockRef)).data() || {};
      if (lock.until > now()) throw new HttpsError('resource-exhausted', 'Another address lookup is running. Wait a few seconds and retry approval.');
      tx.set(lockRef, { owner, until: now() + 30000 });
    });
    try {
      url.search = new URLSearchParams({ q: address, format: 'jsonv2', addressdetails: '1', limit: '5', countrycodes: 'ph', 'accept-language': 'en' }).toString();
      let results;
      try {
        const response = await fetchImpl(url.toString(), { headers: { 'User-Agent': 'AntiRabiesLocator/1.0 (https://anti-rabies-locator.web.app)', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('provider');
        results = await response.json();
      } catch { throw new HttpsError('unavailable', 'Nominatim is unavailable. The registration remains pending. Please retry later.'); }
      if (!Array.isArray(results)) throw new HttpsError('unavailable', 'Unexpected address lookup response. Please retry.');
      await cacheRef.set({ results, validUntil: now() + 30 * 86400000, expiresAt: new Date(now() + 30 * 86400000) });
      return selectClinicLocation(results, input, HttpsError);
    } finally {
      // Cooldown begins after the previous request completes, even across instances.
      await db.runTransaction(async tx => {
        const lock = (await tx.get(lockRef)).data();
        if (lock?.owner === owner) tx.set(lockRef, { owner, until: now() + 1100 });
      });
    }
  };
}
module.exports = { createClinicGeocoder, selectClinicLocation };
