// Opt-in Electron smoke test. Run under dbus-run-session + Xvfb so neither the
// user's tray nor their desktop profile/system theme is changed.
const { app, Tray, nativeImage, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gharmonize-tray-icons-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const root = path.resolve(__dirname, '../..');

function opaquePixel(image) {
  const bitmap = image.toBitmap({ scaleFactor: 1 });
  const channels = [[], [], []];
  for (let i = 0; i < bitmap.length; i += 4) {
    if (bitmap[i + 3] === 255) {
      for (let channel = 0; channel < 3; channel++) channels[channel].push(bitmap[i + channel]);
    }
  }
  assert.ok(channels[0].length, 'Icon must contain visible opaque pixels');
  // Lanczos edge ringing affects the first opaque edge pixel. Check the median
  // of the solid glyph instead of depending on which edge the scan hits first.
  return channels.map(values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]);
}

function checkColor(image, expected) {
  // Small monochrome glyphs can shift slightly when Skia resamples transparent
  // edges. Verify the actual light/dark appearance, not exact color bytes.
  const actual = opaquePixel(image);
  const matches = expected[0] === 255
    ? actual.every(value => value >= 240)
    : actual.every(value => value < 100) && actual[0] > actual[1] && actual[1] > actual[2];
  assert.ok(matches,
    `Expected color ${expected}, received ${actual}`);
}

(async () => {
  await app.whenReady();
  const { createPackage } = await import('@electron/asar');
  const staged = path.join(profile, 'staged');
  fs.mkdirSync(staged);
  fs.copyFileSync(path.join(root, 'electron/trayIcon.mjs'), path.join(staged, 'trayIcon.mjs'));
  fs.cpSync(path.join(root, 'electron/assets'), path.join(staged, 'assets'), { recursive: true });
  const archive = path.join(profile, 'tray-test.asar');
  await createPackage(staged, archive);
  const results = [];
  for (const [build, directory] of [['development', path.join(root, 'electron')], ['asar', archive]]) {
    const { createTrayIconManager, TRAY_ICON_MODES } = await import(pathToFileURL(path.join(directory, 'trayIcon.mjs')).href);
    for (const platform of ['linux', 'win32']) {
      const theme = Object.assign(new EventEmitter(), {
        shouldUseDarkColors: false, shouldUseDarkColorsForSystemIntegratedUI: true
      });
      const warnings = [];
      const manager = createTrayIconManager({ nativeImage, nativeTheme: theme, platform,
        assetDir: path.join(directory, 'assets'), originalIconPath: path.join(root, 'build/icon.png'),
        onWarning: (...args) => warnings.push(args) });
      const tray = new Tray(manager.getImage());
      try {
        manager.attach(tray);
        for (const mode of ['dark', 'light']) {
          manager.setMode(mode);
          const image = manager.getImage();
          assert.equal(image.isEmpty(), false);
          assert.equal(image.getSize().width, platform === 'win32' ? 16 : 24);
          assert.deepEqual(image.getScaleFactors(), [1, 1.25, 1.5, 2, 3, 4]);
          checkColor(image, mode === 'light' ? [255, 255, 255] : [53, 41, 35]);
        }
        const dark = (() => { manager.setMode('dark'); return manager.getImage(); })();
        manager.setMode('auto');
        checkColor(manager.getImage(), platform === 'win32' ? [255, 255, 255] : [53, 41, 35]);
        theme.shouldUseDarkColors = true;
        theme.emit('updated');
        checkColor(manager.getImage(), [255, 255, 255]);
        theme.shouldUseDarkColors = false;
        theme.shouldUseDarkColorsForSystemIntegratedUI = false;
        theme.emit('updated');
        assert.equal(manager.getImage(), dark);
        const menu = Menu.buildFromTemplate([{ label: 'Tray icon', submenu: TRAY_ICON_MODES.map(mode => ({
          label: mode, type: 'radio', checked: manager.mode === mode,
          click: () => manager.setMode(mode)
        })) }]);
        tray.setContextMenu(menu);
        assert.equal(menu.items[0].submenu.items.filter(item => item.checked).length, 1);
        assert.equal(menu.items[0].submenu.items[3].checked, true);
        manager.setMode('original');
        assert.equal(manager.getImage(), path.join(root, 'build/icon.png'));
        assert.deepEqual(warnings, []);
        results.push({ build, platform, icons: 'original/dark/light/auto', dpi: '1–4x' });
      } finally { manager.dispose(); tray.destroy(); }
      assert.equal(theme.listenerCount('updated'), 0);
    }
  }
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'tray icons never create an extra renderer');
  console.log(JSON.stringify({ status: 'TRAY_ICON_ELECTRON_OK', results }));
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
