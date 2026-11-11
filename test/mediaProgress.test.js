import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

for (const format of ['mp4', 'mkv']) {
  for (const scenario of ['split-header', 'probe-duration', 'clip-duration']) {
    test(`${format} conversion updates percent, elapsed time and FPS with ${scenario}`, async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-media-progress-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const { stdout } = await promisify(execFile)(process.execPath, [
        '--loader', new URL('./fixtures/mediaProgressLoader.mjs', import.meta.url).href,
        fileURLToPath(new URL('./fixtures/mediaProgress.mjs', import.meta.url)), root, format, scenario
      ], { timeout: 15_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, ENV_USER_PATH: path.join(root, '.env') } });
      assert.match(stdout, /MEDIA_PROGRESS_OK/);
    });
  }
}
