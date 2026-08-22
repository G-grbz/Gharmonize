import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertSafeRemoteUrl,
  decryptSecret,
  encryptSecret,
  hashPassword,
  ipInCidr,
  isPrivateIp,
  isSafeExternalUrl,
  parseSafeYtDlpExtra,
  passwordPolicyError,
  verifyPassword
} from '../modules/security.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-security-'));
process.env.DATA_DIR = temp;
delete process.env.GHARMONIZE_MASTER_KEY;
delete process.env.GHARMONIZE_MASTER_KEY_FILE;

test('scrypt password hash verifies correct password', () => {
  const hash = hashPassword('Gharmonize9');
  assert.equal(verifyPassword('Gharmonize9', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
});
test('password policy requires 8 chars, uppercase and number', () => {
  assert.ok(passwordPolicyError('short1A'));
  assert.ok(passwordPolicyError('gharmonize9'));
  assert.ok(passwordPolicyError('GHARMONIZE'));
  assert.equal(passwordPolicyError('Gharmonize9'), '');
});
test('AES-GCM encrypted secret round-trips and hides plaintext', () => {
  const enc = encryptSecret('super-secret-value', 'TEST');
  assert.ok(enc.startsWith('enc:v1:'));
  assert.equal(enc.includes('super-secret-value'), false);
  assert.equal(decryptSecret(enc, 'TEST'), 'super-secret-value');
});
test('master key file is created with restrictive permissions', () => {
  const p = path.join(temp, '.gharmonize-key');
  assert.equal(fs.existsSync(p), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});
test('IPv4 trusted CIDR matching works', () => {
  assert.equal(ipInCidr('192.168.1.5','192.168.1.0/24'), true);
  assert.equal(ipInCidr('192.168.2.5','192.168.1.0/24'), false);
});
test('IPv6 trusted CIDR matching works', () => {
  assert.equal(ipInCidr('::1','::1/128'), true);
  assert.equal(ipInCidr('fd00::1','fd00::/8'), true);
});
test('private IP detection covers loopback and RFC1918', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','::1','fd00::1']) assert.equal(isPrivateIp(ip), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});
test('SSRF guard rejects localhost literal', async () => {
  await assert.rejects(() => assertSafeRemoteUrl('http://127.0.0.1:8080/test'));
});
test('SSRF guard rejects non-http schemes', async () => {
  await assert.rejects(() => assertSafeRemoteUrl('file:///etc/passwd'));
});
test('unsafe yt-dlp execution flags are blocked', () => {
  assert.throws(() => parseSafeYtDlpExtra('--exec calc --force-ipv4'));
  assert.throws(() => parseSafeYtDlpExtra('--external-downloader=curl'));
});
test('normal yt-dlp tuning flags remain allowed', () => {
  assert.deepEqual(parseSafeYtDlpExtra('--force-ipv4 --socket-timeout 10'), ['--force-ipv4','--socket-timeout','10']);
});
test('Electron external URL policy blocks file/javascript schemes', () => {
  assert.equal(isSafeExternalUrl('https://github.com/G-grbz/Gharmonize'), true);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('file:///etc/passwd'), false);
});
test('HTML contains no inline script or inline event handlers', () => {
  for (const file of ['public/index.html','public/ytlive.html']) {
    const text = fs.readFileSync(file,'utf8');
    assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(text), false, `${file} has inline script`);
    assert.equal(/\son(?:click|error|load)\s*=/i.test(text), false, `${file} has inline event handler`);
  }
});
test('default env ships without a known admin password', () => {
  const text = fs.readFileSync('.env.default','utf8');
  assert.equal(/ADMIN_PASSWORD\s*=\s*123456/.test(text), false);
});
test('CSP contains core anti-XSS directives', () => {
  const text = fs.readFileSync('app.js','utf8');
  for (const directive of ["script-src 'self' https://www.youtube.com https://s.ytimg.com","script-src-attr 'none'","object-src 'none'","frame-ancestors 'none'","frame-src https://www.youtube.com https://www.youtube-nocookie.com"]) assert.ok(text.includes(directive));
});
test('chunk and completed upload paths are constrained to the upload root', () => {
  const text = fs.readFileSync('routes/jobs.js', 'utf8');
  assert.ok(text.includes('normalizeUploadId'));
  assert.ok(text.includes('safeUploadOriginalName'));
  assert.ok(text.includes('isPathInsideRoot(UPLOAD_DIR, candidate)'));
  assert.ok(text.includes('isPathInsideRoot(UPLOAD_DIR, finalPath)'));
});

test('disc device and filesystem operations require admin authentication', () => {
  const text = fs.readFileSync('routes/disc.js', 'utf8');
  for (const route of ['stream', 'scan', 'cancel-scan', 'rip', 'cancel-rip', 'metadata']) {
    const re = new RegExp(`router\\.(?:get|post)\\(\\"/api/disc/${route}\\",\\s*requireAuth`);
    assert.match(text, re, `${route} must require admin auth`);
  }
});

test('build-time binary downloader is HTTPS-only and verifies available SHA-256 digests', () => {
  const text = fs.readFileSync('scripts/download-binaries.mjs', 'utf8');
  assert.equal(text.includes("import http from 'http'"), false);
  assert.ok(text.includes("parsed.protocol !== 'https:'"));
  assert.ok(text.includes('resolveGithubAssetDigest'));
  assert.ok(text.includes('SHA-256 mismatch'));
});

test('forwarded protocol is honored only through Express trusted-proxy resolution', () => {
  const app = fs.readFileSync('app.js', 'utf8');
  const settings = fs.readFileSync('modules/settings.js', 'utf8');
  assert.equal(app.includes("req.get('x-forwarded-proto') === 'https'"), false);
  assert.equal(settings.includes("req.get('x-forwarded-proto') === 'https'"), false);
});


test('sandboxed Electron preload uses CommonJS and stays bridged', () => {
  const main = fs.readFileSync(path.join('electron', 'main.mjs'), 'utf8');
  const preload = fs.readFileSync(path.join('electron', 'preload.cjs'), 'utf8');
  assert.ok(main.includes("sandbox: true"));
  assert.ok(main.includes("preload.cjs"));
  assert.ok(preload.includes("require('electron')"));
  assert.ok(preload.includes("contextBridge.exposeInMainWorld('electronAPI'"));
  assert.equal(fs.existsSync(path.join('electron', 'preload.mjs')), false);
});

test('Linux tray stays on Electron 42 and fails safe on broken Electron 43 runtime', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const main = fs.readFileSync(path.join('electron', 'main.mjs'), 'utf8');
  const dependabot = fs.readFileSync(path.join('.github', 'dependabot.yml'), 'utf8');

  assert.equal(pkg.devDependencies.electron, '^42.5.0');
  assert.equal(lock.packages['node_modules/electron'].version, '42.9.3');
  assert.ok(main.includes('function hasKnownBrokenLinuxTrayRuntime()'));
  assert.ok(main.includes("return major === 43;"));
  assert.ok(main.includes("[tray] unavailable; closing Gharmonize instead of leaving a hidden background process"));
  assert.ok(main.includes("start-minimized requested, but tray is unavailable; showing the main window instead"));
  assert.ok(dependabot.includes('versions: ["43.x"]'));
});
