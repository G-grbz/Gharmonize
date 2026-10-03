import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { downloadElectronArtifactZip } = require('app-builder-lib/out/util/electronGet.js');

test('Electron builder downloads, verifies and caches artifacts with the overridden downloader', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gharmonize-electron-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from('Gharmonize Electron artifact fixture');
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'Content-Length': payload.length });
    response.end(payload);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const filename = 'electron-v44.5.0-linux-x64.zip';
  const checksum = createHash('sha256').update(payload).digest('hex');
  const options = {
    version: '44.5.0',
    platformName: 'linux',
    arch: 'x64',
    artifactName: 'electron',
    cacheDir: path.join(directory, 'valid'),
    electronDownload: {
      mirrorOptions: {
        resolveAssetURL: async () => `http://127.0.0.1:${server.address().port}/${filename}`
      },
      checksums: { [filename]: checksum }
    }
  };

  const downloaded = await downloadElectronArtifactZip(options);
  assert.deepEqual(await readFile(downloaded), payload);
  const requestsAfterDownload = requests;
  assert.ok(requestsAfterDownload > 0);
  assert.equal(await downloadElectronArtifactZip(options), downloaded);
  assert.equal(requests, requestsAfterDownload, 'cached artifact should not be downloaded again');

  await assert.rejects(downloadElectronArtifactZip({
    ...options,
    cacheDir: path.join(directory, 'invalid'),
    electronDownload: {
      ...options.electronDownload,
      checksums: { [filename]: '0'.repeat(64) }
    }
  }), /checksum|SHA256|mismatch/i);
});
