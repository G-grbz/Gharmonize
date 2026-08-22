import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectJobOutputPaths,
  OutputExistenceClient
} from '../public/ui/OutputExistenceClient.js';

function jsonResponse(paths, existing = new Set(paths)) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        items: paths.map((outputPath) => ({
          path: outputPath,
          exists: existing.has(outputPath)
        }))
      };
    }
  };
}

test('output existence client coalesces concurrent paths into one request', async () => {
  const calls = [];
  const client = new OutputExistenceClient({
    fetchImpl: async (_url, options) => {
      const { paths } = JSON.parse(options.body);
      calls.push(paths);
      return jsonResponse(paths, new Set(['/a.mp3', '/c.mp3']));
    }
  });

  const first = client.checkMany(['/a.mp3', '/b.mp3']);
  const second = client.checkMany(['/a.mp3', '/c.mp3']);
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(calls.length, 1);
  assert.deepEqual(new Set(calls[0]), new Set(['/a.mp3', '/b.mp3', '/c.mp3']));
  assert.equal(firstResult.get('/a.mp3'), true);
  assert.equal(firstResult.get('/b.mp3'), false);
  assert.equal(secondResult.get('/c.mp3'), true);

  assert.equal(await client.check('/a.mp3'), true);
  assert.equal(calls.length, 1, 'fresh cached paths must not trigger another request');
});

test('output existence client fails open and briefly caches transport failures', async () => {
  let calls = 0;
  const client = new OutputExistenceClient({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('temporary failure');
    }
  });

  assert.equal(await client.check('/completed.mp3'), true);
  assert.equal(await client.check('/completed.mp3'), true);
  assert.equal(calls, 1);
});

test('output existence client keeps request bodies within the server batch limit', async () => {
  const batchSizes = [];
  const client = new OutputExistenceClient({
    fetchImpl: async (_url, options) => {
      const { paths } = JSON.parse(options.body);
      batchSizes.push(paths.length);
      return jsonResponse(paths);
    }
  });
  const paths = Array.from({ length: 251 }, (_, index) => `/file-${index}.mp3`);

  const results = await client.checkMany(paths);

  assert.deepEqual(batchSizes, [250, 1]);
  assert.equal(results.size, 251);
});

test('job output path collection includes playlist files and archive once', () => {
  assert.deepEqual(collectJobOutputPaths({
    resultPath: [
      { outputPath: '/download/one.mp3' },
      { path: '/download/two.mp3' },
      { outputPath: '/download/failed.mp3', error: 'failed' }
    ],
    zipPath: '/download/list.zip'
  }), [
    '/download/one.mp3',
    '/download/two.mp3',
    '/download/list.zip'
  ]);
});

test('output existence API checks a bounded path list in one request', async (t) => {
  const { default: express } = await import('express');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-output-exists-'));
  const outputDir = path.join(dataDir, 'outputs');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'present.mp3'), 'test');
  process.env.DATA_DIR = dataDir;

  const { default: downloadRouter } = await import(`../routes/download.js?test=${Date.now()}`);
  const app = express();
  app.use(express.json());
  app.use(downloadRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/outputs/exists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paths: [
        '/download/present.mp3',
        '/download/missing.mp3',
        '/download/../../outside.mp3'
      ]
    })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    items: [
      { path: '/download/present.mp3', exists: true },
      { path: '/download/missing.mp3', exists: false },
      { path: '/download/../../outside.mp3', exists: false }
    ]
  });

  const oversized = await fetch(`http://127.0.0.1:${address.port}/api/outputs/exists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: Array.from({ length: 251 }, () => '/download/a.mp3') })
  });
  assert.equal(oversized.status, 413);
});
