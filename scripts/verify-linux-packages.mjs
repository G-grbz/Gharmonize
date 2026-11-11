import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listPackage, extractFile } from '@electron/asar';

// Inspect the installable packages themselves, not only linux-unpacked.
const dist = path.resolve(process.argv[2] || 'dist');
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const formats = [
  { ext: '.deb', metadata: file => run('dpkg-deb', ['--field', file]), extract: (file, dest) => run('dpkg-deb', ['--extract', file, dest]) },
  { ext: '.rpm', metadata: file => run('rpm', ['--query', '--package', '--queryformat', '%{NAME}\n%{VERSION}\n[%{REQUIRENAME}\n]', file]), extract: (file, dest) => run('bsdtar', ['-xf', file, '-C', dest]) },
  { ext: '.pkg.tar.zst', metadata: file => run('bsdtar', ['-xOf', file, '.PKGINFO']), extract: (file, dest) => run('bsdtar', ['-xf', file, '-C', dest]) }
];

for (const format of formats) {
  const files = fs.readdirSync(dist).filter(name => name.startsWith(`Gharmonize-${version}-`) && name.endsWith(format.ext));
  assert.equal(files.length, 1, `Expected one ${format.ext} package for ${version}`);
  const file = path.join(dist, files[0]);
  const metadata = format.metadata(file);
  assert.ok(metadata.includes('gharmonize'), `${files[0]}: package identity`);
  assert.ok(metadata.includes(version), `${files[0]}: package version`);
  assert.match(metadata, /(?:libayatana-appindicator|libappindicator)/, `${files[0]}: tray dependency`);
  if (format.ext === '.pkg.tar.zst') {
    assert.match(metadata, /^pkgdesc = \S.+$/m, 'Arch package description must fit on one metadata line');
    const header = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, header); } finally { fs.closeSync(fd); }
    assert.equal(header.toString('hex'), '28b52ffd', 'Arch package must actually use Zstandard compression');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-package-check-'));
  try {
    format.extract(file, root);
    const appDir = path.join(root, 'opt', 'Gharmonize');
    const binary = path.join(appDir, 'gharmonize');
    fs.accessSync(binary, fs.constants.X_OK);
    const header = Buffer.alloc(4);
    const fd = fs.openSync(binary, 'r');
    try { fs.readSync(fd, header); } finally { fs.closeSync(fd); }
    assert.equal(header.toString('hex'), '7f454c46', 'Native package must launch the Electron ELF executable');
    assert.ok(!fs.existsSync(path.join(appDir, 'AppRun')), 'Native installation must not wrap an AppImage');
    const desktop = fs.readFileSync(path.join(root, 'usr', 'share', 'applications', 'gharmonize.desktop'), 'utf8');
    assert.match(desktop, /^Exec=[^\n]*\/opt\/Gharmonize\/gharmonize(?:\s|$)/m);
    assert.match(desktop, /^StartupWMClass=gharmonize$/m);
    assert.doesNotMatch(desktop, /\.AppImage|npm start|node app\.js/);
    const archive = path.join(appDir, 'resources', 'app.asar');
    const entries = listPackage(archive).map(entry => entry.replaceAll('\\', '/'));
    for (const required of [
      '/bootstrap.mjs', '/app.js', '/electron/main.mjs', '/electron/desktopServer.mjs', '/electron/trayIcon.mjs',
      '/electron/assets/gharmonize-tray-dark.png', '/electron/assets/gharmonize-tray-light.png'
    ]) assert.ok(entries.includes(required), `${files[0]} is missing ${required}`);
    const pkg = JSON.parse(extractFile(archive, 'package.json'));
    assert.equal(pkg.main, 'electron/main.mjs');
    console.log(`Verified ${files[0]}: native Electron launcher, desktop integration and tray assets/dependencies`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
