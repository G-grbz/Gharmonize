import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const temp = require('temp');
const fromTemp = createRequire(require.resolve('temp'));
const cleanup = fromTemp('rimraf');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-temp-compat-'));
  t.after(() => { temp.track(false); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('only the inspected temp consumer uses the local literal-path cleanup API', () => {
  assert.equal(fromTemp('rimraf/package.json').name, '@gharmonize/temp-cleanup');
  assert.equal(typeof cleanup, 'function');
  assert.equal(typeof cleanup.sync, 'function');
});

test('actual temp cleanup preserves synchronous, callback and promise calls', async t => {
  const root = directory(t);
  temp.track();
  const syncDir = temp.mkdirSync({ dir: root, prefix: 'sync-' });
  fs.writeFileSync(path.join(syncDir, 'data'), 'fixture');
  const opened = temp.openSync({ dir: root });
  fs.closeSync(opened.fd);
  assert.deepEqual(temp.cleanupSync(), { files: 1, dirs: 1 });
  assert.equal(fs.existsSync(syncDir), false);
  assert.equal(fs.existsSync(opened.path), false);
  for (const mode of ['callback', 'promise']) {
    const target = await temp.mkdir({ dir: root, prefix: mode });
    fs.writeFileSync(path.join(target, 'data'), 'fixture');
    const counts = mode === 'callback' ? await promisify(temp.cleanup)() : await temp.cleanup();
    assert.deepEqual(counts, { files: 0, dirs: 1 });
    assert.equal(fs.existsSync(target), false);
  }
});

test('temporary cleanup never expands bracket/brace patterns or follows directory links', async t => {
  const root = directory(t);
  const literal = path.join(root, '[ab]{x,y}');
  const neighbor = path.join(root, 'ax');
  const outside = path.join(root, 'outside');
  for (const dir of [literal, neighbor, outside]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'keep'), 'fixture');
  }
  cleanup.sync(literal, { maxBusyTries: 6 });
  assert.equal(fs.existsSync(literal), false);
  assert.equal(fs.readFileSync(path.join(neighbor, 'keep'), 'utf8'), 'fixture');
  const link = path.join(root, 'link');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await promisify(cleanup)(link, { maxBusyTries: 6 });
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'fixture');
  cleanup.sync(literal);
  await promisify(cleanup)(literal);
});

test('cleanup validates retries and propagates errors through the legacy API', async t => {
  const root = directory(t);
  assert.throws(() => cleanup.sync(root, { maxBusyTries: -1 }), TypeError);
  assert.throws(() => cleanup(root, {}), /callback/);
  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'must remain');
  const failure = Object.assign(new Error('fixture permission failure'), { code: 'EACCES' });
  t.mock.method(fs, 'rm', (_target, _options, callback) => queueMicrotask(() => callback(failure)));
  await assert.rejects(promisify(cleanup)(file), error => error === failure);
  assert.equal(fs.readFileSync(file, 'utf8'), 'must remain');
});
