import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const [root, mode] = process.argv.slice(2);
const cache = path.join(root, 'Cache', 'binaries');
const resources = path.join(root, 'resources');
const hostBin = path.join(root, 'host-bin');
for (const dir of [cache, resources, hostBin]) fs.mkdirSync(dir, { recursive: true });
Object.defineProperty(process.versions, 'electron', { value: 'test' });
process.resourcesPath = resources;
process.env.DATA_DIR = root;
process.env.GHARMONIZE_DESKTOP_DATA_DIR = root;
process.env.GHARMONIZE_WEB_BINARIES = '1';
process.env.GHARMONIZE_WEB_BINARIES_IN_DOCKER = '1';
process.env.GHARMONIZE_FFMPEG_CHANNEL = mode.startsWith('master-') || mode === 'switch-stable' ? 'master' : 'stable';
delete process.env.GHARMONIZE_WEB_CACHE_DIR;
delete process.env.GHARMONIZE_BINARY_TMP_DIR;
delete process.env.FFMPEG_BIN;
delete process.env.FFPROBE_BIN;
for (const tool of ['YTDLP', 'DENO', 'MKVMERGE', 'MKVPROPEDIT']) process.env[`${tool}_BIN`] = path.join(root, 'configured', tool.toLowerCase());
process.env.PATH = `${hostBin}${path.delimiter}${process.env.PATH}`;

function fakePair(dir, version, nvencWorks, host = false) {
  fs.mkdirSync(dir, { recursive: true });
  for (const tool of ['ffmpeg', 'ffprobe']) {
    fs.writeFileSync(path.join(dir, tool), `#!${process.execPath}
${host ? `require('fs').writeFileSync(${JSON.stringify(path.join(root, 'host-used'))}, 'wrong');` : ''}
const args = process.argv.slice(2);
if (args.includes('-version')) console.log('${tool} version ${version}');
else if (args.includes('-encoders')) console.log(${JSON.stringify(mode === 'no-encoder' ? 'A....D pcm_s16le' : 'V....D h264_nvenc')});
else if (args.includes('-c:a')) {
  if (${JSON.stringify(mode === 'all-basic-fail' || (mode === 'broken-primary' && version === '9.0'))}) process.exit(1);
}
else if (${JSON.stringify(nvencWorks)} !== true) {
  console.error(${JSON.stringify(['no-gpu', 'master-no-gpu'].includes(mode) ? 'Cannot load libcuda.so.1' : `Driver does not support the required nvenc API version. Required: 13.1 Found: ${mode.startsWith('sdk-legacy') ? '11.1' : '13.0'}`)});
  process.exit(1);
}
`, { mode: 0o700 });
  }
}
fakePair(hostBin, 'host', true, true);
if (mode === 'explicit') {
  process.env.FFMPEG_BIN = path.join(hostBin, 'ffmpeg');
  process.env.FFPROBE_BIN = path.join(hostBin, 'ffprobe');
}
if (mode === 'legacy-system') {
  fs.writeFileSync(path.join(cache, 'metadata.json'), JSON.stringify({
    ffmpeg: { path: path.join(hostBin, 'ffmpeg'), source: 'system' },
    ffprobe: { path: path.join(hostBin, 'ffprobe'), source: 'system' },
  }));
}
if (mode === 'rollback') {
  fakePair(cache, '8.1-known-good', true);
  fs.writeFileSync(path.join(cache, 'metadata.json'), JSON.stringify({
    ffmpeg: { path: path.join(cache, 'ffmpeg'), source: 'btbn-stable', validation: { nvenc: { ok: true } } },
    ffprobe: { path: path.join(cache, 'ffprobe') },
  }));
}

const archives = new Map();
function makeRelease(date, version, compatible) {
  const name = version === 'master' ? 'ffmpeg-master-latest-linux64-gpl.tar.xz' : `ffmpeg-n${version}-latest-linux64-gpl-${version}.tar.xz`;
  const directory = path.join(root, `release-${date}`);
  fakePair(path.join(directory, 'bundle', 'bin'), version, compatible);
  const file = path.join(root, `${date}.tar.xz`);
  execFileSync('tar', ['-cJf', file, '-C', directory, 'bundle']);
  const bytes = fs.readFileSync(file);
  const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-${date}/${name}`;
  archives.set(url, bytes);
  return {
    tag_name: `autobuild-${date}`, published_at: `${date}T12:00:00Z`,
    assets: [{ name, browser_download_url: url, digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` }],
  };
}
const latest = makeRelease('2026-10-09', '9.0', mode === 'modern');
if (mode.startsWith('master-') || mode.startsWith('switch-')) latest.assets.push(...makeRelease('2026-10-09', 'master', mode === 'master-compatible').assets);
if (['lower-branch', 'switch-master', 'switch-stable', 'sdk-legacy'].includes(mode)) latest.assets.push(...makeRelease('2026-10-09', '8.1', mode !== 'sdk-legacy').assets);
if (mode === 'sdk-legacy') {
  latest.assets.push(...makeRelease('2026-10-09', '8.0', false).assets);
  latest.assets.push(...makeRelease('2026-10-09', '7.1', true).assets);
}
const old = makeRelease('2026-08-31', '8.1', !['all-fail', 'bad-digest'].includes(mode));
const older = makeRelease('2026-07-31', '7.1', mode !== 'all-fail');
if (mode === 'sdk-legacy-archive') old.assets.push(...makeRelease('2026-08-31', '7.1', true).assets);
if (mode === 'bad-digest') old.assets[0].digest = `sha256:${'a'.repeat(64)}`;
const requests = [];
let offline = mode === 'offline';
globalThis.fetch = async (url) => {
  requests.push(url);
  if (offline || (mode === 'compat-network-fail' && url.includes('per_page'))) throw new Error('fixture offline');
  if (url === 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest') return Response.json(latest);
  if (url === 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=30') return Response.json([latest, old, older]);
  assert.ok(archives.has(url), `unexpected network request: ${url}`);
  return new Response(archives.get(url));
};
const binaries = await import('../../modules/binaries.js');
if (mode !== 'explicit') {
  assert.equal(binaries.FFMPEG_BIN, path.join(cache, 'ffmpeg'));
  assert.equal(binaries.FFPROBE_BIN, path.join(cache, 'ffprobe'));
}
const result = await binaries.initializeDynamicBinaries();
if (mode === 'explicit') {
  assert.equal(requests.length, 0);
  assert.equal(result.ffmpegPath, process.env.FFMPEG_BIN);
} else if (['all-basic-fail', 'offline'].includes(mode)) {
  assert.equal(binaries.getDynamicBinariesStatus().tools.ffmpeg.status, 'error');
  assert.equal(result.ffmpegPath, path.join(cache, 'ffmpeg'));
  assert.ok(!fs.existsSync(result.ffmpegPath));
  const { execFileSafe } = await import('../../modules/safeProcess.js');
  assert.throws(() => execFileSafe(result.ffmpegPath, ['-version']), { code: 'ENOENT' });
} else {
  assert.equal(binaries.getDynamicBinariesStatus().tools.ffmpeg.status, 'ready');
  assert.equal(result.ffmpegPath, path.join(cache, 'ffmpeg'));
  assert.equal(result.ffprobePath, path.join(cache, 'ffprobe'));
  const metadata = JSON.parse(fs.readFileSync(path.join(cache, 'metadata.json')));
  const softwareModes = ['all-fail', 'no-gpu', 'no-encoder', 'master-incompatible', 'master-no-gpu', 'compat-network-fail', 'switch-stable'];
  assert.equal(metadata.ffmpeg.validation.nvenc.ok, !softwareModes.includes(mode));
  assert.equal(metadata.ffmpeg.validation.basic, true);
  assert.ok(requests.some((url) => archives.has(url)), 'the managed FFmpeg archive must actually be downloaded');
  assert.ok(fs.existsSync(result.ffmpegPath), 'FFmpeg must be installed even without NVENC');
  assert.ok(fs.existsSync(result.ffprobePath), 'FFprobe must be installed even without NVENC');
  assert.ok(fs.existsSync(path.join(cache, 'ffmpeg-lkg')));
  assert.ok(fs.existsSync(path.join(cache, 'ffprobe-lkg')));
  if (mode === 'bad-digest') assert.match(metadata.ffmpeg.assetName, /n7.1/);
  if (mode === 'lower-branch') {
    assert.match(metadata.ffmpeg.assetName, /n8.1/);
    assert.equal(requests.some((url) => url.includes('per_page')), false, 'current compatible branch should avoid archive discovery');
  }
  if (mode.startsWith('sdk-legacy')) {
    assert.match(metadata.ffmpeg.assetName, /n7.1/);
    assert.equal(requests.some((url) => /n8[.]|n9[.]/.test(url)), true, 'initial latest must be tested');
    assert.equal(requests.some((url) => /n8[.]/.test(url)), false, 'API 11.1 must skip incompatible SDK 13.0 downloads');
  }
  if (mode === 'all-fail' || mode === 'compat-network-fail') {
    assert.equal(metadata.ffmpeg.source, 'btbn-software');
    assert.equal(metadata.ffmpeg.validation.nvenc.ok, false);
    assert.match(metadata.ffmpeg.assetName, /n9.0/);
  }
  if (mode.startsWith('master-') || mode === 'switch-stable') {
    assert.equal(metadata.ffmpeg.source, 'btbn-master');
    assert.equal(requests.some((url) => url.includes('per_page')), false, 'master must not downgrade to archived stable');
  }
  if (mode === 'rollback') assert.equal(requests.some((url) => url.includes('per_page')), false);
  {
    const count = requests.length;
    await binaries.initializeDynamicBinaries();
    assert.equal(requests.length, count, 'warm startup redownloaded rejected candidate');
    await binaries.initializeDynamicBinaries({ force: true });
    assert.ok(requests.length > count, 'manual refresh must bypass cached rejection');
  }
  if (mode.startsWith('switch-')) {
    const newChannel = mode === 'switch-master' ? 'master' : 'stable';
    process.env.GHARMONIZE_FFMPEG_CHANNEL = newChannel;
    await binaries.initializeDynamicBinaries();
    const updated = JSON.parse(fs.readFileSync(path.join(cache, 'metadata.json')));
    assert.equal(updated.ffmpeg.requestedChannel, newChannel);
    assert.equal(updated.ffmpeg.source, newChannel === 'master' ? 'btbn-master' : 'btbn-compatible');
    const count = requests.length;
    await binaries.initializeDynamicBinaries();
    assert.equal(requests.length, count, 'switched channel must stay cached');
  }
  offline = true;
  const offlineResult = await binaries.initializeDynamicBinaries({ force: true });
  assert.equal(binaries.getDynamicBinariesStatus().tools.ffmpeg.status, 'ready');
  assert.ok(fs.existsSync(offlineResult.ffmpegPath), 'offline update must retain a usable cached pair');
}
assert.ok(!fs.existsSync(path.join(root, 'host-used')), 'implicit host FFmpeg was executed');
assert.ok(!fs.existsSync(path.join(cache, 'ffmpeg-candidate')));
assert.ok(!fs.existsSync(path.join(cache, 'ffprobe-candidate')));
assert.equal(fs.readdirSync(cache).some((name) => /extract-|\.tar\.xz|\.download$/.test(name)), false, 'owned extraction/archive staging was not cleaned');
console.log('FFMPEG_COMPATIBILITY_OK');
