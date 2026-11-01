import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ZipArchive } from 'archiver';
import readdirGlob from 'readdir-glob';

const require = createRequire(import.meta.url);
const project = fileURLToPath(new URL('..', import.meta.url));
const { Open } = require('unzipper');

function minimatchFor(requester) {
  const resolver = createRequire(require.resolve(requester));
  return { api: resolver('minimatch'), version: resolver('minimatch/package.json').version };
}

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-glob-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('all installed glob consumers resolve patched minimatch with their supported APIs', () => {
  for (const requester of ['readdir-glob', 'app-builder-lib', '@electron/asar', 'filelist']) {
    const { api, version } = minimatchFor(requester);
    assert.match(version, /^11\./, requester);
    const [, minor, patch] = version.split('.').map(Number);
    assert.ok(minor > 0 || patch >= 1, requester);
    for (const name of ['Minimatch', 'minimatch', 'match']) assert.equal(typeof api[name], 'function', requester);
    assert.ok(Array.isArray(new api.Minimatch('**/*.js', { dot: true }).set));
    assert.equal(api.minimatch('nested/library.node', '*.node', { matchBase: true }), true);
    assert.deepEqual(api.match(['a.mp3', 'nested/b.flac', '.hidden.mp3', 'c.txt'], '**/*.{mp3,flac}'), ['a.mp3', 'nested/b.flac']);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json'), 'utf8'));
  const copies = Object.entries(lock.packages).filter(([name]) => name.endsWith('/minimatch'));
  assert.ok(copies.length > 0);
  for (const [name, { version }] of copies) {
    assert.match(version, /^11\./, name);
    const [, minor, patch] = version.split('.').map(Number);
    assert.ok(minor > 0 || patch >= 1, name);
  }
  assert.equal(typeof require('@electron/asar').createPackageFromStreams, 'function');
  assert.equal(typeof require('@electron/universal').makeUniversalApp, 'function');
  assert.equal(typeof require('electron-winstaller').createWindowsInstaller, 'function');
});

test('globparts amplification is bounded in a time- and memory-limited child', () => {
  const result = execFileSync(process.execPath, ['--max-old-space-size=128',
    fileURLToPath(new URL('./fixtures/minimatchAmplification.cjs', import.meta.url))], {
    cwd: project, encoding: 'utf8', timeout: 10000, maxBuffer: 8192
  });
  const data = JSON.parse(result);
  assert.ok(data.small <= 8);
  assert.ok(data.large <= 64);
});

test('readdir-glob preserves dotfiles, braces, globstar, ignore and literal filename behavior', async t => {
  const root = directory(t);
  fs.mkdirSync(path.join(root, 'nested'));
  for (const file of ['song [live].mp3', 'a.flac', '.hidden.mp3', 'skip.mp3', 'nested/b.mp3', 'nested/c.txt']) {
    fs.writeFileSync(path.join(root, file), file);
  }
  async function scan(options) {
    return new Promise((resolve, reject) => {
      const matches = [];
      const scan = readdirGlob(root, { nodir: true, ...options });
      scan.on('match', entry => matches.push(entry.relative));
      scan.on('error', reject);
      scan.on('end', () => resolve(matches.sort()));
    });
  }
  assert.deepEqual(await scan({ pattern: '**/*.{mp3,flac}', ignore: '**/skip.*' }),
    ['a.flac', 'nested/b.mp3', 'song [live].mp3']);
  assert.deepEqual(await scan({ pattern: '**/*.mp3', dot: true, skip: 'nested' }),
    ['.hidden.mp3', 'skip.mp3', 'song [live].mp3']);
});

test('electron-builder uses the existing include/exclude and partial-directory matching API', () => {
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher.js');
  const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  const filter = new FileMatcher(project, '/unused-destination', value => value, pkg.build.files).createFilter();
  const file = { isDirectory: () => false };
  const dir = { isDirectory: () => true };
  for (const name of ['app.js', 'bootstrap.mjs', '.env.default', 'modules/security.js',
    'public/src/gharmonize-tray.svg', 'electron/assets/gharmonize-tray-dark.png', 'build/icon.ico']) {
    assert.equal(filter(path.join(project, name), file), true, name);
  }
  for (const name of ['.env', '.git/config', '.local-notes/FEATURE_PLAN.md',
    'test/minimatchSecurity.test.js', 'build/bin/yt-dlp']) {
    assert.equal(filter(path.join(project, name), file), false, name);
  }
  for (const name of ['modules', 'public', 'public/src', 'electron', 'electron/assets']) {
    assert.equal(filter(path.join(project, name), dir), true, name);
  }
});

test('filelist keeps the match-array API consumed by the EJS/Jake build chain', t => {
  const root = directory(t);
  fs.mkdirSync(path.join(root, 'nested'));
  for (const file of ['a.js', 'skip.js', 'nested/b.js', 'c.txt']) fs.writeFileSync(path.join(root, file), file);
  const { FileList } = require('filelist');
  // FileList normalizes patterns with path.normalize(), but returns slash paths.
  // On Windows, backslashes in these patterns must be separators, not escapes.
  const files = new FileList(path.join(root, '**/*.js'), { windowsPathsNoEscape: true })
    .exclude(path.join(root, 'skip.js').split(path.sep).join('/')).toArray();
  assert.deepEqual(files.map(file => path.relative(root, file)).sort(), ['a.js', path.join('nested', 'b.js')]);
  assert.equal(require('ejs').render('<%= value %>', { value: 'safe <tag>' }), 'safe &lt;tag&gt;');
});

test('modern ASAR packing and unpack patterns work with the upgraded glob matcher', async t => {
  const root = directory(t);
  const input = path.join(root, 'input');
  fs.mkdirSync(path.join(input, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(input, 'app.js'), 'module.exports = 42;');
  fs.writeFileSync(path.join(input, 'fake.node'), 'native fixture');
  fs.writeFileSync(path.join(input, 'assets/icon.txt'), 'unpacked fixture');
  const asar = require('@electron/asar');
  const archive = path.join(root, 'application.asar');
  await asar.createPackageWithOptions(input, archive, { unpack: '*.node', unpackDir: 'assets' });
  assert.equal(asar.statFile(archive, 'fake.node').unpacked, true);
  assert.equal(asar.statFile(archive, 'assets/icon.txt').unpacked, true);
  assert.equal(asar.extractFile(archive, 'app.js').toString(), 'module.exports = 42;');
});

test('universal packaging keeps its Windows host guard and merges ASARs on POSIX hosts', async t => {
  const root = directory(t);
  if (process.platform === 'win32') {
    // The public universal builder supports macOS only. Its POSIX merge helper
    // is not a Windows packaging API; normal Windows ASAR creation is tested above.
    await assert.rejects(require('@electron/universal').makeUniversalApp({
      x64AppPath: path.join(root, 'x64.app'), arm64AppPath: path.join(root, 'arm64.app'),
      outAppPath: path.join(root, 'universal.app')
    }), /only supported on darwin/);
    return;
  }
  const asar = require('@electron/asar');
  const entry = require.resolve('@electron/universal');
  const { mergeASARs } = await import(pathToFileURL(path.join(path.dirname(entry), 'asar-utils.js')).href);
  const x64 = path.join(root, 'x64');
  const arm64 = path.join(root, 'arm64');
  for (const input of [x64, arm64]) {
    fs.mkdirSync(input);
    fs.writeFileSync(path.join(input, 'shared.js'), 'shared content');
    fs.writeFileSync(path.join(input, 'shared.node'), 'shared native fixture');
  }
  fs.writeFileSync(path.join(arm64, 'arm64-only.txt'), 'arm64 content');
  const x64AsarPath = path.join(root, 'x64.asar');
  const arm64AsarPath = path.join(root, 'arm64.asar');
  const outputAsarPath = path.join(root, 'universal.asar');
  await asar.createPackageWithOptions(x64, x64AsarPath, { unpack: '*.node' });
  await asar.createPackageWithOptions(arm64, arm64AsarPath, { unpack: '*.node' });
  await assert.rejects(mergeASARs({ x64AsarPath, arm64AsarPath, outputAsarPath }), /unique file.*allowList/);
  await mergeASARs({ x64AsarPath, arm64AsarPath, outputAsarPath, singleArchFiles: '*.txt' });
  assert.equal(asar.extractFile(outputAsarPath, 'shared.js').toString(), 'shared content');
  assert.equal(asar.extractFile(outputAsarPath, 'arm64-only.txt').toString(), 'arm64 content');
  assert.equal(asar.statFile(outputAsarPath, 'shared.node').unpacked, true);
});

for (const filename of ['modules/processor.js', 'routes/spotify.js']) {
  test(`${filename}: actual ZIP helper treats output names as files, never as glob patterns`, async t => {
    const root = directory(t);
    const names = ['Song [live].mp3', 'Song {a,b}.mp3', 'İzmir - gece.mp3'];
    for (const name of names) fs.writeFileSync(path.join(root, name), name);
    fs.writeFileSync(path.join(root, 'Song [live].lrc'), 'lyrics');
    fs.writeFileSync(path.join(root, 'Song l.mp3'), 'must not be selected by bracket glob');
    const source = fs.readFileSync(path.join(project, filename), 'utf8');
    const start = source.indexOf('async function makeZipFromOutputs(');
    assert.ok(start >= 0);
    const end = source.indexOf('// Cleans up', start);
    assert.ok(end > start);
    let files = 0;
    class FileOnlyArchive extends ZipArchive {
      file(...args) { files++; return super.file(...args); }
      glob() { throw new Error('User-selected files must not become glob patterns'); }
      directory() { throw new Error('User-selected files must not become recursive patterns'); }
    }
    const context = vm.createContext({ fs, path, ZipArchive: FileOnlyArchive, OUTPUT_DIR: root,
      sanitizeFilename: value => value, queueOwnershipFix: async () => {},
      toDownloadPathSafe: value => value,
      resolveDownloadPathToAbs: value => value });
    vm.runInContext(source.slice(start, end), context);
    const output = await context.makeZipFromOutputs('job_fixture',
      names.map(name => ({ outputPath: path.join(root, name) })), 'Playlist [live]', true, root);
    const zip = await Open.file(output);
    assert.equal(files, 4);
    assert.deepEqual(zip.files.map(file => file.path).sort(), [...names, 'Song [live].lrc'].sort());
    for (const entry of zip.files) assert.equal((await entry.buffer()).toString(),
      entry.path.endsWith('.lrc') ? 'lyrics' : entry.path);
  });
}
