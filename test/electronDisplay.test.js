import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual startup display policy without starting Electron or
// touching the user's real profile/window/server.
function displayPolicy(env) {
  const source = fs.readFileSync('electron/main.mjs', 'utf8');
  const start = source.indexOf("if (process.platform === 'linux') {");
  const end = source.indexOf('const TRACK_EXTRACTOR_VIDEO_EXTS', start);
  let disables = 0;
  const switches = [];
  vm.runInNewContext(source.slice(start, end), {
    process: { platform: 'linux', env },
    LINUX_DESKTOP_ID: 'gharmonize', LINUX_DESKTOP_FILE: 'gharmonize.desktop',
    console: { log() {} },
    app: { commandLine: { appendSwitch(...args) { switches.push(args); } }, setDesktopName() {}, disableHardwareAcceleration() { disables++; } }
  });
  return { disables, switches };
}

test('AppImage and Linux desktop keep default GPU compositing, independent of FFmpeg/NVENC', () => {
  for (const env of [{}, { APPIMAGE: '/tmp/Gharmonize.AppImage' }, { APPIMAGE: '/tmp/Gharmonize.AppImage', GHARMONIZE_DISABLE_HARDWARE_ACCELERATION: '0' }]) {
    assert.equal(displayPolicy(env).disables, 0);
  }
});

test('explicit software rendering remains available without overriding display backend selection', () => {
  for (const value of ['1', 'true', 'yes', 'on', ' TRUE ']) {
    const result = displayPolicy({ GHARMONIZE_DISABLE_HARDWARE_ACCELERATION: value, GHARMONIZE_OZONE_PLATFORM: 'x11' });
    assert.equal(result.disables, 1);
    assert.deepEqual(result.switches[1], ['ozone-platform', 'x11']);
  }
  assert.equal(displayPolicy({ GHARMONIZE_DISABLE_HARDWARE_ACCELERATION: 'false' }).disables, 0);
});
