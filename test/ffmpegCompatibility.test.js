import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { archivedFfmpegCandidates, compatibilityFfmpegAssets, ffmpegSdkTier, nvencAvailableApi, stableFfmpegAssets } from '../modules/ffmpegCompatibility.js';
import { execFileSafe, spawnSafe } from '../modules/safeProcess.js';

const digest = `sha256:${'a'.repeat(64)}`;
const linux = { token: 'linux64', extension: '.tar.xz' };
const windows = { token: 'win64', extension: '.zip' };
function asset(name) { return { name, digest, browser_download_url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/test/${name}` }; }
function release(date, names, extra = {}) {
  return { tag_name: `autobuild-${date}`, published_at: `${date}T12:00:00Z`, assets: names.map(asset), ...extra };
}

test('FFmpeg compatibility candidates match platform, static GPL and release versions, not master/shared assets', () => {
  const r = release('2026-08-31', [
    'ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz',
    'ffmpeg-n9.0.1-11-ge47273f4d9-linux64-gpl-9.0.tar.xz',
    'ffmpeg-n8.1.2-50-g1a748fe2cd-win64-gpl-8.1.zip',
    'ffmpeg-n9.0.1-linux64-gpl-shared-9.0.tar.xz',
    'ffmpeg-N-126342-gf88b741dbf-linux64-gpl.tar.xz',
    'ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz',
  ]);
  assert.deepEqual(stableFfmpegAssets(r, linux).map((a) => a.name), r.assets.slice(0, 2).reverse().map((a) => a.name));
  assert.deepEqual(stableFfmpegAssets(r, windows).map((a) => a.name), [r.assets[2].name]);
  assert.deepEqual(stableFfmpegAssets(r, null), []);
});

test('archive discovery is bounded, spaces snapshots and requires a verified digest', () => {
  const name = 'ffmpeg-n8.1.2-linux64-gpl-8.1.tar.xz';
  const releases = ['2026-09-30', '2026-08-31', '2026-08-30', '2026-07-31', '2026-06-30', '2026-05-31'].map((d) => release(d, [name]));
  const latest = release('2026-10-09', [name]);
  assert.deepEqual(archivedFfmpegCandidates(releases.reverse(), latest, linux).map((c) => c.release.tag_name), [
    'autobuild-2026-08-31', 'autobuild-2026-07-31', 'autobuild-2026-06-30',
  ]);
  assert.deepEqual(archivedFfmpegCandidates(releases, {}, linux), []);
  const invalid = release('2026-08-31', [name]);
  delete invalid.assets[0].digest;
  assert.deepEqual(archivedFfmpegCandidates([invalid, { ...invalid, draft: true }], latest, linux), []);
  assert.deepEqual(archivedFfmpegCandidates(releases, latest, windows), []);
});

test('SDK bands follow provider policy, and API 11.1 selects legacy without trying every modern version', () => {
  const r = release('2026-10-09', ['9.1', '9.0', '8.2', '8.1', '8.0', '7.1', '6.1'].map((v) => `ffmpeg-n${v}-latest-linux64-gpl-${v}.tar.xz`));
  assert.deepEqual(compatibilityFfmpegAssets(r, linux).map((a) => ffmpegSdkTier(a.name)), ['13.1', '13.0', '11.1']);
  assert.deepEqual(compatibilityFfmpegAssets(r, linux, '13.0').map((a) => ffmpegSdkTier(a.name)), ['13.0', '11.1']);
  assert.deepEqual(compatibilityFfmpegAssets(r, linux, '11.1').map((a) => a.name), [r.assets[5].name]);
  assert.deepEqual(compatibilityFfmpegAssets(r, linux, '11.0'), []);
  assert.equal(ffmpegSdkTier('ffmpeg-master-latest-win64-gpl.zip'), '13.1');
  assert.equal(ffmpegSdkTier('custom-build'), null);
  const old = { ...r, published_at: '2026-08-31T12:00:00Z', tag_name: 'autobuild-2026-08-31' };
  assert.equal(archivedFfmpegCandidates([old], r, linux, { bySdk: true, availableApi: '11.1' })[0].asset.name, r.assets[5].name);
});

test('NVENC runtime API is parsed from driver failure or loaded-version diagnostics, not driver guesses', () => {
  assert.equal(nvencAvailableApi('Required: 13.1 Found: 13.0'), '13.0');
  assert.equal(nvencAvailableApi('[h264_nvenc] Loaded Nvenc version 11.1'), '11.1');
  assert.equal(nvencAvailableApi('Cannot load libcuda.so.1'), null);
  assert.equal(nvencAvailableApi('Driver 580.178.04'), null);
});

test('an explicit missing FFmpeg/FFprobe path cannot execute a host PATH binary', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-no-ffmpeg-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const file = path.join(root, tool);
    await assert.rejects(promisify(execFileSafe)(file, ['-version']), { code: 'ENOENT' });
    assert.throws(() => spawnSafe(file, ['-version']), { code: 'ENOENT' });
    fs.mkdirSync(file);
    assert.throws(() => spawnSafe(file, ['-version']), /not a regular file/);
  }
});

for (const mode of ['compatible', 'lower-branch', 'rollback', 'all-fail', 'all-basic-fail', 'broken-primary', 'bad-digest', 'offline', 'no-gpu', 'no-encoder', 'legacy-system', 'explicit', 'modern', 'sdk-legacy', 'sdk-legacy-archive', 'master-compatible', 'master-incompatible', 'master-no-gpu', 'switch-master', 'switch-stable', 'compat-network-fail']) {
  test(`real desktop binary initializer: ${mode}`, { skip: process.platform === 'win32' }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-ffmpeg-init-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.resolve('test/fixtures/ffmpegCompatibility.mjs'), root, mode,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.match(stdout, /FFMPEG_COMPATIBILITY_OK/);
  });
}
