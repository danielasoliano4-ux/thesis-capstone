export function shortVaccineName(value) {
  const name = String(value || 'Vaccine').replace(/\([^)]*\)/g, '').trim();
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = { verorab:'Verorab', verovab:'Verorab', speeda:'Speeda', rabipur:'Rabipur', rabipub:'Rabipur', rabibub:'Rabipur', vaxirab:'VaxiRab', vaxirabn:'VaxiRab', rabivaxs:'Rabivax-S', imovax:'Imovax', rabavert:'RabAvert', rcpv:'RCPV' };
  return names[key] || name || 'Vaccine';
}
export function summarizeStock(items) {
  const totals = new Map();
  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const name = shortVaccineName(item.type);
    totals.set(name, (totals.get(name) || 0) + quantity);
  }
  return [...totals].map(([name, quantity]) => name + ': ' + quantity).join(' | ') || '0 doses';
}
export function simplifyStockText(value) {
  const text = String(value || '');
  const parts = text.split(/[|\u00b7]/).map(part => part.replace(/^[\s\u00c2]+/, '').trim());
  const items = parts.map(part => {
    const match = /^(.*):\s*(\d+)(?:\s*doses?)?$/i.exec(part);
    return match ? { type: match[1], quantity: Number(match[2]) } : null;
  });
  return items.length && items.every(Boolean) ? summarizeStock(items) : text;
}
export function clinicStockStatus(total) {
  const quantity = Number(total);
  return !Number.isFinite(quantity) || quantity <= 0 ? 'out' : quantity <= 15 ? 'low' : 'available';
}
