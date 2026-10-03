const test = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB } = require('fake-indexeddb');
const R = require('../recording.js');
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(extra = {}) {
  let clock = 0;
  const parts = [], errors = [], recorders = [];
  const track = { stopped: 0, listeners: {}, stop() { this.stopped++; }, addEventListener(type, fn) { this.listeners[type] = fn; } };
  class Recorder {
    constructor(stream, options) { this.state = 'inactive'; this.mimeType = options.mimeType || 'video/webm'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable({ data: new Blob(['independent container'], { type: this.mimeType }) });
        this.onstop();
      });
    }
  }
  let finishReason;
  const session = new R.RecorderSession({
    stream: { getTracks: () => [track] }, Recorder, now: () => clock,
    setInterval: () => 1, clearInterval: () => {},
    onPart: async (blob, part) => parts.push({ blob, ...part }),
    onError: (error, blob) => errors.push({ error, blob }),
    onFinish: reason => { finishReason = reason; }, ...extra
  });
  return { session, parts, errors, recorders, track, get reason() { return finishReason; }, advance(ms) { clock += ms; session.tick(); } };
}

for (const kind of ['video', 'voice']) {
  test(`${kind}: completes 12 hours as 720 independently finalized one-minute files`, async () => {
    const h = harness({ recorderOptions: { mimeType: `${kind === 'video' ? 'video' : 'audio'}/webm` } });
    h.session.start();
    for (let minute = 1; minute <= 720; minute++) { h.advance(60000); await settle(); }
    assert.equal(h.parts.length, 720);
    assert.equal(h.reason, 'time');
    assert.equal(h.session.active, false);
    assert.equal(h.track.stopped, 1);
    for (let i = 0; i < h.parts.length; i++) {
      assert.equal(h.parts[i].index, i);
      assert.equal(h.parts[i].startMs, i * 60000);
      assert.equal(h.parts[i].endMs, (i + 1) * 60000);
      assert.ok(h.parts[i].blob.size > 0);
    }
  });
}

test('manual stop saves the final partial file and releases capture', async () => {
  const h = harness(); h.session.start(); h.advance(61000); await settle(); h.advance(23000); h.session.stop(); await settle();
  assert.equal(h.parts.length, 2);
  assert.equal(h.parts[1].endMs, 84000);
  assert.equal(h.reason, 'user'); assert.equal(h.session.active, false);
  h.session.stop(); assert.equal(h.track.stopped, 1);
});

test('file byte limit rotates without ending the recording session', async () => {
  const h = harness({ partBytes: 4 }); h.session.start(); h.advance(1000);
  h.recorders[0].ondataavailable({ data: new Blob(['1234']) }); await settle();
  assert.equal(h.recorders.length, 2); assert.equal(h.parts.length, 1); assert.equal(h.session.active, true);
  h.session.stop(); await settle();
});

test('local quota failure stops capture and exposes the unsaved blob for recovery', async () => {
  const h = harness({ onPart: async () => { throw new Error('QuotaExceededError'); } });
  h.session.start(); h.advance(60000); await settle(); await settle();
  assert.equal(h.reason, 'storage'); assert.equal(h.session.active, false);
  assert.ok(h.errors.some(item => item.blob && item.blob.size));
});

test('camera disconnection saves final data and stops recording', async () => {
  const h = harness(); h.session.start(); h.advance(7000); h.track.listeners.ended(); await settle();
  assert.equal(h.reason, 'device'); assert.equal(h.parts.length, 1); assert.equal(h.session.active, false);
});

test('encoder rotation failure saves existing data and cleans up the stream', async () => {
  let created = 0;
  class FailingRecorder {
    constructor() { if (++created === 2) throw new Error('Encoder failed'); this.mimeType = 'video/webm'; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable({ data: new Blob(['video']) }); this.onstop(); }); }
  }
  const h = harness({ Recorder: FailingRecorder }); h.session.start(); h.advance(60000); await settle();
  assert.equal(h.reason, 'error'); assert.equal(h.parts.length, 1); assert.equal(h.track.stopped, 1);
});

test('saved files regroup in numerical order, retain duration, and flag missing parts', () => {
  const path = index => R.partPath('user', '2026-10-03', 'video', 'session-uuid', { index, startMs: index * 60000, endMs: (index + 1) * 60000, type: 'video/webm' });
  const groups = R.groupParts([{ path: path(2) }, { path: 'old.webm', duration: '0:20' }, { path: path(0) }, { path: path(1) }]);
  assert.equal(groups.length, 2); assert.equal(groups[0].duration, '3:00'); assert.equal(groups[0].missing, false);
  assert.deepEqual(groups[0].parts.map(item => R.parsePartPath(item.path).index), [0, 1, 2]);
  assert.equal(R.groupParts([{ path: path(2) }])[0].missing, true);
  assert.equal(groups[1].duration, '0:20'); assert.equal(R.formatDuration(43200), '12:00:00');
});

test('IndexedDB preserves offline files across queue recreation and retries without losing ownership', async () => {
  const store = R.createIndexedDBStore(indexedDB);
  let user = 'owner', online = false, uploads = 0;
  const options = { store, getUserId: () => user, upload: async part => { uploads++; if (!online) throw new Error('Offline'); assert.equal(part.userId, user); return { id: part.id }; } };
  const first = new R.DurableQueue(options);
  await first.enqueue({ id: 'part-one', userId: 'owner', blob: new Blob(['recorded data']) }); await first.flush();
  assert.equal(await store.count('owner'), 1);
  const restored = new R.DurableQueue({ ...options, store: R.createIndexedDBStore(indexedDB) });
  user = 'other'; online = true; const before = uploads; await restored.flush();
  assert.equal(uploads, before); assert.equal(await store.count('owner'), 1);
  user = 'owner'; await restored.flush(); assert.equal(await store.count('owner'), 0);
});

test('queue never discards the local file when upload succeeds but local removal fails', async () => {
  let retained = { id: 'stable', userId: 'owner' }, calls = 0, allowRemove = false;
  const ids = [];
  const queue = new R.DurableQueue({ getUserId: () => 'owner',
    store: { put: async () => {}, next: async () => retained, remove: async () => { if (!allowRemove) throw new Error('Disk busy'); retained = null; } },
    upload: async part => { calls++; ids.push(part.id); return {}; }
  });
  await queue.flush(); assert.ok(retained); allowRemove = true; await queue.flush();
  assert.equal(retained, null); assert.equal(calls, 2); assert.deepEqual(ids, ['stable', 'stable']);
});

function cameraHarness({ playError, empty = false } = {}) {
  let stopped = false, removed = false, requested;
  const video = { style: {}, readyState: 2, videoWidth: 640, videoHeight: 360,
    setAttribute() {}, play: () => playError ? Promise.reject(playError) : Promise.resolve(), pause() {}, remove() { removed = true; } };
  const doc = { body: { appendChild() {} }, createElement: type => type === 'video' ? video : {
    getContext: () => ({ drawImage() {} }), toBlob: callback => callback(empty ? null : new Blob(['jpeg'], { type: 'image/jpeg' }))
  } };
  const options = { document: doc, facingMode: { exact: 'environment' },
    getUserMedia: async constraints => { requested = constraints; return { getTracks: () => [{ stop() { stopped = true; } }] }; },
    setTimeout: (fn, ms) => ms === 260 ? setTimeout(fn, 0) : setTimeout(fn, ms), clearTimeout
  };
  return { options, get stopped() { return stopped; }, get removed() { return removed; }, get requested() { return requested; }, video };
}

test('camera captures a JPEG with an exact back-camera request and closes its stream', async () => {
  const h = cameraHarness(); const blob = await R.capturePhoto(h.options);
  assert.equal(blob.type, 'image/jpeg'); assert.ok(blob.size); assert.equal(h.stopped, true); assert.equal(h.removed, true);
  assert.deepEqual(h.requested.video.facingMode, { exact: 'environment' }); assert.equal(h.video.srcObject, null);
});

test('camera preview rejection always closes camera and removes preview', async () => {
  const h = cameraHarness({ playError: new Error('Preview denied') }); h.video.readyState = 0;
  await assert.rejects(R.capturePhoto(h.options), /Preview denied/); assert.equal(h.stopped, true); assert.equal(h.removed, true);
});

test('empty camera photos fail without leaving the camera running', async () => {
  const h = cameraHarness({ empty: true }); await assert.rejects(R.capturePhoto(h.options), /empty/);
  assert.equal(h.stopped, true); assert.equal(h.removed, true);
});

function frameHarness() {
  const track = new EventTarget(); track.readyState = 'live'; track.muted = false;
  const video = new EventTarget();
  Object.assign(video, { readyState: 0, videoWidth: 0, videoHeight: 0, muted: false, playsInline: false,
    setAttribute() {}, play: () => Promise.resolve(), pause() { this.paused = true; } });
  return { track, video, stream: { getVideoTracks: () => [track] } };
}

test('video recording readiness waits for an actual camera image', async () => {
  const h = frameHarness(); let ready = false;
  const waiting = R.waitForCamera(h.stream, h.video, { timeoutMs: 1000 }).then(() => { ready = true; });
  await settle(); assert.equal(ready, false);
  Object.assign(h.video, { readyState: 2, videoWidth: 640, videoHeight: 360 });
  h.video.dispatchEvent(new Event('loadeddata')); await waiting;
  assert.equal(ready, true); assert.equal(h.video.srcObject, h.stream); assert.equal(h.video.muted, true);
});

test('camera that never supplies an image times out instead of loading forever', async () => {
  const h = frameHarness();
  await assert.rejects(R.waitForCamera(h.stream, h.video, { timeoutMs: 10 }), /did not deliver an image/);
  assert.equal(h.video.srcObject, null); assert.equal(h.video.paused, true);
});

test('camera preview playback failure returns a recoverable error', async () => {
  const h = frameHarness(); h.video.play = () => Promise.reject(new Error('Playback blocked'));
  await assert.rejects(R.waitForCamera(h.stream, h.video), /Playback blocked/);
  assert.equal(h.video.srcObject, null);
});

test('missing camera video track cannot be mistaken for successful video recording', async () => {
  const h = frameHarness();
  await assert.rejects(R.waitForCamera({ getVideoTracks: () => [] }, h.video), /no active video track/);
});

function playlistHarness(sign) {
  const fs = require('node:fs'), vm = require('node:vm');
  const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  const start = html.indexOf('  function recordingPlaylist(');
  const end = html.indexOf('  async function deleteRecordingGroup(', start);
  const createElement = () => Object.assign(new EventTarget(), {
    children: [], style: {}, value: '', setAttribute() {}, getAttribute() { return this.src; },
    appendChild(child) { this.children.push(child); }
  });
  const player = createElement();
  Object.assign(player, { paused: true, currentTime: 0, pause() { this.paused = true; },
    play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); } });
  const controls = createElement(), messages = [];
  const items = [0, 1, 2].map(index => ({
    path: R.partPath('owner', '2026-10-03', 'video', 'playlist', { index, startMs: index * 60000, endMs: (index + 1) * 60000, type: 'video/webm' }), url: 'blob:part-' + index
  }));
  const group = R.groupParts(items)[0];
  vm.runInNewContext(html.slice(start, end) + '\nrecordingPlaylist(player, group, controls);', {
    player, group, controls, document: { createElement }, LongRecording: R, activeEntry: null,
    fmtDuration: R.formatDuration, signedUrlsFor: sign, showToast: message => messages.push(message)
  });
  return { player, controls, items, messages, seek: controls.children[2], position: controls.children[0] };
}

test('playlist selection keeps the chosen part during loading and ignores stale URL requests', async () => {
  const requests = [];
  const h = playlistHarness(paths => new Promise(resolve => requests.push({ paths, resolve })));
  h.seek.value = '2'; h.seek.dispatchEvent(new Event('change'));
  assert.equal(h.seek.value, '2');
  h.seek.dispatchEvent(new Event('change'));
  requests[0].resolve({ [requests[0].paths[0]]: 'blob:stale' }); await settle();
  requests[1].resolve({ [requests[1].paths[0]]: 'blob:last-part' }); await settle();
  assert.equal(h.player.src, 'blob:last-part'); assert.equal(h.seek.value, '2');
  assert.match(h.position.textContent, /Part 3\/3/); assert.equal(h.seek.disabled, false);
});

test('playlist URL failure restores the previous part and enables retry', async () => {
  const h = playlistHarness(async () => { throw new Error('Network unavailable'); });
  h.seek.value = '2'; h.seek.dispatchEvent(new Event('change')); await settle();
  assert.equal(h.player.src, 'blob:part-0'); assert.equal(h.seek.value, '0');
  assert.equal(h.seek.disabled, false); assert.equal(h.messages.length, 1);
});
