const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const mock = fs.readFileSync(path.join(__dirname, 'mock-backend.js'), 'utf8');

async function openApp(page, options = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.addInitScript(({ mapBackCamera }) => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__cameraStreams = [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (mapBackCamera && constraints.video && constraints.video.facingMode && constraints.video.facingMode.exact === 'environment') {
        constraints = { ...constraints, video: { ...constraints.video, facingMode: 'user' } };
      }
      const stream = await getUserMedia(constraints); window.__cameraStreams.push(stream); return stream;
    };
    let library;
    Object.defineProperty(window, 'LongRecording', { configurable: true,
      get: () => library,
      set(value) {
        const Original = value.RecorderSession;
        value.RecorderSession = function(options) { return new Original({ ...options, partSeconds: 1, maxSeconds: 30 }); };
        library = value;
      }
    });
  }, { mapBackCamera: !!options.mapBackCamera });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') {
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return route.fulfill({ body: fs.readFileSync(path.join(root, filename)), contentType: filename.endsWith('.js') ? 'application/javascript' : 'text/html' });
    }
    if (url.pathname.includes('supabase.js')) return route.fulfill({ body: mock, contentType: 'application/javascript' });
    if (url.hostname.includes('radio-browser')) return route.fulfill({ json: [] });
    return route.fulfill({ body: '', contentType: 'text/plain' });
  });
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.locator('#appRoot')).toBeVisible();
  await page.locator('.day[data-key]').first().click();
  await expect(page.locator('#recordVideo')).toBeVisible();
  await expect(page.locator('#voiceList')).toContainText('No voice notes yet');
  return errors;
}

async function savedCount(page, kind) {
  return page.evaluate(kind => (window.__mock.tables.media || []).filter(row => row.kind === kind).length, kind);
}

test('Capture moment takes and saves front/back JPEGs, releases the camera, and reopens saved photos', async ({ page }) => {
  const errors = await openApp(page, { mapBackCamera: true });
  await page.locator('#captureMoment').click();
  await expect(page.locator('#captureMoment')).toBeEnabled();
  await expect(page.locator('#momentPreview img')).toHaveCount(2);
  await expect.poll(() => page.locator('#momentPreview img').evaluateAll(images => images.every(image => image.naturalWidth > 0))).toBe(true);
  expect(await savedCount(page, 'moment_front')).toBe(1); expect(await savedCount(page, 'moment_back')).toBe(1);
  expect(await page.evaluate(() => window.__cameraStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  expect(await page.evaluate(() => window.__mock.uploads.every(upload => upload.type === 'image/jpeg' && upload.bytes > 0))).toBe(true);
  await page.keyboard.press('Escape'); await page.locator('.day[data-key]').first().click();
  await expect(page.locator('#momentPreview img')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('missing rear camera preserves the saved front photo and restores the capture button', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('#captureMoment').click(); await expect(page.locator('#captureMoment')).toBeEnabled();
  await expect(page.locator('#momentPreview img')).toHaveCount(1);
  expect(await savedCount(page, 'moment_front')).toBe(1);
  await expect(page.locator('#toast')).toContainText('no available back camera');
  expect(errors).toEqual([]);
});

test('failed photo upload does not delete the old moment or falsely report success', async ({ page }) => {
  const errors = await openApp(page, { mapBackCamera: true });
  await page.locator('#captureMoment').click(); await expect(page.locator('#momentPreview img')).toHaveCount(2);
  const ids = await page.evaluate(() => window.__mock.tables.media.map(row => row.id));
  await page.evaluate(() => { window.__mock.failUpload = true; });
  await page.locator('#captureMoment').click(); await expect(page.locator('#captureMoment')).toBeEnabled();
  await expect(page.locator('#toast')).toContainText("Couldn't capture or save");
  expect(await page.evaluate(() => window.__mock.tables.media.map(row => row.id))).toEqual(ids);
  expect(errors).toEqual([]);
});

test('camera startup without an image times out and releases the camera instead of spinning', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const wait = LongRecording.waitForCamera;
    LongRecording.waitForCamera = (stream, video) => {
      Object.defineProperty(video, 'readyState', { value: 0, configurable: true });
      return wait(stream, video, { timeoutMs: 100 });
    };
  });
  await page.locator('#recordVideo').click();
  await expect(page.locator('#recordVideo')).toBeEnabled();
  await expect(page.locator('#toast')).toContainText('Camera did not deliver an image');
  await expect(page.locator('#recordingCameraView')).toBeHidden();
  expect(await savedCount(page, 'video')).toBe(0);
  expect(await page.evaluate(() => window.__cameraStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  expect(errors).toEqual([]);
});

for (const [kind, button, label, list, player] of [
  ['video', '#recordVideo', '#videoRecordLabel', '#videoList', 'video'],
  ['voice', '#recordVoice', '#recordLabel', '#voiceList', 'audio']
]) {
  test(`${kind}: camera/microphone records playable files, saves final part, plays in order and deletes all parts`, async ({ page }) => {
    const errors = await openApp(page);
    await page.locator(button).click(); await expect(page.locator(label)).toContainText('Stop recording');
    await expect.poll(() => savedCount(page, kind)).toBeGreaterThanOrEqual(2);
    await page.locator(button).click(); await expect(page.locator(button)).toBeEnabled();
    await expect(page.locator('#recordingSaveStatus')).toContainText('All finished recording parts are saved');
    const count = await savedCount(page, kind); expect(count).toBeGreaterThanOrEqual(3);
    await expect(page.locator(`${list} ${player}`)).toHaveCount(1);
    const media = page.locator(`${list} ${player}`);
    await expect.poll(() => media.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(1);
    expect(await media.evaluate(element => element.error)).toBeNull();
    await media.evaluate(element => element.play());
    if (kind === 'video') {
      await expect.poll(() => media.evaluate(element => {
        if (element.readyState < 2 || !element.videoWidth) return false;
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
        const context = canvas.getContext('2d'); context.drawImage(element, 0, 0, 32, 32);
        return context.getImageData(0, 0, 32, 32).data.some((value, index) => index % 4 !== 3 && value > 20);
      })).toBe(true);
    }
    await expect(page.locator(list)).toContainText('Part 2/');
    await media.evaluate(element => element.pause());
    await page.locator(`${list} input[type=range]`).fill(String(count - 1));
    await page.locator(`${list} input[type=range]`).dispatchEvent('change');
    await expect(page.locator(list)).toContainText(`Part ${count}/${count}`);
    await page.locator(`${list} .del`).click();
    await expect.poll(() => savedCount(page, kind)).toBe(0);
    await expect(page.locator(`${list} ${player}`)).toHaveCount(0);
    expect(await page.evaluate(() => window.__cameraStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('offline recording survives reload and retries saving to the same account without duplicates', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => { window.__mock.failUpload = true; });
  await page.locator('#recordVoice').click(); await expect(page.locator('#recordLabel')).toContainText('Stop recording');
  await expect(page.locator('#recordingSaveStatus')).toContainText('waiting to upload');
  await page.locator('#recordVoice').click(); await expect(page.locator('#recordVoice')).toBeEnabled();
  expect(await savedCount(page, 'voice')).toBe(0);
  await page.reload(); await expect(page.locator('#appRoot')).toBeVisible();
  await expect.poll(() => savedCount(page, 'voice')).toBeGreaterThanOrEqual(2);
  await page.locator('.day[data-key]').first().click(); await expect(page.locator('#voiceList audio')).toHaveCount(1);
  const rows = await page.evaluate(() => window.__mock.tables.media);
  expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
  expect(errors).toEqual([]);
});

test('successful file upload followed by a database failure retries without duplicate media', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => { window.__mock.failInsert = true; });
  await page.locator('#recordVideo').click(); await expect(page.locator('#videoRecordLabel')).toContainText('Stop recording');
  await expect(page.locator('#recordingSaveStatus')).toContainText('waiting to upload');
  await page.locator('#recordVideo').click(); await expect(page.locator('#recordVideo')).toBeEnabled();
  expect(await savedCount(page, 'video')).toBe(0);
  const uploaded = await page.evaluate(() => window.__mock.uploads.length); expect(uploaded).toBeGreaterThanOrEqual(1);
  await page.evaluate(() => { window.__mock.failInsert = false; });
  await page.locator('#retryRecordingUploads').click();
  await expect(page.locator('#recordingSaveStatus')).toContainText('All finished recording parts are saved');
  const rows = await page.evaluate(() => window.__mock.tables.media);
  expect(rows.length).toBeGreaterThanOrEqual(2);
  expect(new Set(rows.map(row => row.storage_path)).size).toBe(rows.length);
  expect(await page.evaluate(() => window.__mock.uploads.length)).toBe(rows.length);
  expect(errors).toEqual([]);
});

test('failed removal keeps recording listed and can be retried', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('#recordVoice').click(); await expect(page.locator('#recordLabel')).toContainText('Stop recording');
  await expect.poll(() => savedCount(page, 'voice')).toBeGreaterThanOrEqual(1);
  await page.locator('#recordVoice').click(); await expect(page.locator('#recordVoice')).toBeEnabled();
  await expect(page.locator('#recordingSaveStatus')).toContainText('All finished recording parts are saved');
  const count = await savedCount(page, 'voice');
  await page.evaluate(() => { window.__mock.failDelete = true; });
  await page.locator('#voiceList .del').click();
  await expect(page.locator('#toast')).toContainText("Couldn't remove every part");
  expect(await savedCount(page, 'voice')).toBe(count);
  await page.evaluate(() => { window.__mock.failDelete = false; });
  await page.locator('#voiceList .del').click(); await expect.poll(() => savedCount(page, 'voice')).toBe(0);
  expect(errors).toEqual([]);
});

for (const kind of ['video', 'voice']) {
  test(`${kind}: app PIN lock and mobile visibility changes preserve recording and saving`, async ({ page }) => {
    const errors = await openApp(page);
    await page.evaluate(() => { window.__mock.pin = '1234'; });
    const button = page.locator(kind === 'video' ? '#recordVideo' : '#recordVoice');
    const label = page.locator(kind === 'video' ? '#videoRecordLabel' : '#recordLabel');
    await button.click(); await expect(label).toContainText('Stop recording');
    if (kind === 'video') {
      await expect(page.locator('#recordingCameraView')).toBeVisible();
      await expect.poll(() => page.locator('#recordingCameraVideo').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
    }
    await page.locator('#visibilitySwitch').click(); await page.locator('#pinInput').fill('1234'); await page.locator('#pinSubmit').click();
    await expect(page.locator('body')).toHaveClass(/background-only/);
    await expect(page.locator('#recordingPill')).toBeHidden();
    await expect(page.locator('#liveCameraView')).toHaveCount(0);
    if (kind === 'video') await expect(page.locator('#recordingCameraView')).toBeHidden();
    await expect.poll(() => savedCount(page, kind)).toBeGreaterThanOrEqual(1);
    const count = await savedCount(page, kind);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android Test Mobile' });
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => savedCount(page, kind)).toBeGreaterThan(count);
    expect(await page.evaluate(() => window.__cameraStreams.at(-1).getTracks().every(track => track.readyState === 'live'))).toBe(true);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.locator('#visibilitySwitch').click(); await page.locator('#pinInput').fill('1234'); await page.locator('#pinSubmit').click();
    await expect(page.locator('body')).not.toHaveClass(/background-only/);
    await button.click(); await expect(button).toBeEnabled();
    await expect(page.locator('#recordingSaveStatus')).toContainText('All finished recording parts are saved');
    if (kind === 'video') await expect(page.locator('#recordingCameraView')).toBeHidden();
    expect(errors).toEqual([]);
  });
}

test('recording exclusivity, permission failure, notes, moods, photos and PIN controls remain usable', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('#recordVoice').click(); await expect(page.locator('#recordLabel')).toContainText('Stop recording');
  await page.locator('#recordVideo').click(); await expect(page.locator('#toast')).toContainText('Stop the current recording');
  await page.locator('#captureMoment').click(); await expect(page.locator('#toast')).toContainText('Stop the current recording');
  await page.locator('#recordVoice').click(); await expect(page.locator('#recordVoice')).toBeEnabled();
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }; });
  await page.locator('#recordVideo').click(); await expect(page.locator('#recordVideo')).toBeEnabled();
  await expect(page.locator('#toast')).toContainText('permission was denied');
  await page.locator('#textNote').fill('Camera testing day');
  await expect.poll(() => page.evaluate(() => (window.__mock.tables.entries || []).some(row => row.note === 'Camera testing day'))).toBe(true);
  await page.locator('.mood-chip').first().click();
  await expect.poll(() => page.evaluate(() => (window.__mock.tables.entries || []).some(row => row.mood === 'joyful'))).toBe(true);
  await page.locator('#photoInput').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=', 'base64') });
  await expect.poll(() => savedCount(page, 'photo')).toBe(1);
  await page.keyboard.press('Escape'); await page.locator('#visibilitySwitch').click();
  await expect(page.locator('#pinTitle')).toContainText('Create your four-digit PIN');
  await page.locator('#pinInput').fill('1234'); await page.locator('#pinConfirmInput').fill('1234'); await page.locator('#pinSubmit').click();
  await expect(page.locator('#pinOverlay')).toBeHidden();
  await page.locator('#visibilitySwitch').click(); await page.locator('#pinInput').fill('1234'); await page.locator('#pinSubmit').click();
  await expect(page.locator('#pinOverlay')).toBeHidden();
  expect(errors).toEqual([]);
});
