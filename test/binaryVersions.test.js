import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseVersionFromOutput } from '../modules/binariesInfo.js';

test('version parser preserves release and development FFmpeg/FFprobe build tokens', () => {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    for (const version of ['n8.1.3-16-ge0a878dd70-20261009', 'N-127259-gb91a82d6dd-20261009', '8.1.3']) {
      assert.equal(parseVersionFromOutput(`${tool} version ${version} Copyright\nconfiguration: ...`, tool), version);
    }
  }
});

test('actual binary versions are not replaced by the latest release label', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-binary-versions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await promisify(execFile)(process.execPath, ['test/fixtures/binaryVersionInfo.mjs', root]);
  assert.match(result.stdout, /BINARY_VERSION_INFO_OK/);
});

test('binary footer displays the stable version instead of a truncated Git build token', () => {
  const source = fs.readFileSync('public/ui/MediaConverterApp.js', 'utf8');
  const start = source.indexOf('const shortenVersion =');
  const end = source.indexOf("const el = document.getElementById('binaryVersionsText')", start);
  const context = vm.createContext({});
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.shorten = shortenVersion;`, context);
  assert.equal(context.shorten('n8.1.3-16-ge0a878dd70-20261009'), '8.1.3');
  assert.equal(context.shorten('N-127259-gb91a82d6dd-20261009'), '20261009');
  assert.equal(context.shorten('102.0'), '102.0');
});
