import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initializeRuntimeEnvironment, resolveRuntimeDataDir, resolveOutputsLocation } from '../modules/runtimeEnvironment.js';

const execFileAsync = promisify(execFile);
const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Node loads custom DATA_DIR before consumers and keeps the original configuration file', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.env'), 'DATA_DIR=storage\nLOCAL_INPUT_DIR=library\nOUTPUTS_DISPLAY_DIR=shown-outputs\n');
  const env = {};
  const result = initializeRuntimeEnvironment({ env, cwd: root });
  assert.equal(env.DATA_DIR, path.join(root, 'storage'));
  assert.equal(env.LOCAL_INPUT_DIR, path.join(root, 'storage', 'library'));
  assert.equal(env.ENV_USER_PATH, path.join(root, '.env'));
  assert.equal(result.userEnv, env.ENV_USER_PATH);
  assert.equal(resolveOutputsLocation(env).outputDir, path.join(root, 'storage', 'outputs'));
  assert.equal(resolveOutputsLocation(env).displayDir, path.join(root, 'storage', 'shown-outputs'));
});

test('desktop userData is a fallback, not a forced storage root, and keeps the old encryption key', (t) => {
  const root = fixture(t);
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  const envFile = path.join(profile, '.env');
  fs.writeFileSync(envFile, 'DATA_DIR=media-storage\n');
  const env = { ENV_USER_PATH: envFile };
  initializeRuntimeEnvironment({ env, cwd: root, desktopDataDir: profile });
  assert.equal(env.DATA_DIR, path.join(profile, 'media-storage'));
  assert.equal(env.ENV_USER_PATH, envFile);
  assert.equal(env.GHARMONIZE_MASTER_KEY_FILE, path.join(profile, '.gharmonize-key'));
  fs.writeFileSync(envFile, 'DATA_DIR=\n');
  const blank = { ENV_USER_PATH: envFile };
  initializeRuntimeEnvironment({ env: blank, cwd: root, desktopDataDir: profile });
  assert.equal(blank.DATA_DIR, profile);
});

test('explicit Docker/deployment paths outrank host paths in a mounted env file', (t) => {
  const root = fixture(t);
  const envFile = path.join(root, 'mounted.env');
  const defaults = path.join(root, 'defaults.env');
  fs.writeFileSync(defaults, 'DATA_DIR=default\nPREVIEW_MAX_ENTRIES=10\n');
  fs.writeFileSync(envFile, 'DATA_DIR=/host/not-mounted\nOUTPUTS_DISPLAY_DIR=/old/host/outputs\nGHARMONIZE_HOST=127.0.0.1\nPREVIEW_MAX_ENTRIES=20\n');
  const env = { DATA_DIR: path.join(root, 'container-data'), OUTPUTS_DISPLAY_DIR: '/new/host/outputs', GHARMONIZE_HOST: '0.0.0.0', ENV_USER_PATH: envFile, ENV_DEFAULT_PATH: defaults };
  initializeRuntimeEnvironment({ env, cwd: root });
  assert.equal(env.DATA_DIR, path.join(root, 'container-data'));
  assert.equal(env.OUTPUTS_DISPLAY_DIR, '/new/host/outputs');
  assert.equal(env.GHARMONIZE_HOST, '0.0.0.0');
  assert.equal(env.PREVIEW_MAX_ENTRIES, '20');
  assert.equal(env.ENV_USER_PATH, envFile);
});

test('empty inherited path values permit env configuration, and invalid roots never silently fall back', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.env'), 'DATA_DIR=chosen\nOUTPUTS_DISPLAY_DIR=shown\n');
  const env = { DATA_DIR: '', OUTPUTS_DISPLAY_DIR: '' };
  initializeRuntimeEnvironment({ env, cwd: root });
  assert.equal(env.DATA_DIR, path.join(root, 'chosen'));
  assert.equal(resolveOutputsLocation(env).displayDir, path.join(root, 'chosen', 'shown'));
  const file = path.join(root, 'not-a-directory');
  fs.writeFileSync(file, 'data');
  assert.throws(() => initializeRuntimeEnvironment({ env: { DATA_DIR: file }, cwd: root }));
});

test('Windows drive paths and UNC paths resolve correctly independently of the build host', () => {
  const profile = 'C:\\Users\\Listener\\AppData\\Roaming\\Gharmonize';
  const env = { DATA_DIR: 'D:\\Music storage\\Gharmonize' };
  assert.equal(resolveRuntimeDataDir(env, { desktopDataDir: profile, pathApi: path.win32 }), env.DATA_DIR);
  assert.equal(resolveOutputsLocation(env, path.win32).outputDir, 'D:\\Music storage\\Gharmonize\\outputs');
  assert.equal(resolveRuntimeDataDir({ DATA_DIR: '\\\\server\\media\\Gharmonize' }, { desktopDataDir: profile, pathApi: path.win32 }), '\\\\server\\media\\Gharmonize');
  const container = { DATA_DIR: '/container/data', OUTPUTS_DISPLAY_DIR: 'D:\\Host Music' };
  assert.deepEqual(resolveOutputsLocation(container, path.posix), {
    outputDir: '/container/data/outputs', displayDir: 'D:\\Host Music', linuxPath: 'D:/Host Music', windowsPath: 'D:\\Host Music'
  });
});

for (const mode of ['node', 'desktop', 'desktop-dev', 'docker']) {
  test(`${mode}: real routes share custom output/temp roots, settings stay anchored, and retag authorization remains bounded`, async (t) => {
    const root = fixture(t);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(?:ENV_|DATA_DIR$|OUTPUTS_DISPLAY_DIR$|LOCAL_INPUT_DIR$|RETAG_|ADMIN_|SPOTIFY_|DEEZER_|GHARMONIZE_|JOBS_STATE_DIR$|CACHE_DIR$|PUID$|PGID$)/.test(key)) delete env[key];
    }
    env.GHARMONIZE_WEB_BINARIES = '0';
    env.GHARMONIZE_WEB_BINARIES_IN_DOCKER = '0';
    const loaderArgs = mode.startsWith('desktop') ? ['--loader', path.join(repository, 'test/fixtures/electronEnvironmentLoader.mjs')] : [];
    const { stdout } = await execFileAsync(process.execPath, [...loaderArgs, path.join(repository, 'test/fixtures/runtimePaths.mjs'), root, mode], {
      cwd: root, env, timeout: 30_000, maxBuffer: 1024 * 1024
    });
    assert.ok(stdout.includes('RUNTIME_PATHS_OK'), stdout);
  });
}

test('all entry points initialize environment before routes and npm does not erase deployment overrides', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node app.js');
  assert.equal(pkg.scripts.dev, 'node --watch app.js');
  const app = fs.readFileSync(path.join(repository, 'app.js'), 'utf8');
  assert.ok(app.startsWith("import './modules/loadEnvironment.js';"));
  const electron = fs.readFileSync(path.join(repository, 'electron/main.mjs'), 'utf8');
  assert.ok(electron.indexOf("import './runtimeEnvironment.mjs'") < electron.indexOf("from '../modules/binaries.js'"));
  assert.ok(electron.includes('return resolveOutputsLocation().outputDir'));
  assert.ok(!electron.includes('process.env.DATA_DIR = dataDir'));
});

for (const launch of ['node', 'npm']) {
  test(`${launch} start: full server initializes all roots before imports and respects configured storage`, async (t) => {
    const root = fixture(t);
    const expected = path.join(root, 'configured-storage');
    const envFile = path.join(root, '.env');
    fs.writeFileSync(envFile, `DATA_DIR="${launch === 'npm' ? '/host/should-not-override-process-env' : expected}"\nADMIN_PASSWORD_HASH=fixture\nGHARMONIZE_ACCESS_REVISION=${'a'.repeat(32)}\n`);
    const env = {
      PATH: process.env.PATH, ENV_USER_PATH: envFile, PORT: '0',
      GHARMONIZE_HOST: '127.0.0.1', GHARMONIZE_WEB_BINARIES: '0', GHARMONIZE_WEB_BINARIES_IN_DOCKER: '0',
      GHARMONIZE_TEST_EXPECTED_DATA_DIR: expected,
      NODE_OPTIONS: `--import=${path.join(repository, 'test/fixtures/startupObserver.mjs')}`
    };
    if (launch === 'npm') env.DATA_DIR = expected;
    const command = launch === 'node' ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = launch === 'node' ? [path.join(repository, 'app.js')] : ['start', '--prefix', repository];
    const { stdout } = await execFileAsync(command, args, { cwd: root, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.ok(stdout.includes('STARTUP_PATHS_OK'), stdout);
    for (const dir of ['outputs', 'uploads', 'temp', 'cache', 'cookies', 'local-inputs']) assert.ok(fs.existsSync(path.join(expected, dir)), dir);
    assert.ok(!fs.existsSync(path.join(expected, '.env')));
  });
}

let hasFfmpeg = false;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }); hasFfmpeg = true; } catch {}
test('real FFmpeg retag stays in the selected library, with temp storage under custom DATA_DIR', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async (t) => {
  const root = fixture(t);
  const { stdout } = await execFileAsync(process.execPath, [path.join(repository, 'test/fixtures/retagPaths.mjs'), root], {
    cwd: root, env: { PATH: process.env.PATH, GHARMONIZE_WEB_BINARIES: '0', GHARMONIZE_WEB_BINARIES_IN_DOCKER: '0' }, timeout: 30_000
  });
  assert.ok(stdout.includes('RETAG_PATHS_OK'), stdout);
});
