import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Deezer API answers come from `api` below instead of the network: the
// module's node-fetch import is replaced for this test file only.
const api = { handler: null, calls: [] };
globalThis.__deezerOutageFetch = (url, options) => {
  api.calls.push(String(url));
  return api.handler(String(url), options);
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node-fetch') {
      return { url: 'data:text/javascript,export default (...args) => globalThis.__deezerOutageFetch(...args)', shortCircuit: true };
    }
    return next(specifier, context);
  }
});
const { resolveDeezerUrlLite } = await import('../modules/deezer.js');

const json = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const refused = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' }));
const catalog = (url) => {
  const track = url.match(/\/track\/(\d+)$/);
  if (track) return json({ id: Number(track[1]), title: 'Senle Açamam', duration: 240, artist: { id: 7, name: 'Bülent Yiğit' }, album: { id: 900 + Number(track[1]) } });
  const album = url.match(/\/album\/(\d+)$/);
  if (album) return json({ id: Number(album[1]), title: 'Albüm', artist: { id: 7, name: 'Bülent Yiğit' }, tracks: { data: [{ id: 1, title: 'Parça', duration: 200, artist: { id: 7, name: 'Bülent Yiğit' } }] }, tracklist: `https://api.deezer.com/album/${album[1]}/tracks` });
  if (/\/album\/\d+\/tracks/.test(url)) return json({ data: [{ id: 1, title: 'Parça', duration: 200, artist: { id: 7, name: 'Bülent Yiğit' } }], total: 1 });
  return json({ error: { type: 'DataException', message: 'no data', code: 800 } });
};

test('a Deezer outage is reported as such and is not remembered as "not found"', async () => {
  api.handler = refused;
  await assert.rejects(resolveDeezerUrlLite('https://www.deezer.com/track/101'), (error) => {
    assert.equal(error.transient, true);
    assert.match(error.message, /could not be reached \(ECONNREFUSED\)/);
    assert.doesNotMatch(error.message, /not found/i);
    return true;
  });
  // Deezer is back: the same track resolves (nothing was cached).
  api.handler = catalog;
  const resolved = await resolveDeezerUrlLite('https://www.deezer.com/track/101');
  assert.equal(resolved.kind, 'track');
  assert.equal(resolved.title, 'Bülent Yiğit - Senle Açamam');
});

test('server errors, rate limits and a busy Deezer are retryable; a missing track is not', async () => {
  for (const answer of [() => json({}, 503), () => json({}, 429), () => json({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } })]) {
    api.handler = answer;
    await assert.rejects(resolveDeezerUrlLite('https://www.deezer.com/track/102'), (error) => error.transient === true);
  }
  api.handler = catalog;
  await assert.rejects(resolveDeezerUrlLite('https://www.deezer.com/track/0000'), /Unsupported Deezer URL|not found/);
  api.handler = () => json({ error: { type: 'DataException', message: 'no data', code: 800 } });
  await assert.rejects(resolveDeezerUrlLite('https://www.deezer.com/track/103'), (error) => {
    assert.equal(error.transient, undefined);
    assert.match(error.message, /Deezer track metadata not found/);
    return true;
  });
});

test('an unanswered Deezer request gives up after the time limit instead of the TCP timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  api.handler = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
  });
  const pending = resolveDeezerUrlLite('https://www.deezer.com/track/104');
  const outcome = assert.rejects(pending, (error) => {
    assert.equal(error.transient, true);
    assert.match(error.message, /did not answer within 15 s/);
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15_000);
  await outcome;
});

test('an album whose song list could not be read is retried, not downloaded partly or cached', async () => {
  api.handler = (url) => (/\/tracks/.test(url) ? refused() : catalog(url));
  await assert.rejects(resolveDeezerUrlLite('https://www.deezer.com/album/55'), (error) => error.transient === true);
  api.handler = catalog;
  const resolved = await resolveDeezerUrlLite('https://www.deezer.com/album/55');
  assert.equal(resolved.items.length, 1);
});
