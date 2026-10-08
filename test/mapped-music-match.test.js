import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  buildCatalogMusicSearchQueries,
  isCatalogMusicProvider,
  isCatalogTextDurationMatch,
  isMappedMusicDurationCompatible,
  scoreCatalogMusicCandidateText
} from '../modules/mappedMusicMatcher.js';

test('catalog providers share artist+title then title-only search queries', () => {
  for (const provider of ['spotify', 'apple', 'apple_music', 'deezer', 'tidal']) {
    assert.equal(isCatalogMusicProvider(provider), true, provider);
  }
  assert.equal(isCatalogMusicProvider('soundcloud'), false);
  assert.deepEqual(
    buildCatalogMusicSearchQueries('Ahmet Kaya', 'Hep Sonradan'),
    ['Ahmet Kaya Hep Sonradan', 'Hep Sonradan']
  );
});

test('collaborator credits match across commas, featuring and lead-artist channels', () => {
  for (const artist of ['Artist One, Artist Two', 'Artist One & Artist Two', 'Artist One feat. Artist Two', 'Artist One featuring Artist Two']) {
    const score = scoreCatalogMusicCandidateText(artist, 'Farewell', 'Artist One ft. Artist Two - Farewell (Official Audio)', 'Artist One');
    assert.ok(score >= 6, `${artist}: ${score}`);
  }
  assert.ok(scoreCatalogMusicCandidateText('Simon & Garfunkel', 'The Sound of Silence', 'Simon & Garfunkel - The Sound of Silence', 'Simon & Garfunkel') >= 6);
  assert.equal(scoreCatalogMusicCandidateText('Artist One, Artist Two', 'Farewell', 'Completely Different Song', 'Artist One'), 0);
});

test('release/project context differs without changing the musical identity', () => {
  const cases = [
    ['Zeynep Başkan', 'Var Git Ölüm - Yolcu - Orijinal Proje Müzikleri Vol.1', 'Zeynep Başkan – Var Git Ölüm | YOLCU (Orijinal Proje) – Vol.1 | Official Lyric Video'],
    ['Sümer Ezgü', 'Mecnuna Dönmüşüm - Yolcu - Orijinal Proje Müzikleri Vol.1', 'Sümer Ezgü – Mecnuna Dönmüşüm | YOLCU (Orijinal Proje) – Vol.1 | Official Lyric Video'],
    ['Example Composer', 'Nightfall - Film Name - Original Motion Picture Soundtrack', 'Example Composer - Nightfall (Official Audio)'],
    ['Example Composer', 'Nightfall (Original Soundtrack)', 'Example Composer - Nightfall'],
    ['Example Composer', 'Nightfall', 'Nightfall [Original Project Music]'],
  ];
  for (const [artist, source, candidate] of cases) {
    assert.ok(scoreCatalogMusicCandidateText(artist, source, candidate, artist) >= 6, source);
  }
  assert.ok(scoreCatalogMusicCandidateText('Sedat Anar, Uğur Önür', 'Veda', 'Sedat Anar ft. Uğur Önür - Veda ', 'Sedat Anar') >= 6);
});

test('cleaned identity cannot boost unrelated artists, songs or musical versions', () => {
  assert.equal(scoreCatalogMusicCandidateText('Original Artist', 'Farewell - Collection - Original Soundtrack', 'Other Artist - Farewell', 'Other Artist'), 0);
  for (const version of ['Live', 'Acoustic', 'Akustik', 'Remix', 'Cover', 'Instrumental', 'Karaoke', 'Slowed', 'Radio Edit', 'Extended', '2.0']) {
    assert.equal(scoreCatalogMusicCandidateText('Original Artist', 'Farewell', `Original Artist - Farewell (${version})`, 'Original Artist'), 0, version);
    assert.equal(scoreCatalogMusicCandidateText('Original Artist', `Farewell (${version})`, 'Original Artist - Farewell', 'Original Artist'), 0, version);
  }
  assert.equal(scoreCatalogMusicCandidateText('Original Artist', 'Farewell 2.0', 'Original Artist - Farewell 3.0', 'Original Artist'), 0);
  assert.ok(scoreCatalogMusicCandidateText('Original Artist', 'Farewell (Acoustic)', 'Original Artist - Farewell (Akustik)', 'Original Artist') >= 6);
  assert.ok(scoreCatalogMusicCandidateText('Original Artist', 'Farewell (Live)', 'Original Artist - Farewell (Live)', 'Original Artist') >= 6);
  assert.equal(scoreCatalogMusicCandidateText('Composer', 'Concerto - Allegro - Original Soundtrack', 'Composer - Concerto - Adagio - Original Soundtrack', 'Composer'), 0);
  assert.equal(scoreCatalogMusicCandidateText('Composer', 'Concerto - Part 1 - Original Soundtrack', 'Composer - Concerto - Part 2 - Original Soundtrack', 'Composer'), 0);
  assert.deepEqual(buildCatalogMusicSearchQueries('Artist', 'and - Farewell'), ['Artist and - Farewell', 'and - Farewell'], 'a conjunction alone is not an artist credit');
});

test('queries add bounded clean-title and lead-artist fallbacks without deleting versions', () => {
  const queries = buildCatalogMusicSearchQueries('Artist One, Artist Two', 'Farewell - Collection - Original Project Music Vol.1');
  assert.deepEqual(queries.slice(0, 2), ['Artist One, Artist Two Farewell - Collection - Original Project Music Vol.1', 'Farewell - Collection - Original Project Music Vol.1']);
  assert.ok(queries.includes('Artist One, Artist Two Farewell'));
  assert.ok(queries.includes('Artist One Farewell'));
  assert.ok(queries.length <= 5);
  assert.ok(buildCatalogMusicSearchQueries('Artist', 'Farewell 2.0').every((query) => query.includes('2.0')));
  assert.ok(buildCatalogMusicSearchQueries('Artist', 'Farewell - Acoustic - Original Soundtrack').every((query) => query.includes('Acoustic')));
});

test('duration tolerance accepts reasonable intro/outro differences but still bounds excerpts', () => {
  assert.equal(isMappedMusicDurationCompatible(180000, 220), true); // +40s, previously rejected
  assert.equal(isMappedMusicDurationCompatible(600000, 725), true); // +20.8%, previously rejected
  assert.equal(isMappedMusicDurationCompatible(60000, 150), false);
  assert.equal(isMappedMusicDurationCompatible(60000, 128), false);
  assert.equal(isMappedMusicDurationCompatible(180000, 120), false);
  assert.equal(isMappedMusicDurationCompatible(180000, 600), false);
  assert.equal(isCatalogTextDurationMatch(4, 180000, 191), true);
  assert.equal(isCatalogTextDurationMatch(4, 180000, 220), false);
  assert.equal(isMappedMusicDurationCompatible(180000, 220, { baseToleranceSec: 10, ratioTolerance: 0.05 }), false);
});

test('a negative search expires while a recent positive match remains reusable', () => {
  const source = fs.readFileSync(new URL('../modules/sp.js', import.meta.url), 'utf8');
  const cache = source.slice(source.indexOf('function _cacheGet'), source.indexOf('const SEARCH_CHAR_FOLD_MAP'));
  let now = 1000;
  const context = vm.createContext({ _searchCache: new Map(), _SEARCH_CACHE_MAX: 800, Date: { now: () => now } });
  vm.runInContext(cache + '\nglobalThis.get = _cacheGet; globalThis.set = _cacheSet;', context);
  context.set('missing', null);
  context.set('found', { id: 'good' });
  assert.equal(context.get('missing'), null);
  assert.equal(context.get('found').id, 'good');
  now += 30001;
  assert.equal(context.get('missing'), undefined);
  assert.equal(context.get('found').id, 'good');
  now += 30 * 60 * 1000;
  assert.equal(context.get('found'), undefined);
});

test('the real search loop accepts recovered candidates for every catalogue provider', async () => {
  const source = fs.readFileSync(new URL('../modules/sp.js', import.meta.url), 'utf8');
  const search = source.slice(source.indexOf('export async function searchYtmBestMatch'), source.indexOf('// Backward-compatible id-only API')).replace(/^export /, '');
  const fixtures = [
    { artist: 'Sedat Anar, Uğur Önür', title: 'Veda', duration_ms: 99534,
      entry: { id: '2CzRCsLhIfY', title: 'Sedat Anar ft. Uğur Önür - Veda', uploader: 'Sedat Anar', duration: 100 } },
    { artist: 'Zeynep Başkan', title: 'Var Git Ölüm - Yolcu - Orijinal Proje Müzikleri Vol.1', duration_ms: 198725,
      entry: { id: 'h78G8t5eZAA', title: 'Zeynep Başkan – Var Git Ölüm | YOLCU (Orijinal Proje) – Vol.1 | Official Lyric Video', uploader: 'Hasan Basri Yapım and zeynep baskan', duration: 199 } },
    { artist: 'Sümer Ezgü', title: 'Mecnuna Dönmüşüm - Yolcu - Orijinal Proje Müzikleri Vol.1', duration_ms: 183597,
      entry: { id: 'zrA_vAW-Kv8', title: 'Sümer Ezgü – Mecnuna Dönmüşüm | YOLCU (Orijinal Proje) – Vol.1 | Official Lyric Video', uploader: 'Hasan Basri Yapım and Sümer Ezgü', duration: 187 } },
    { artist: 'Wosti INC.', title: 'İçimdeki Sen 2.0', duration_ms: 60209,
      entry: { id: 'EJcUNEMmJkw', title: 'TUĞÇE KANDEMİR X TALADRO - İÇİMDEKİ SEN 2.0', uploader: 'Wolker Production', duration: 150 }, rejected: true },
  ];
  for (const provider of ['spotify', 'apple', 'apple_music', 'deezer', 'tidal', 'text']) {
    for (const row of fixtures) {
      let requests = 0;
      const context = vm.createContext({
        buildMappedMusicSearchQueries: (artist, title) => buildCatalogMusicSearchQueries(artist, title),
        sourceDurationMs: (item) => item.duration_ms, _normMatch: (value) => value.toLowerCase(),
        _cacheGet: () => undefined, _cacheSet: () => {}, isCatalogMusicProvider,
        MAPPED_MUSIC_YT_SEARCH_RESULTS: 5, YT_SEARCH_RESULTS: 3,
        source: row,
        runMappedMusicSearchQuery: async () => { requests++; return { entries: [row.entry] }; },
        isYouTubeSearchRateLimitError: () => false,
        scoreSearchEntries: (entries, artist, title, { sourceMs }) => entries
          .filter((entry) => isMappedMusicDurationCompatible(sourceMs, entry.duration))
          .map((entry) => ({ entry, score: scoreCatalogMusicCandidateText(artist, title, entry.title, entry.uploader) })),
        verifyCatalogCandidate: async (entry) => entry,
        youtubeMatchFromEntry: (entry) => entry,
        entryDurationSeconds: (entry) => entry.duration, isCatalogTextDurationMatch,
        isMappedMusicDurationTight: () => true,
      });
      vm.runInContext(search + '\nglobalThis.search = searchYtmBestMatch;', context);
      const result = await context.search(row.artist, row.title, { provider, sourceItem: row });
      assert.equal(result?.id || null, row.rejected ? null : row.entry.id, `${provider}: ${row.title}`);
      if (!row.rejected) assert.equal(requests, 1, 'successful first query must not trigger fallbacks');
    }
  }
});

test('catalog duration guard accepts release variation but rejects long false matches', () => {
  assert.equal(isMappedMusicDurationCompatible(217733, 218), true);
  assert.equal(isMappedMusicDurationCompatible(316813, 317), true);
  assert.equal(isMappedMusicDurationCompatible(325683, 276), true);
  assert.equal(isMappedMusicDurationCompatible(321364, 295), true);
  assert.equal(isMappedMusicDurationCompatible(187546, 47 * 60), false);
  assert.equal(isMappedMusicDurationCompatible(171207, 60 * 60), false);
});

test('catalog weak text matches require very close duration and zero-score never passes', () => {
  assert.equal(isCatalogTextDurationMatch(6, 217733, 240), true);
  assert.equal(isCatalogTextDurationMatch(4, 217733, 218), true);
  assert.equal(isCatalogTextDurationMatch(4, 217733, 260), false);
  assert.equal(isCatalogTextDurationMatch(0, 217733, 218), false);
});


test('catalog scoring tolerates spacing variants and prefers concise YouTube titles', () => {
  const clean = scoreCatalogMusicCandidateText(
    'Ahmet Kaya',
    'Öyle Bir Yerdeyimki',
    'Öyle Bir Yerdeyim ki (Ahmet Kaya)',
    'Ahmet Kaya - Topic'
  );
  const noisy = scoreCatalogMusicCandidateText(
    'Ahmet Kaya',
    'Öyle Bir Yerdeyimki',
    'Ahmet Kaya Selda Bağcan öyle bir yerdeyimki KARADAYI dizi',
    'Karadayı Dizi'
  );

  assert.ok(clean > noisy, `clean=${clean} noisy=${noisy}`);
});

test('catalog search and scoring treat Cafe/Kafe as the same safe title spelling', () => {
  assert.deepEqual(
    buildCatalogMusicSearchQueries('Bulutsuzluk Özlemi', 'Bağdat Cafe'),
    [
      'Bulutsuzluk Özlemi Bağdat Cafe',
      'Bağdat Cafe',
      'Bulutsuzluk Özlemi Bağdat kafe',
      'Bağdat kafe'
    ]
  );
  const score = scoreCatalogMusicCandidateText(
    'Bulutsuzluk Özlemi',
    'Bağdat Cafe',
    'Bağdat Kafe',
    'Bulutsuzluk Özlemi - Topic'
  );
  assert.ok(score >= 6, `score=${score}`);
});
