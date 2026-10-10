import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));

test('local-source authorization runs after multipart parsing and before the job handler', () => {
  const source = fs.readFileSync(new URL('../routes/jobs.js', import.meta.url), 'utf8');
  assert.match(source, /router\.post\("\/api\/jobs", rateLimit\(10, 60_000\), upload\.single\("file"\), requireLocalJobAuth, async/);
});

for (const mode of ['none', 'admin']) {
  test(`${mode} access: server-local jobs require admin auth while uploads and remote jobs retain ordinary access`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-local-access-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(?:ENV_|DATA_DIR$|LOCAL_INPUT_DIR$|OUTPUTS_DISPLAY_DIR$|ADMIN_|GHARMONIZE_|JOBS_STATE_DIR$|CACHE_DIR$|PUID$|PGID$|SPOTIFY_|DEEZER_)/.test(key)) delete env[key];
    }
    const { stdout } = await execFileAsync(process.execPath, [
      '--loader', path.join(repository, 'test/fixtures/localJobAccessLoader.mjs'),
      path.join(repository, 'test/fixtures/localJobAccess.mjs'), root, mode
    ], { cwd: root, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.ok(stdout.includes('LOCAL_JOB_ACCESS_OK'), stdout);
  });
}
