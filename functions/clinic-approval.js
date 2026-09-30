const BARANGAYS = ['Baclaran','Banlic','Banay-banay','Bigaa','Butong','Casile','Diezmo','Gulod','Mamatid','Marinig','Niugan','Pittland','Poblacion Dos','Poblacion Tres','Poblacion Uno','Pulo','Sala','San Isidro'];
function createClinicApproval({ db, HttpsError, timestamp }) {
  return async request => {
    if (!request.auth || request.auth.token?.secure_login !== true) throw new HttpsError('unauthenticated', 'Sign in as an administrator.');
    const adminRef = db.collection('users').doc(request.auth.uid);
    const adminProfile = (await adminRef.get()).data();
    if (!['admin','administrator'].includes(adminProfile?.role)) throw new HttpsError('permission-denied', 'Administrator access is required.');
    const { uid, approved, manualLocation } = request.data || {};
    if (typeof uid !== 'string' || !uid || uid.includes('/') || typeof approved !== 'boolean') throw new HttpsError('invalid-argument', 'Choose a registration and approval action.');
    const userRef = db.collection('users').doc(uid);
    const user = (await userRef.get()).data();
    if (!user || user.role !== 'clinic_staff') throw new HttpsError('not-found', 'Clinic registration was not found.');
    if (user.approval_status === 'approved' && approved) return { approved: true, clinicId: user.clinic_id || uid };
    if (user.approval_status !== 'pending') throw new HttpsError('failed-precondition', 'This registration has already been reviewed.');
    if (manualLocation !== undefined) throw new HttpsError('invalid-argument', 'Clinic staff must choose their location during registration.');
    if (approved) {
      if (!Number.isFinite(user.clinic_lat) || !Number.isFinite(user.clinic_lng) || user.clinic_lat < 14.10 || user.clinic_lat > 14.35 || user.clinic_lng < 121.00 || user.clinic_lng > 121.25) throw new HttpsError('failed-precondition', 'This registration is missing a valid clinic-selected location. The clinic must submit its location before approval.');
      if (!user.clinic_name || !user.clinic_address || !BARANGAYS.includes(user.clinic_barangay)) throw new HttpsError('failed-precondition', 'The registration needs a clinic name, complete address and valid clinic barangay before approval.');
    }
    return db.runTransaction(async tx => {
      const reviewer = (await tx.get(adminRef)).data();
      const latest = (await tx.get(userRef)).data();
      const clinicRef = db.collection('clinics').doc(uid);
      const existing = await tx.get(clinicRef);
      if (!['admin','administrator'].includes(reviewer?.role)) throw new HttpsError('permission-denied', 'Administrator access is required.');
      if (latest?.approval_status === 'approved' && approved) return { approved: true, clinicId: latest.clinic_id || uid };
      if (latest?.approval_status !== 'pending' || latest.role !== 'clinic_staff' || ['clinic_name','clinic_address','clinic_barangay','clinic_lat','clinic_lng'].some(key => latest[key] !== user[key])) throw new HttpsError('failed-precondition', 'The registration changed. Reload and review it again.');
      if (approved && ((latest.clinic_id && latest.clinic_id !== uid) || (existing.exists && existing.data().staff_uid !== uid))) throw new HttpsError('failed-precondition', 'This account has an existing clinic assignment that needs review.');
      if (approved) tx.set(clinicRef, { name: user.clinic_name, address: user.clinic_address, barangay: user.clinic_barangay, contact: user.phone || '', staff_uid: uid,
        lat: user.clinic_lat, lng: user.clinic_lng, location: { latitude: user.clinic_lat, longitude: user.clinic_lng },
        approved_by: request.auth.uid, approval_status: 'approved', updated_at: timestamp(), ...(!existing.exists ? { created_at: timestamp(), stock_total: 0, stock_status: 'out' } : {}) }, { merge: true });
      tx.update(userRef, { is_active: approved, approval_status: approved ? 'approved' : 'denied', ...(approved ? { clinic_id: uid } : {}), reviewed_by: request.auth.uid, reviewed_at: timestamp(), updated_at: timestamp() });
      return { approved, clinicId: approved ? uid : null };
    });
  };
}
module.exports = { createClinicApproval };
