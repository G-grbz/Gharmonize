const { spawnSync } = require('node:child_process');

const flag =
  process.env.BUILD_ELECTRON === '1' ||
  String(process.env.npm_config_build_electron || '').toLowerCase() === 'true';

if (!flag) {
  console.log('post-installation: electron-builder dependency installation skipped (BUILD_ELECTRON!=1).');
  process.exit(0);
}

console.log('Post-installation: electron-builder dependency installation begins…');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, ['electron-builder', 'install-app-deps'], {
  stdio: 'inherit',
  shell: false,
  windowsHide: true
});
if (result.error || result.status !== 0) {
  console.error('post installation: electron-builder installation failed:', result.error?.message || `exit ${result.status}`);
  process.exit(result.status || 1);
}
console.log('postinstall: electron-builder dependency installation completed.');
