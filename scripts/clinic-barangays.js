// Complete Cabuyao list, including barangays without registered clinics.
// Source: https://psa.gov.ph/classification/psgc/barangays/0403404000
export const CABUYAO_BARANGAYS = [
  'Baclaran', 'Banaybanay', 'Banlic', 'Barangay Dos', 'Barangay Tres',
  'Barangay Uno', 'Bigaa', 'Butong', 'Casile', 'Diezmo', 'Gulod',
  'Mamatid', 'Marinig', 'Niugan', 'Pittland', 'Pulo', 'Sala', 'San Isidro'
];

export function normalizeBarangay(value) {
  const name = String(value).toLowerCase()
    .replace(/\b(?:brgy|barangay|poblacion|pob)\b\.?/g, '')
    .replace(/\b(?:city of cabuyao|cabuyao(?: city)?|laguna)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  return CABUYAO_BARANGAYS.find(barangay =>
    barangay.toLowerCase().replace(/^barangay /, '').replace(/[^a-z0-9]/g, '') === name
  ) || '';
}

export function extractBarangay(value, explicitValue = '') {
  const match = String(value).match(/(?:brgy\.?|barangay)\s+([^,]+)/i);
  const candidates = [explicitValue, match?.[1], ...String(value).split(',')];
  for (const candidate of candidates) {
    const barangay = normalizeBarangay(candidate || '');
    if (barangay) return barangay;
  }
  return String(explicitValue || match?.[1] || '').trim();
}

