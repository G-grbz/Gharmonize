import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  canCopyAudioInto,
  describeAudioStreamForUi,
  planKeptVideoAudio,
  planKeptVideoAudioStreams
} from '../modules/videoAudioPlan.js';

const eac3 = { codec: 'eac3', channels: 6, sample_rate: 48000, bit_rate: 640000 };
const truehd = { codec: 'truehd', channels: 8, sample_rate: 48000 };

test('without volume/loudnorm the source audio is copied, never turned into AAC', () => {
  assert.deepEqual(planKeptVideoAudio({ format: 'mkv', source: eac3, filtersRequested: false }),
    { mode: 'copy', encoder: 'copy', bitrate: null, applyFilters: false, warning: null });
  assert.equal(planKeptVideoAudio({ format: 'mp4', source: { codec: 'aac', channels: 2 } }).mode, 'copy');
  assert.equal(planKeptVideoAudio({ format: 'mkv', source: truehd }).mode, 'copy');
});

test('with volume/loudnorm the audio is re-encoded in its own codec, bitrate and rate', () => {
  const plan = planKeptVideoAudio({ format: 'mkv', source: eac3, filtersRequested: true });
  assert.equal(plan.mode, 'keep');
  assert.equal(plan.encoder, 'eac3');
  assert.equal(plan.bitrate, '640k');
  assert.equal(plan.sampleRate, 48000);
  assert.equal(plan.applyFilters, true);
  assert.equal(planKeptVideoAudio({ format: 'mp4', source: { codec: 'aac', channels: 2, sample_rate: 44100 }, filtersRequested: true }).sampleRate, 44100);
  assert.equal(planKeptVideoAudio({ format: 'mkv', source: { codec: 'ac3', channels: 6, bit_rate: 900000 }, filtersRequested: true }).bitrate, '640k', 'clamped to the encoder maximum');
});

test('sources that cannot be re-created keep their audio and skip the filters', () => {
  assert.deepEqual(planKeptVideoAudio({ format: 'mkv', source: truehd, filtersRequested: true }).warning, 'filters-skipped:codec');
  assert.equal(planKeptVideoAudio({ format: 'mkv', source: { codec: 'dts', profile: 'DTS-HD MA', channels: 8 }, filtersRequested: true }).warning, 'filters-skipped:hd');
  assert.equal(planKeptVideoAudio({ format: 'mkv', source: { codec: 'eac3', channels: 8 }, filtersRequested: true }).warning, 'filters-skipped:channels');
  // One such stream keeps every selected stream untouched (filters run on all of them).
  const both = planKeptVideoAudioStreams({ format: 'mkv', sources: [eac3, truehd], filtersRequested: true });
  assert.equal(both.applyFilters, false);
  assert.equal(both.allCopy, true);
  assert.deepEqual(both.warnings, ['filters-skipped:codec']);
});

test('containers that cannot carry the source audio get the container default', () => {
  assert.equal(canCopyAudioInto('mp4', 'truehd'), false);
  assert.equal(canCopyAudioInto('webm', 'aac'), false);
  assert.equal(canCopyAudioInto('mkv', 'truehd'), true);
  const mp4 = planKeptVideoAudio({ format: 'mp4', source: truehd });
  assert.equal(mp4.mode, 'fallback');
  assert.equal(mp4.encoder, 'aac');
  assert.equal(mp4.warning, 'container');
  assert.equal(planKeptVideoAudio({ format: 'webm', source: { codec: 'aac', channels: 2 } }).encoder, 'libopus');
  const ui = describeAudioStreamForUi(truehd);
  assert.equal(ui.keepWithFilters, false);
  assert.equal(ui.copyInto.mp4, false);
  assert.equal(ui.copyInto.mkv, true);
});

test('real FFmpeg: copy, same-codec loudnorm/volume, TrueHD kept, TrueHD into MP4', async t => {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); }
    catch { t.skip(`${bin} is required`); return; }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-kept-audio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./fixtures/videoKeptAudio.mjs', import.meta.url)), root
  ], { timeout: 120_000, maxBuffer: 5_000_000, env: { ...process.env, DATA_DIR: root, ENV_USER_PATH: path.join(root, '.env') } });
  assert.match(stdout, /VIDEO_KEPT_AUDIO_OK/);
});
