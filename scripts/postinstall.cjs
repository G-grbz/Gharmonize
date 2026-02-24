const { execSync } = require('node:child_process');

const flag =
  process.env.BUILD_ELECTRON === '1' ||
  String(process.env.npm_config_build_electron || '').toLowerCase() === 'true';

if (!flag) {
  console.log('post-installation: electron-builder dependency installation skipped (BUILD_ELECTRON!=1).');
  process.exit(0);
}

try {
  console.log('Post-installation: electron-builder dependency installation begins…');
  execSync('npx electron-builder install-app-deps', { stdio: 'inherit', shell: true });
  console.log('postinstall: electron-builder dependency installation completed.');
} catch (err) {
  console.error('post installation: electron-builder installation failed:', err?.message || err);
  process.exit(1);
}
