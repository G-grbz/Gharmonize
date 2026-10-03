import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let moduleId = 0;
async function provider(name, fetchImpl) {
  const file = new URL(`../modules/${name}.js`, import.meta.url);
  // Inject only the transport; run the actual provider search, scoring, cache,
  // body-reading and fallback logic without contacting external services.
  const source = fs.readFileSync(file, 'utf8')
    .replace('import fetch from "node-fetch";', 'const fetch = globalThis.__metadataTestFetch;')
    .replace(/from (["'])(\.\/[^"']+)\1/g, (_, quote, relative) =>
      `from ${quote}${new URL(relative, file).href}${quote}`);
  globalThis.__metadataTestFetch = fetchImpl;
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${++moduleId}`);
  } finally {
    delete globalThis.__metadataTestFetch;
  }
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const guard = setTimeout(() => reject(new Error('Request did not honor its deadline')), 1000);
    signal.addEventListener('abort', () => {
      clearTimeout(guard);
      reject(signal.reason);
    }, { once: true });
  });
}
const response = (data) => ({ ok: true, async json() { return data; } });
const appleTrack = {
  wrapperType: 'track', trackId: 123, collectionId: 456,
  artistName: 'Indila', trackName: 'Dernière Danse',
  collectionName: 'Mini World', trackTimeMillis: 215000,
  trackNumber: 1, trackCount: 10, discNumber: 1, discCount: 1
};
const deezerTrack = {
  id: 123, title: 'Dernière Danse', duration: 215,
  artist: { id: 12, name: 'Indila' },
  album: { id: 456, title: 'Mini World' }, track_position: 1, disk_number: 1
};

for (const name of ['apple', 'deezer']) {
  const method = name === 'apple' ? 'findAppleTrackMetaByQuery' : 'findDeezerTrackMetaByQuery';
  test(`${name} matches Indila after cleaning Clip Officiel and trying an accent-free query`, async () => {
    const queries = [];
    const mod = await provider(name, async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes('/search')) {
        const query = parsed.searchParams.get(name === 'apple' ? 'term' : 'q');
        queries.push(query);
        const expected = name === 'apple' ? 'Indila Derniere Danse' : 'Indila "Derniere Danse"';
        return response(name === 'apple'
          ? { results: query === expected ? [appleTrack] : [] }
          : { data: query === expected ? [deezerTrack] : [] });
      }
      if (url.includes('/track/')) return response(deezerTrack);
      return response(name === 'apple'
        ? { results: [{ wrapperType: 'collection', collectionId: 456, collectionName: 'Mini World' }] }
        : { id: 456, title: 'Mini World', nb_tracks: 10 });
    });
    const meta = await mod[method]('Indila', 'Dernière Danse (Clip Officiel)');
    assert.equal(meta.artist, 'Indila');
    assert.equal(meta.title, 'Dernière Danse');
    assert.equal(meta.album, 'Mini World');
    assert.equal(queries.length, 2, 'The accent-free alternative should be tried before unrelated broad searches');
    assert.ok(queries.every((query) => !query.includes('Officiel')));
  });

  test(`${name} enrichment bounds body reading and does not cache timeout as a negative match`, async () => {
    let calls = 0;
    let outage = true;
    const mod = await provider(name, async (url, { signal }) => {
      calls++;
      assert.ok(signal instanceof AbortSignal);
      if (outage) return { ok: true, json: () => waitForAbort(signal) };
      if (url.includes('/search')) return response(name === 'apple' ? { results: [appleTrack] } : { data: [deezerTrack] });
      if (url.includes('/track/')) return response(deezerTrack);
      return response(name === 'apple' ? { results: [] } : { id: 456, title: 'Mini World', nb_tracks: 10 });
    });
    const start = Date.now();
    assert.equal(await mod[method]('Indila', 'Dernière Danse', { timeoutMs: 25 }), null);
    assert.ok(Date.now() - start < 500);
    assert.equal(calls, 1, 'No new queries after the shared deadline');
    outage = false;
    const meta = await mod[method]('Indila', 'Dernière Danse');
    assert.equal(meta.artist, 'Indila');
    assert.equal(meta.title, 'Dernière Danse');
    const cachedCalls = calls;
    assert.equal(await mod[method]('Indila', 'Dernière Danse'), meta);
    assert.equal(calls, cachedCalls, 'Successful enrichment stays cached');
  });

  test(`${name} respects the parent deadline across provider fallbacks`, async () => {
    let calls = 0;
    const mod = await provider(name, async (_, { signal }) => {
      calls++;
      return waitForAbort(signal);
    });
    const controller = new AbortController();
    controller.abort();
    assert.equal(await mod[method]('Indila', 'Dernière Danse', { signal: controller.signal }), null);
    assert.equal(calls, 0);
  });
}

test('Apple retains a found track when its optional collection lookup times out', async () => {
  const mod = await provider('apple', async (url, { signal }) =>
    url.includes('/search') ? response({ results: [appleTrack] }) : { ok: true, json: () => waitForAbort(signal) });
  const meta = await mod.findAppleTrackMetaByQuery('Indila', 'Dernière Danse', { timeoutMs: 25 });
  assert.equal(meta.title, 'Dernière Danse');
  assert.equal(meta.track_number, 1);
});

test('Deezer query enrichment does not enumerate the entire album', async () => {
  const urls = [];
  const mod = await provider('deezer', async (url) => {
    urls.push(url);
    if (url.includes('/search')) return response({ data: [deezerTrack] });
    if (url.includes('/track/')) return response(deezerTrack);
    if (url.includes('/album/456')) return response({
      id: 456, title: 'Mini World', nb_tracks: 10,
      tracklist: 'https://api.deezer.com/album/456/tracks'
    });
    throw new Error(`Unexpected album pagination: ${url}`);
  });
  const meta = await mod.findDeezerTrackMetaByQuery('Indila', 'Dernière Danse');
  assert.equal(meta.track_number, 1);
  assert.equal(meta.track_total, 10);
  assert.equal(urls.length, 3);
  assert.ok(urls.every((url) => !url.endsWith('/tracks')));
});

test('Apple and Deezer share one parent budget rather than restarting it on fallback', async () => {
  let calls = 0;
  const slow = async (_, { signal }) => {
    calls++;
    return { ok: true, json: () => waitForAbort(signal) };
  };
  const apple = await provider('apple', slow);
  const deezer = await provider('deezer', slow);
  const signal = AbortSignal.timeout(25);
  assert.equal(await apple.findAppleTrackMetaByQuery('Indila', 'Dernière Danse', { signal, timeoutMs: 1000 }), null);
  assert.equal(await deezer.findDeezerTrackMetaByQuery('Indila', 'Dernière Danse', { signal, timeoutMs: 1000 }), null);
  assert.equal(calls, 1);
});
