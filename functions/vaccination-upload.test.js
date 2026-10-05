const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/residents.js'), 'utf8');
const uploadSource = source.slice(source.indexOf('function uploadVaccinationFile('), source.indexOf('function toggleResRow('));
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(overrides = {}) {
  const timers = new Map();
  const uploads = [];
  const saved = [];
  const messages = [];
  const loaded = [];
  let timerSequence = 0;
  const text = { textContent: 'Click to upload' };
  const button = { disabled: false };
  const box = {
    attributes: {}, querySelector: () => text,
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; }
  };
  const controls = {
    attributes: {}, querySelector: selector => selector === '.upload-box' ? box : button,
    setAttribute(name, value) { this.attributes[name] = value; }
  };
  const status = { hidden: true, textContent: '', classList: { toggle(name, enabled) { status.isError = enabled; } } };
  const input = { files: [{ name: 'card.jpg', type: 'image/jpeg', size: 100 }], value: 'card.jpg', dataset: {}, disabled: false };
  const context = {
    vaccinationUploadInProgress: false, currentUid: 'resident', currentVaccinationSessionId: 'course',
    navigator: { onLine: true }, storage: {}, db: {}, console: { error() {} },
    document: { getElementById: id => ({ vaccinationUploadStatus: status, uploadDocumentControls: controls })[id] },
    setTimeout(callback, ms) { const id = ++timerSequence; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    ref: (storage, fullPath) => ({ fullPath }),
    uploadBytesResumable(storageRef, file, metadata) {
      const task = {
        storageRef, file, metadata, cancelled: false, unsubscribed: false,
        snapshot: { ref: storageRef },
        on(event, next, error, complete) {
          this.next = next; this.error = error; this.complete = complete;
          return () => { this.unsubscribed = true; };
        },
        cancel() { this.cancelled = true; return true; }
      };
      uploads.push(task);
      return task;
    },
    getDownloadURL: async () => 'https://example.test/card.jpg',
    serverTimestamp: () => ({ serverTimestamp: true }),
    collection: (db, name) => name,
    doc: (db, collection, id) => ({ collection, id }),
    addDoc: async (collection, data) => { saved.push({ collection, data }); return { id: 'document' }; },
    updateDoc: async (reference, data) => { saved.push({ reference, data }); },
    loadVaccinationDocuments: uid => loaded.push(uid),
    notifyDialog: message => messages.push(message),
    ...overrides
  };
  vm.createContext(context);
  vm.runInContext(uploadSource, context);
  function fireTimer(ms) {
    const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms);
    assert.ok(entry, `Expected a ${ms} ms timer`);
    timers.delete(entry[0]);
    entry[1].callback();
  }
  return { context, input, status, controls, button, text, timers, uploads, saved, messages, loaded, fireTimer };
}

test('photo uploads show progress, save the course, and block duplicate submissions', async () => {
  const f = setup();
  const pending = f.context.handleUpload(f.input);
  assert.equal(f.context.storage.maxUploadRetryTime, 120000);
  assert.equal(f.context.storage.maxOperationRetryTime, 30000);
  assert.equal(f.input.disabled, true);
  assert.equal(f.button.disabled, true);
  assert.equal(f.controls.attributes['aria-busy'], 'true');
  f.uploads[0].next({ bytesTransferred: 50, totalBytes: 100 });
  assert.match(f.status.textContent, /50%/);
  await f.context.handleUpload(f.input);
  assert.equal(f.uploads.length, 1);
  f.uploads[0].complete();
  await pending;
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].data.resident_uid, 'resident');
  assert.equal(f.saved[0].data.vaccination_session_id, 'course');
  assert.equal(f.saved[0].data.download_url, 'https://example.test/card.jpg');
  assert.equal(Object.hasOwn(f.saved[0].data, 'id'), false);
  assert.equal(f.uploads[0].unsubscribed, true);
  assert.equal(f.status.isError, false);
  assert.match(f.status.textContent, /uploaded successfully/);
  assert.deepEqual(f.loaded, ['resident']);
  assert.equal(f.input.disabled, false);
  assert.equal(f.input.value, '');
  assert.equal(f.button.disabled, false);
  assert.equal(f.controls.attributes['aria-busy'], 'false');
  assert.equal(f.timers.size, 0);
});

test('a stalled transfer is cancelled and late progress cannot overwrite the error', async () => {
  const f = setup();
  const pending = f.context.handleUpload(f.input);
  f.fireTimer(45000);
  await pending;
  assert.equal(f.uploads[0].cancelled, true);
  assert.equal(f.uploads[0].unsubscribed, true);
  assert.equal(f.saved.length, 0);
  assert.equal(f.status.isError, true);
  assert.match(f.status.textContent, /stopped responding/);
  const failure = f.status.textContent;
  f.uploads[0].next({ bytesTransferred: 100, totalBytes: 100 });
  assert.equal(f.status.textContent, failure);
  assert.equal(f.input.disabled, false);
  assert.equal(f.timers.size, 0);
});

test('only transferred bytes extend the timeout so retries at zero cannot hang indefinitely', async () => {
  const f = setup();
  const pending = f.context.handleUpload(f.input);
  const initialTimer = [...f.timers.keys()][0];
  f.uploads[0].next({ bytesTransferred: 0, totalBytes: 100 });
  assert.equal([...f.timers.keys()][0], initialTimer);
  f.uploads[0].next({ bytesTransferred: 20, totalBytes: 100 });
  assert.notEqual([...f.timers.keys()][0], initialTimer);
  f.uploads[0].complete();
  await pending;
  assert.equal(f.uploads[0].cancelled, false);
});

test('storage permission failures show an actionable error and unlock the picker', async () => {
  const f = setup();
  const pending = f.context.handleUpload(f.input);
  f.uploads[0].error({ code: 'storage/unauthorized' });
  await pending;
  assert.match(f.status.textContent, /permission/);
  assert.match(f.messages[0], /sign in again/);
  assert.equal(f.status.isError, true);
  assert.equal(f.saved.length, 0);
  assert.equal(f.input.disabled, false);
  assert.equal(f.timers.size, 0);
});

test('a stalled download URL request also exits the busy state', async () => {
  const f = setup({ getDownloadURL: () => new Promise(() => {}) });
  const pending = f.context.handleUpload(f.input);
  f.uploads[0].complete();
  await flush();
  assert.match(f.status.textContent, /Preparing document/);
  f.fireTimer(30000);
  await pending;
  assert.equal(f.status.isError, true);
  assert.equal(f.input.disabled, false);
  assert.equal(f.saved.length, 0);
  assert.equal(f.timers.size, 0);
});

test('an offline queued record reports waiting and stays locked until acknowledged', async () => {
  let acknowledge;
  let writes = 0;
  const f = setup({ addDoc: () => { writes++; return new Promise(resolve => { acknowledge = resolve; }); } });
  const pending = f.context.handleUpload(f.input);
  f.uploads[0].complete();
  await flush();
  assert.match(f.status.textContent, /Saving document/);
  f.fireTimer(30000);
  assert.match(f.status.textContent, /Waiting for a connection/);
  assert.equal(f.input.disabled, true);
  await f.context.handleUpload(f.input);
  assert.equal(writes, 1);
  assert.equal(f.uploads.length, 1);
  acknowledge();
  await pending;
  assert.match(f.status.textContent, /uploaded successfully/);
  assert.equal(f.input.disabled, false);
  assert.equal(f.timers.size, 0);
});

test('JPEG files with an empty browser MIME type use matching upload metadata', async () => {
  const f = setup();
  f.input.files[0] = { name: 'card.JPEG', type: '', size: 100 };
  const pending = f.context.handleUpload(f.input);
  assert.equal(f.uploads[0].metadata.contentType, 'image/jpeg');
  f.uploads[0].complete();
  await pending;
  assert.equal(f.saved[0].data.file_type, 'image/jpeg');
});

test('oversized, unsupported, and offline files do not start a network upload', async () => {
  const f = setup();
  f.input.files[0].size = 11 * 1024 * 1024;
  await f.context.handleUpload(f.input);
  assert.match(f.messages.pop(), /10 MB/);
  f.input.files[0] = { name: 'card.heic', type: 'image/heic', size: 100 };
  await f.context.handleUpload(f.input);
  assert.match(f.messages.pop(), /PDF, JPG, or PNG/);
  f.input.files[0] = { name: 'card.jpg', type: 'image/jpeg', size: 100 };
  f.context.navigator.onLine = false;
  await f.context.handleUpload(f.input);
  assert.equal(f.uploads.length, 0);
  assert.equal(f.input.disabled, false);
  assert.equal(f.status.isError, true);
  assert.equal(f.timers.size, 0);
});
