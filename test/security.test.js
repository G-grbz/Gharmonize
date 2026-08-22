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
  resolvePathInside,
  sanitizeLogValue,
  verifyPassword
} from '../modules/security.js';
import { assertSafeProcessArgs, assertTrustedExecutable } from '../modules/safeProcess.js';
import { rateLimit } from '../modules/rateLimit.js';

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


test('release workflow preserves Linux artifact name for publish collection', () => {
  const workflow = fs.readFileSync(path.join('.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(workflow.includes('name: release-linux'));
  assert.ok(workflow.includes('pattern: release-*'));
  assert.equal(workflow.includes('archive: false'), false);
});


test('filesystem boundary rejects traversal outside an allowed root', () => {
  const root = path.join(temp, 'root');
  fs.mkdirSync(root, { recursive: true });
  assert.equal(resolvePathInside(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  assert.throws(() => resolvePathInside(root, '../escape.txt'));
});

test('log sanitizer removes line breaks and control characters', () => {
  assert.equal(sanitizeLogValue('safe\nFORGED\rline\u0000'), 'safe FORGED line?');
});

test('custom rate limiter allows the configured quota and rejects the next request', () => {
  const limiter = rateLimit(2, 60_000);
  const request = { ip: 'codeql-test-client' };
  const responses = Array.from({ length: 3 }, () => ({
    headers: new Map(),
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers.set(name, value); },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  }));
  let allowed = 0;

  limiter(request, responses[0], () => { allowed += 1; });
  limiter(request, responses[1], () => { allowed += 1; });
  limiter(request, responses[2], () => { allowed += 1; });

  assert.equal(allowed, 2);
  assert.equal(responses[2].statusCode, 429);
  assert.equal(responses[2].body?.error, 'TOO_MANY_REQUESTS');
  assert.equal(responses[2].headers.get('RateLimit-Remaining'), '0');
});

test('safe process layer rejects dangerous arguments and unknown executables', () => {
  assert.throws(() => assertSafeProcessArgs('yt-dlp', ['--exec=touch /tmp/pwned']));
  assert.throws(() => assertSafeProcessArgs('ffmpeg', ['ok\n--evil']));
  assert.throws(() => assertTrustedExecutable('/tmp/not-gharmonize-tool'));
  assert.equal(assertTrustedExecutable('/usr/bin/ffmpeg'), '/usr/bin/ffmpeg');
});

test('critical process sinks are routed through the safe process layer', () => {
  const files = [
    'app.js', 'modules/yt.js', 'modules/sp.js', 'modules/media.js', 'modules/trackExtractor.js',
    'modules/ringtone.js', 'modules/probe.js', 'modules/lyrics.js', 'modules/discScanner.js',
    'modules/discRipper.js', 'modules/ffmpegCaps.js', 'modules/binaries.js', 'modules/binariesInfo.js'
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/from\s+["'](?:node:)?child_process["']/.test(text), false, `${file} bypasses safeProcess`);
  }
});

test('provider fetches enforce fixed HTTPS origins and controlled redirects', () => {
  const spotify = fs.readFileSync('modules/spotify.js', 'utf8');
  const apple = fs.readFileSync('modules/apple.js', 'utf8');
  const deezer = fs.readFileSync('modules/deezer.js', 'utf8');
  assert.ok(spotify.includes('new URL("https://open.spotify.com/")'));
  assert.ok(spotify.includes('redirect: "error"'));
  assert.ok(apple.includes('host !== "music.apple.com" && host !== "embed.music.apple.com"'));
  assert.ok(apple.includes('redirect: "manual"'));
  assert.ok(deezer.includes('host !== "api.deezer.com"'));
  assert.ok(deezer.includes('redirect: "manual"') || deezer.includes('redirect: "error"'));
});

test('browser URL handling avoids substring-host checks and javascript hrefs', () => {
  const classic = fs.readFileSync('public/ui/MediaConverterApp.js', 'utf8');
  const ytlive = fs.readFileSync('public/ui/YTLiveMusicApp.js', 'utf8');
  assert.equal(/host\.includes\(['"][^'"]+\.(?:com|ly|am)['"]\)/.test(classic), false);
  assert.equal(/host\.includes\(['"][^'"]+\.(?:com|ly|am)['"]\)/.test(ytlive), false);
  assert.ok(ytlive.includes('function safeExternalHttpUrl'));
  assert.ok(ytlive.includes("url.protocol !== 'https:' && url.protocol !== 'http:'"));
});

test('stream selection modal escapes probe-provided stream metadata', () => {
  const upload = fs.readFileSync('public/ui/UploadManager.js', 'utf8');
  assert.ok(upload.includes('const escapeHtml = (value)'));
  assert.ok(upload.includes('escapeHtml(stream.codec_long)'));
  assert.ok(upload.includes('escapeHtml(stream.title)'));
  assert.ok(upload.includes("fileNameEl.textContent = displayFileName"));
});

test('temporary state files use randomized exclusive creation', () => {
  for (const file of ['modules/store.js', 'modules/ytliveDownloadLists.js', 'modules/mappedMusicCache.js']) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('crypto.randomBytes'), `${file} lacks randomized temp names`);
    assert.ok(text.includes("flag: \"wx\"") || text.includes("flag: 'wx'"), `${file} lacks exclusive temp creation`);
  }
  const binaries = fs.readFileSync('modules/binaries.js', 'utf8');
  assert.equal(binaries.includes('path.join(os.tmpdir(), "gharmonize-web-bin")'), false);
  assert.ok(binaries.includes('fs.mkdtempSync(path.join(os.tmpdir(), "gharmonize-web-bin-"))'));
});

test('CodeQL suppressions stay coupled to explicit security controls', () => {
  const jsFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) jsFiles.push(full);
    }
  };
  for (const dir of ['app.js', 'modules', 'routes', 'scripts']) {
    if (fs.statSync(dir).isDirectory()) walk(dir);
    else jsFiles.push(dir);
  }

  for (const file of jsFiles) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes('codeql[js/missing-rate-limiting]')) continue;
      assert.ok(lines[i].includes('rateLimit('), `${file}:${i + 1} suppresses rate limiting without inline rateLimit middleware`);
    }
  }

  for (const file of jsFiles) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const markerAt = lines[i].indexOf('codeql[js/');
      if (markerAt < 0) continue;
      const executablePrefix = lines[i].slice(0, markerAt).replace(/\/\/\s*$/, '').trim();
      assert.ok(executablePrefix, `${file}:${i + 1} has a detached CodeQL suppression`);
    }
  }

  const safeProcess = fs.readFileSync('modules/safeProcess.js', 'utf8');
  assert.equal((safeProcess.match(/codeql\[js\/command-line-injection\]/g) || []).length, 3);
  assert.ok(safeProcess.includes('assertTrustedExecutable(command)'));
  assert.ok(safeProcess.includes('assertSafeProcessArgs(executable, args)'));
  assert.ok(safeProcess.includes('shell: false'));
});

test('download subdirectory parsing avoids regex processing of untrusted path text', () => {
  const text = fs.readFileSync('routes/download.js', 'utf8');
  assert.ok(text.includes('for (const ch of src)'));
  assert.ok(text.includes('ch === "/" || ch === "\\\\"'));
  assert.equal(text.includes('replace(/^[/\\\\]+/'), false);
});

test('YouTube Music cookie forwarding is domain-scoped and strips control characters', () => {
  const text = fs.readFileSync('modules/yt.js', 'utf8');
  assert.ok(text.includes('const domainMatches = host === domain || host.endsWith(`.${domain}`)'));
  assert.ok(text.includes('.replace(/\\r/g, "")'));
  assert.ok(text.includes('.replace(/\\n/g, "")'));
  assert.ok(text.includes('codeql[js/file-access-to-http]'));
  assert.ok(text.includes('`${YTM_ORIGIN}/youtubei/v1/search?prettyPrint=false`'));
});

test('media output and remote thumbnail writes remain confined and bounded', () => {
  const text = fs.readFileSync('modules/media.js', 'utf8');
  assert.ok(text.includes('outputDir = assertPathWithinAny('));
  assert.ok(text.includes('path.relative(outputDir, candidate)'));
  assert.ok(text.includes('const maxCoverBytes = 25 * 1024 * 1024'));
  assert.ok(text.includes('if (buf.byteLength > maxCoverBytes) return null'));
});
