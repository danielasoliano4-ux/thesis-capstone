export function doseSummaryFields(record, residentName, dateLabel) {
  const value = input => String(input ?? '').trim() || 'Not recorded';
  return [
    ['Resident', value(residentName)],
    ['Brand name', value(record.brand_name || record.vaccine_brand || record.vaccine_name)],
    ['Generic name', value(record.generic_name || record.vaccine_generic_name || (record.vaccine_type !== record.vaccine_name ? record.vaccine_type : ''))],
    ['Vaccine batch', value(record.vaccine_batch || record.batch_number || record.batch)],
    ['Dose number', value(record.dose_number)],
    ['Administration date', value(dateLabel)],
    ['Clinic facility', value(record.clinic_name)],
    ['Clinic location', value(record.clinic_location)],
    ['Dose status', value(record.status || 'Completed')],
    ['Verification', value(record.verification_status)],
    ['Verification basis', value(record.verification_basis)],
  ];
}

export function openDosePreview(record, residentName, dateLabel) {
  document.querySelector('.dose-preview-dialog')?.close();
  const opener = document.activeElement;
  const fields = doseSummaryFields(record, residentName, dateLabel);
  const dialog = document.createElement('dialog');
  dialog.className = 'dose-preview-dialog';
  dialog.setAttribute('aria-labelledby', 'dosePreviewTitle');
  dialog.innerHTML = `<div class="dose-preview-heading"><div><p>VACCINATION RECORD</p><h2 id="dosePreviewTitle"></h2></div><button type="button" class="dose-preview-close" aria-label="Close dose preview" autofocus>&times;</button></div><p class="dose-preview-intro">Details of your completed vaccination dose.</p><dl class="dose-preview-fields"></dl><p class="dose-preview-error" role="status"></p><div class="dose-preview-actions"><button type="button" class="dose-preview-download"><i class="fa-solid fa-download" aria-hidden="true"></i> Download summary (PNG)</button></div>`;
  dialog.querySelector('h2').textContent = `Dose ${record.dose_number ?? ''}`;
  const list = dialog.querySelector('dl');
  fields.forEach(([label, value]) => {
    const group = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value;
    group.append(term, detail);
    list.append(group);
  });
  dialog.querySelector('.dose-preview-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  }, { once: true });
  const download = dialog.querySelector('.dose-preview-download');
  download.addEventListener('click', async () => {
    download.disabled = true;
    const status = dialog.querySelector('.dose-preview-error');
    status.textContent = '';
    try {
      await downloadDoseSummary(fields, record.dose_number);
    } catch (error) {
      console.error('Could not export dose summary:', error);
      status.textContent = 'Could not download this summary. Please try again.';
    } finally {
      download.disabled = false;
    }
  });
  document.body.append(dialog);
  dialog.showModal();
}

async function downloadDoseSummary(fields, doseNumber) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image export is unavailable.');
  context.font = '24px sans-serif';
  // Wrap by measured characters so long facility names and unbroken text fit.
  const rows = fields.map(([label, value]) => {
    const lines = [];
    for (const paragraph of value.split(/\r?\n/)) {
      let line = '';
      for (const character of paragraph) {
        if (line && context.measureText(line + character).width > 860) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
      lines.push(line);
    }
    return { label, lines };
  });
  canvas.width = 1000;
  canvas.height = 220 + rows.reduce((height, row) => height + 65 + row.lines.length * 34, 0);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#2563eb';
  context.fillRect(0, 0, canvas.width, 12);
  context.font = 'bold 34px sans-serif';
  context.fillText('Vaccination dose summary', 70, 85);
  context.fillStyle = '#64748b';
  context.font = '20px sans-serif';
  context.fillText('Completed dose record', 70, 125);
  let y = 185;
  rows.forEach(({ label, lines }) => {
    context.fillStyle = '#64748b';
    context.font = '20px sans-serif';
    context.fillText(label, 70, y);
    y += 34;
    context.fillStyle = '#0f172a';
    context.font = '24px sans-serif';
    lines.forEach(line => { context.fillText(line, 70, y); y += 34; });
    y += 31;
  });
  const blob = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('Image export failed.')), 'image/png'));
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `vaccination-dose-${String(doseNumber ?? 'record').replace(/[^a-z0-9_-]/gi, '_')}.png`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// The same isolated document is used for on-screen preview and printing.
export function buildDoseReportHtml(records, residentName, formatDate) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const rows = records.map(record => {
    const fields = new Map(doseSummaryFields(record, residentName, formatDate(record.date_given)));
    return `<tr>${['Dose number', 'Brand name', 'Generic name', 'Vaccine batch', 'Administration date', 'Clinic facility', 'Dose status'].map(label => `<td>${escape(fields.get(label))}</td>`).join('')}</tr>`;
  }).join('');
  const logo = new URL('../assets/system-logo.png', import.meta.url).href;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Selected vaccination doses</title><style>
    @page { size: A4 portrait; margin: 15mm; }
    * { box-sizing: border-box; } body { margin: 0; padding: 24px; background: #e2e8f0; color: #172033; font: 13px Arial, sans-serif; }
    article { width: 100%; max-width: 180mm; min-height: 250mm; margin: auto; padding: 12mm; background: white; }
    header { display: flex; align-items: center; gap: 16px; padding-bottom: 20px; border-bottom: 3px solid #2563eb; }
    img { width: 64px; height: 64px; object-fit: contain; } h1 { margin: 5px 0; font-size: 22px; } header p { margin: 0; color: #475569; }
    .meta { margin: 24px 0; line-height: 1.8; overflow-wrap: anywhere; } table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 11px; }
    th, td { padding: 10px 6px; border: 1px solid #cbd5e1; text-align: left; vertical-align: top; overflow-wrap: anywhere; } th { background: #eff6ff; } th:first-child { width: 9%; }
    thead { display: table-header-group; } tr { break-inside: avoid; } footer { margin-top: 24px; border-top: 1px solid #cbd5e1; padding-top: 14px; line-height: 1.7; } .note { color: #64748b; font-size: 11px; }
    @media print { body { padding: 0; background: white; } article { padding: 0; max-width: none; min-height: 0; } }
    </style></head><body><article><header><img src="${escape(logo)}" alt="Vaxx Bite Cabuyao"><div><p>VACCINATION RECORD</p><h1>Selected dose summary</h1></div></header><div class="meta"><strong>Resident:</strong> ${escape(residentName || 'Not recorded')}<br><strong>Report date:</strong> ${escape(new Date().toLocaleDateString())}</div><table><thead><tr><th scope="col">Dose</th><th scope="col">Brand name</th><th scope="col">Generic name</th><th scope="col">Vaccine batch</th><th scope="col">Administered</th><th scope="col">Clinic facility</th><th scope="col">Dose status</th></tr></thead><tbody>${rows}</tbody></table><footer><strong>Total selected dose records: ${records.length}</strong><p class="note">Only selected dose records are included. Missing information is shown as “Not recorded”.</p></footer></article></body></html>`;
}

export function openDoseReportPreview(records, residentName, formatDate) {
  if (!records.length) return;
  const opener = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'dose-preview-dialog dose-report-dialog';
  dialog.setAttribute('aria-labelledby', 'doseReportTitle');
  dialog.innerHTML = `<div class="dose-preview-heading"><div><p>PREVIEW BEFORE EXPORT</p><h2 id="doseReportTitle">Selected dose report</h2></div><button type="button" class="dose-preview-close" aria-label="Close report preview" autofocus>&times;</button></div><p class="dose-preview-intro">Review your selected doses. Choose Save as PDF in the print dialog to download a PDF.</p><iframe class="dose-report-frame" title="Formatted vaccination report preview"></iframe><p class="dose-preview-error" role="status"></p><div class="dose-report-controls"><button type="button" class="dose-report-cancel">Cancel / Close</button><button type="button" class="dose-report-image">Download PNG</button><button type="button" class="dose-preview-download" disabled>Proceed to Print / Save PDF</button></div>`;
  const frame = dialog.querySelector('iframe');
  const print = dialog.querySelector('.dose-preview-download');
  frame.addEventListener('load', () => { print.disabled = false; });
  frame.srcdoc = buildDoseReportHtml(records, residentName, formatDate);
  print.addEventListener('click', () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  });
  const imageButton = dialog.querySelector('.dose-report-image');
  imageButton.addEventListener('click', async () => {
    imageButton.disabled = true;
    const status = dialog.querySelector('.dose-preview-error');
    status.textContent = '';
    try {
      const fields = [['Total selected dose records', String(records.length)], ...records.flatMap(record => doseSummaryFields(record, residentName, formatDate(record.date_given)))];
      await downloadDoseSummary(fields, records.map(record => record.dose_number).join('-'));
    } catch (error) {
      console.error('Could not export selected doses:', error);
      status.textContent = 'Could not download the image. Please try again or use Save PDF.';
    } finally { imageButton.disabled = false; }
  });
  dialog.querySelectorAll('.dose-preview-close, .dose-report-cancel').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
}
