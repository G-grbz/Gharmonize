import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createTrayIconManager, normalizeTrayIconMode, trayIconVariant, TRAY_ICON_MODES } from '../electron/trayIcon.mjs';

function fixture(platform = 'linux', empty = false) {
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const loads = [], changes = [], warnings = [];
  const nativeImage = {
    createFromPath(filename) {
      loads.push(filename);
      return { isEmpty: () => empty, resize: options => ({ toPNG: () => ({ filename, ...options }) }) };
    },
    createEmpty() {
      return { representations: [], isEmpty() { return !this.representations.length; },
        addRepresentation(value) { this.representations.push(value); } };
    }
  };
  const manager = createTrayIconManager({ nativeImage, nativeTheme, platform,
    assetDir: '/fixture/electron/assets', originalIconPath: '/fixture/icon.original',
    onWarning: (...args) => warnings.push(args) });
  const tray = { setImage: image => changes.push(image), isDestroyed: () => false };
  return { manager, nativeTheme, loads, changes, warnings, tray };
}

test('tray icon modes are allowlisted; missing and invalid preferences preserve the original icon', () => {
  assert.deepEqual(TRAY_ICON_MODES, ['original', 'dark', 'light', 'auto']);
  for (const invalid of [undefined, null, '', 'system', '../outside', {}, true]) {
    assert.equal(normalizeTrayIconMode(invalid), 'original');
  }
  const f = fixture();
  f.manager.setMode('../../outside');
  assert.equal(f.manager.getImage(), '/fixture/icon.original');
  assert.equal(f.loads.length, 0);
});

test('automatic mode contrasts with the system theme and Windows follows taskbar rather than app colors', () => {
  assert.equal(trayIconVariant('auto', { shouldUseDarkColors: false }, 'linux'), 'dark');
  assert.equal(trayIconVariant('auto', { shouldUseDarkColors: true }, 'linux'), 'light');
  assert.equal(trayIconVariant('auto', { shouldUseDarkColors: false, shouldUseDarkColorsForSystemIntegratedUI: true }, 'win32'), 'light');
  assert.equal(trayIconVariant('auto', { shouldUseDarkColors: true, shouldUseDarkColorsForSystemIntegratedUI: false }, 'win32'), 'dark');
  assert.equal(trayIconVariant('auto', { shouldUseDarkColors: true }, 'win32'), 'light');
  for (const mode of ['original', 'dark', 'light']) {
    assert.equal(trayIconVariant(mode, { shouldUseDarkColors: true }, 'linux'), mode);
    assert.equal(trayIconVariant(mode, { shouldUseDarkColors: false }, 'win32'), mode);
  }
});

test('both platforms load bundled PNG assets once and cache standard/high-DPI native representations', () => {
  for (const platform of ['win32', 'linux']) {
    const f = fixture(platform);
    f.manager.setMode('dark');
    const dark = f.manager.getImage();
    assert.equal(f.loads.length, 1);
    assert.equal(path.basename(f.loads[0]), 'gharmonize-tray-dark.png');
    assert.equal(dark.representations.length, 6);
    for (const { scaleFactor, buffer } of dark.representations) {
      assert.equal(buffer.width, (platform === 'win32' ? 16 : 24) * scaleFactor);
      assert.equal(buffer.height, buffer.width);
    }
    assert.equal(f.manager.getImage(), dark);
    f.manager.setMode('light');
    assert.notEqual(f.manager.getImage(), dark);
    f.manager.setMode('dark');
    assert.equal(f.manager.getImage(), dark);
    assert.equal(f.loads.length, 2);
  }
});

test('live theme changes update automatic mode only, do not recreate the tray, and listeners are cleaned up', () => {
  const f = fixture();
  f.manager.attach(f.tray);
  f.manager.attach(f.tray);
  assert.equal(f.nativeTheme.listenerCount('updated'), 1);
  for (const mode of ['original', 'dark', 'light']) {
    f.manager.setMode(mode);
    const before = f.changes.length;
    f.nativeTheme.shouldUseDarkColors = !f.nativeTheme.shouldUseDarkColors;
    f.nativeTheme.emit('updated');
    assert.equal(f.changes.length, before);
  }
  f.manager.setMode('auto');
  const before = f.changes.length;
  f.nativeTheme.shouldUseDarkColors = !f.nativeTheme.shouldUseDarkColors;
  f.nativeTheme.emit('updated');
  assert.equal(f.changes.length, before + 1);
  f.nativeTheme.emit('updated');
  assert.equal(f.changes.length, before + 1, 'unchanged theme must not repaint the native icon');
  f.manager.dispose();
  assert.equal(f.nativeTheme.listenerCount('updated'), 0);
  f.nativeTheme.emit('updated');
  assert.equal(f.changes.length, before + 1);
});

test('missing custom icons fall back to the original; failed native updates keep the existing tray alive', () => {
  const f = fixture('linux', true);
  f.manager.setMode('light');
  assert.equal(f.manager.getImage(), '/fixture/icon.original');
  assert.equal(f.manager.mode, 'light');
  assert.equal(f.warnings.length, 1);
  f.manager.attach({ setImage() { throw new Error('native failure'); } });
  assert.ok(f.warnings.length >= 2);
  f.manager.dispose();
});

function menuFixture(initialPrefs = {}) {
  const source = fs.readFileSync('electron/main.mjs', 'utf8');
  const start = source.indexOf('async function refreshTrayMenu()');
  const end = source.indexOf('// Handles ensure tray', start);
  const f = fixture();
  let saved = { ...initialPrefs }, menu;
  const context = vm.createContext({
    tray: { setContextMenu(value) { if (value) menu = value; }, setToolTip() {} },
    trayIconManager: f.manager, trayMenu: null, TRAY_ICON_MODES, normalizeTrayIconMode,
    loadPrefs: async () => ({ ...saved }), savePrefs: async prefs => { saved = { ...prefs }; },
    Menu: { buildFromTemplate: items => items }, t: (_key, fallback) => fallback,
    openMainWindow() {}, setAutoStartEnabled() {}, keepAliveInTray: false, isQuitting: false,
    app: { quit() {} }
  });
  vm.runInContext(source.slice(start, end), context);
  return { ...f, refresh: () => context.refreshTrayMenu(),
    get prefs() { return saved; }, get menu() { return menu; } };
}

test('real tray submenu persists all four radio choices, restores them, and preserves other desktop preferences', async () => {
  const f = menuFixture({ language: 'tr', alwaysMinimizeToTray: true, autoStart: true });
  await f.refresh();
  assert.equal(f.menu[1].label, 'Tray icon');
  assert.equal(f.menu[1].submenu.length, 4);
  for (const [index, mode] of TRAY_ICON_MODES.entries()) {
    const entry = f.menu[1].submenu[index];
    assert.equal(entry.type, 'radio');
    await entry.click();
    assert.equal(f.prefs.trayIconMode, mode);
    assert.equal(f.manager.mode, mode);
    assert.equal(f.prefs.language, 'tr');
    assert.equal(f.prefs.autoStart, true);
    assert.equal(f.prefs.alwaysMinimizeToTray, true);
    assert.equal(f.menu[1].submenu.filter(item => item.checked).length, 1);
    assert.equal(f.menu[1].submenu[index].checked, true);
    const restarted = menuFixture(f.prefs);
    await restarted.refresh();
    assert.equal(restarted.manager.mode, mode);
    assert.equal(restarted.menu[1].submenu[index].checked, true);
  }
  const invalid = menuFixture({ trayIconMode: '../../untrusted.svg' });
  await invalid.refresh();
  assert.equal(invalid.menu[1].submenu[0].checked, true);
});

test('tray startup restores the saved icon before construction, coalesces concurrent requests and preserves click toggling', async () => {
  const source = fs.readFileSync('electron/main.mjs', 'utf8');
  const start = source.indexOf('async function ensureTray(win)');
  const end = source.indexOf('// Resolves icon for', start);
  let creates = 0, opens = 0, hides = 0;
  const f = fixture();
  const window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false };
  class FakeTray extends EventEmitter {
    constructor(image) { super(); creates++; this.image = image; }
    setImage(image) { this.image = image; }
    setToolTip() {}
  }
  const context = vm.createContext({
    tray: null, trayMenu: null, trayIconManager: null, creatingTrayPromise: null,
    mainWindowRef: null, lastTrayToggleAt: 0,
    process: { platform: 'linux' }, URL, fileURLToPath,
    hasKnownBrokenLinuxTrayRuntime: () => false, resolveTrayIcon: () => '/fixture/icon.original',
    createTrayIconManager: () => f.manager, nativeImage: {}, nativeTheme: f.nativeTheme,
    loadPrefs: async () => { await Promise.resolve(); return { trayIconMode: 'light' }; },
    refreshTrayMenu: async () => {}, Tray: FakeTray, console: { log() {}, error() {} },
    hideMainWindowToTray: () => { hides++; }, openMainWindow: () => { opens++; }
  });
  vm.runInContext(source.slice(start, end).replaceAll('import.meta.url', JSON.stringify(new URL('../electron/main.mjs', import.meta.url).href)), context);
  const [first, second] = await Promise.all([context.ensureTray(window), context.ensureTray(window)]);
  assert.equal(creates, 1);
  assert.equal(first, second);
  assert.equal(f.manager.mode, 'light');
  assert.notEqual(first.image, '/fixture/icon.original');
  first.emit('click');
  assert.equal(hides, 1);
  first.emit('double-click');
  assert.equal(hides, 1, 'one gesture must not toggle twice');
  context.lastTrayToggleAt = 0;
  window.isVisible = () => false;
  first.emit('click');
  assert.equal(opens, 1);
  f.manager.dispose();
});

test('bundled tray assets and translated menus are included by the desktop packaging configuration', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.ok(pkg.build.files.includes('electron/**'));
  assert.ok(pkg.build.files.includes('public/**'));
  for (const variant of ['dark', 'light']) {
    const png = fs.readFileSync(`electron/assets/gharmonize-tray-${variant}.png`);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 128);
    assert.equal(png.readUInt32BE(20), 128);
    assert.equal(png[25], 6, 'RGBA transparency is retained');
  }
  for (const locale of ['en', 'tr', 'de', 'fr', 'es']) {
    const dict = JSON.parse(fs.readFileSync(`public/lang/${locale}.json`, 'utf8'));
    for (const key of ['tray.icon', ...TRAY_ICON_MODES.map(mode => `tray.icon.${mode}`)]) {
      assert.equal(typeof dict[key], 'string');
      assert.ok(dict[key].length > 0);
    }
  }
});
