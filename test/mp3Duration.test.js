import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mp3DurationHeaderArgs } from '../modules/mp3Muxer.js';

test('MP3 duration headers default on for both VBR and CBR', () => {
  assert.deepEqual(mp3DurationHeaderArgs({ env: {} }), ['-write_xing', '1']);
  assert.deepEqual(mp3DurationHeaderArgs({ vbr: false, env: {} }), ['-write_xing', '1']);
  assert.deepEqual(mp3DurationHeaderArgs({ env: { MP3_WRITE_XING: '1' } }), ['-write_xing', '1']);
});

test('legacy opt-out cannot disable VBR, ringtone or remux duration headers', () => {
  const env = { MP3_WRITE_XING: '0' };
  assert.deepEqual(mp3DurationHeaderArgs({ env }), ['-write_xing', '1']);
  assert.deepEqual(mp3DurationHeaderArgs({ vbr: false, force: true, env }), ['-write_xing', '1']);
  assert.deepEqual(mp3DurationHeaderArgs({ vbr: false, env }), ['-write_xing', '0']);
});

test('real MP3 conversion, retagging and lyric embedding preserve accurate duration and audio', async (t) => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  } catch {
    t.skip('FFmpeg and FFprobe are required for the real media regression');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-mp3-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./fixtures/mp3Duration.mjs', import.meta.url)), root,
  ], {
    timeout: 45_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, DATA_DIR: root, ENV_USER_PATH: path.join(root, '.env') },
  });
  assert.match(stdout, /MP3_DURATION_OK/);
});
