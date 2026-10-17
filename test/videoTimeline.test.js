import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { safeFrameRate, videoTimelineFilters } from '../modules/videoTimeline.js';

test('timeline frame rates retain rational NTSC rates and reject untrusted expressions or invalid rates', () => {
  for (const rate of ['25', '24', '30000/1001', '24000/1001', '29.97']) assert.equal(safeFrameRate(rate), rate);
  for (const rate of [null, 'source', '0/0', '25/0', '-25', '999', '25,scale=1:1', Infinity]) assert.equal(safeFrameRate(rate), null);
});

test('video re-encoding materializes timing at the source or explicitly selected frame rate', () => {
  const settings = { isVideo: true, videoTranscoded: true, sourceFps: '25/1', audioCodec: 'ac3' };
  assert.deepEqual(videoTimelineFilters(settings), {
    video: 'fps=fps=25/1:start_time=0', audio: 'aresample=async=1:min_hard_comp=0.01:first_pts=0'
  });
  assert.equal(videoTimelineFilters({ ...settings, targetFps: 24 }).video, 'fps=fps=24:start_time=0');
  assert.equal(videoTimelineFilters({ ...settings, sourceFps: '24000/1001' }).video, 'fps=fps=24000/1001:start_time=0');
});

test('copy modes, unknown video rates and audio-only conversion do not independently zero stream starts', () => {
  const settings = { isVideo: true, videoTranscoded: true, sourceFps: '25/1', audioCodec: 'ac3' };
  assert.deepEqual(videoTimelineFilters({ ...settings, videoTranscoded: false, audioCodec: 'copy' }), { video: null, audio: null });
  assert.equal(videoTimelineFilters({ ...settings, videoTranscoded: false }).audio, 'aresample=async=1:min_hard_comp=0.01');
  assert.equal(videoTimelineFilters({ ...settings, sourceFps: '0/0' }).audio, 'aresample=async=1:min_hard_comp=0.01');
  assert.equal(videoTimelineFilters({ ...settings, audioCodec: 'copy' }).audio, null);
  assert.deepEqual(videoTimelineFilters({ ...settings, isVideo: false }), { video: null, audio: null });
});

test('real conversion and plain MKVToolNix extraction/remux preserve a regular timeline without timing sidecars', async t => {
  for (const bin of ['ffmpeg', 'ffprobe', 'mkvmerge', 'mkvextract']) {
    try { execFileSync(bin, [bin.startsWith('mkv') ? '--version' : '-version'], { stdio: 'ignore' }); }
    catch { t.skip(`${bin} is required`); return; }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-timeline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./fixtures/videoTimeline.mjs', import.meta.url)), root
  ], { timeout: 90_000, maxBuffer: 3_000_000, env: { ...process.env, DATA_DIR: root, ENV_USER_PATH: path.join(root, '.env') } });
  assert.match(stdout, /VIDEO_TIMELINE_OK/);
});
