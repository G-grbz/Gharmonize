import test from 'node:test';
import assert from 'node:assert/strict';
import { startDesktopServer } from '../electron/desktopServer.mjs';

function fixture(options = {}) {
  const calls = [];
  const env = {};
  const config = {
    isPackaged: false, externalServer: false, resourcesPath: '/fixture/resources', port: '5174', env,
    resolvePort: async () => { calls.push('resolve'); return '5175'; },
    importServer: async url => { calls.push(['import', url, env.PORT]); },
    waitForServer: async port => { calls.push(['wait', port]); },
    ...options
  };
  return { calls, env, start: () => startDesktopServer(config) };
}

test('npm desktop start boots the source backend before waiting, with the selected port already applied', async () => {
  const f = fixture();
  assert.equal(await f.start(), '5175');
  assert.deepEqual(f.calls, [
    'resolve', ['import', new URL('../bootstrap.mjs', import.meta.url).href, '5175'], ['wait', '5175']
  ]);
});

test('all installed desktop formats bootstrap app.asar directly, regardless of external development flags', async () => {
  const f = fixture({ isPackaged: true, externalServer: true });
  assert.equal(await f.start(), '5175');
  assert.deepEqual(f.calls, ['resolve', ['import', 'file:///fixture/resources/app.asar/bootstrap.mjs', '5175'], ['wait', '5175']]);
});

test('the external development window waits for its watched server without starting another backend', async () => {
  const f = fixture({ externalServer: true });
  assert.equal(await f.start(), '5174');
  assert.deepEqual(f.calls, [['wait', '5174']]);
  assert.deepEqual(f.env, {});
});

test('a backend startup failure is propagated instead of opening a window on an unrelated server', async () => {
  const error = new Error('fixture startup failure');
  const f = fixture({ importServer: async () => { throw error; } });
  await assert.rejects(f.start(), failure => failure === error);
  assert.deepEqual(f.calls, ['resolve']);
});
