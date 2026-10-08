import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeRuntimeEnvironment } from '../../modules/runtimeEnvironment.js';

const [root, mode] = process.argv.slice(2);
const profile = path.join(root, 'profile');
const data = path.join(root, 'actual data');
const display = path.join(root, 'display alias');
const outside = path.join(root, 'outside');
for (const dir of [profile, data, display, outside]) fs.mkdirSync(dir);
const envFile = path.join(mode === 'desktop' ? profile : root, '.env');
const hash = 'scrypt$65536$8$1$c2FsdA$aGFzaA';
const revision = 'a'.repeat(32);
let secretSetting = '';
if (mode === 'desktop') {
  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(profile, '.gharmonize-key'), key.toString('base64'), { mode: 0o600 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('SPOTIFY_CLIENT_SECRET'));
  const encrypted = Buffer.concat([cipher.update('previous-account-secret'), cipher.final()]);
  secretSetting = `SPOTIFY_CLIENT_SECRET=enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}\n`;
}
fs.writeFileSync(envFile, `DATA_DIR="${mode === 'docker' ? '/host/path-that-is-not-mounted' : data}"\nOUTPUTS_DISPLAY_DIR="${display}"\nLOCAL_INPUT_DIR=library\nADMIN_PASSWORD_HASH=${hash}\nGHARMONIZE_ACCESS_REVISION=${revision}\nRETAG_ONLINE_METADATA=0\n${secretSetting}`);
process.env.ENV_USER_PATH = envFile;
if (mode === 'docker') process.env.DATA_DIR = data;
if (mode === 'desktop') {
  process.env.GHARMONIZE_DESKTOP_TOKEN = 'runtime-fixture-desktop-token';
  process.env.GHARMONIZE_TEST_PROFILE_DIR = profile;
  process.resourcesPath = path.join(root, 'resources');
  fs.mkdirSync(path.join(process.resourcesPath, 'app.asar'), { recursive: true });
  fs.writeFileSync(path.join(process.resourcesPath, 'app.asar', '.env.default'), 'DATA_DIR=\nOUTPUTS_DISPLAY_DIR=\n');
  // Import the production desktop initializer with only the Electron app API
  // substituted; no user GUI, profile, or running AppImage is touched.
  await import('../../electron/runtimeEnvironment.mjs');
}
if (mode === 'desktop-dev') {
  process.env.GHARMONIZE_TEST_PACKAGED = '0';
  await import('../../electron/runtimeEnvironment.mjs');
}
initializeRuntimeEnvironment();
assert.equal(process.env.DATA_DIR, data);
assert.equal(process.env.LOCAL_INPUT_DIR, path.join(data, 'library'));
assert.equal(process.env.ENV_USER_PATH, envFile);
for (const child of ['outputs', 'temp', 'library']) fs.mkdirSync(path.join(data, child));
fs.writeFileSync(path.join(data, 'outputs', 'present.mp3'), 'actual storage');
fs.writeFileSync(path.join(display, 'present.mp3'), 'wrong display alias');

const { default: express } = await import('express');
const { default: download } = await import('../../routes/download.js');
const { default: retag } = await import('../../routes/retag.js');
const { default: settings } = await import('../../modules/settings.js');
const { OUTPUT_ROOT_DIR, resolveJobOutputDir, toDownloadPath } = await import('../../modules/outputPaths.js');
const { deriveSessionSecret, encryptSecret, decryptSecret } = await import('../../modules/security.js');
assert.equal(OUTPUT_ROOT_DIR, path.join(data, 'outputs'));
const playlist = { format: 'mp3', metadata: { isPlaylist: true, frozenTitle: 'Fixture playlist' } };
assert.ok(resolveJobOutputDir(playlist).startsWith(OUTPUT_ROOT_DIR + path.sep));
assert.equal(toDownloadPath(path.join(OUTPUT_ROOT_DIR, 'present.mp3')), '/download/present.mp3');
assert.ok(fs.existsSync(path.join(data, 'cache'))); // The actual job store.
if (mode === 'desktop') {
  assert.equal(process.env.SPOTIFY_CLIENT_SECRET, 'previous-account-secret');
  assert.equal(process.env.GHARMONIZE_MASTER_KEY_FILE, path.join(profile, '.gharmonize-key'));
  const encrypted = encryptSecret('unchanged-account-secret', 'SPOTIFY_CLIENT_SECRET');
  assert.equal(decryptSecret(encrypted, 'SPOTIFY_CLIENT_SECRET'), 'unchanged-account-secret');
  assert.ok(!fs.existsSync(path.join(data, '.gharmonize-key')));
}
const payload = Buffer.from(JSON.stringify({ iat: Date.now(), role: 'admin', sg: 1 })).toString('base64url');
const mac = crypto.createHmac('sha256', deriveSessionSecret()).update(payload).digest('base64url');
const headers = { cookie: `gharmonize_admin_session=${payload}.${mac}` };
const app = express();
app.use(express.json());
app.use(download);
app.use(retag);
app.use('/api', settings);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  const location = await (await fetch(`${url}/api/outputs/location`)).json();
  assert.equal(location.outputDir, OUTPUT_ROOT_DIR);
  assert.equal(location.displayDir, display);
  assert.equal(await (await fetch(`${url}/download/present.mp3`)).text(), 'actual storage');
  assert.equal((await fetch(`${url}/download/%2e%2e%2foutside/file.mp3`)).status, 400);
  const response = await fetch(`${url}/api/settings`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { MEDIA_COMMENT: 'runtime-path-fixture', DATA_DIR: outside } })
  });
  assert.equal(response.status, 200);
  assert.ok(fs.readFileSync(envFile, 'utf8').includes('MEDIA_COMMENT=runtime-path-fixture'));
  assert.ok(!fs.existsSync(path.join(data, '.env')));
  assert.equal(process.env.DATA_DIR, data); // Browser input cannot relocate roots.
  assert.equal((await fetch(`${url}/api/retag/directories`)).status, 401);
  const roots = await (await fetch(`${url}/api/retag/directories`, { headers })).json();
  assert.ok(roots.roots.some((entry) => entry.path === OUTPUT_ROOT_DIR));
  assert.ok(roots.roots.some((entry) => entry.path === path.join(data, 'library')));
  assert.ok(!roots.roots.some((entry) => entry.path === display));
  const forbidden = await fetch(`${url}/api/retag/directories?path=${encodeURIComponent(outside)}`, { headers });
  assert.equal(forbidden.status, 403);
  if (mode === 'desktop') {
    const desktopHeaders = { 'x-gharmonize-desktop-token': process.env.GHARMONIZE_DESKTOP_TOKEN };
    assert.equal((await fetch(`${url}/api/retag/directories?path=${encodeURIComponent(outside)}`, { headers: desktopHeaders })).status, 200);
  }
  process.env.RETAG_ROOTS = path.join(data, 'library');
  assert.equal((await fetch(`${url}/api/retag/directories?path=${encodeURIComponent(OUTPUT_ROOT_DIR)}`, { headers })).status, 403);
  // An explicit music mount remains the only allowed web retag root.
  console.log('RUNTIME_PATHS_OK');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
// The production store intentionally retains a GC timer; this isolated probe
// has closed its server and must not wait an hour for that timer.
process.exit(0);
