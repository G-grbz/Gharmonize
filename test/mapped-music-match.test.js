import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  buildCatalogMusicSearchQueries,
  isCatalogMusicProvider,
  isCatalogTextDurationMatch,
  isMappedMusicDurationCompatible,
  mappedMusicMatchMode,
  MAPPED_MUSIC_YT_STRICT_MATCH_SCORE,
  hasMusicArtistEvidence,
  isPlausibleMusicDuration,
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

function matcherScenario({ songs = () => [], videos = () => [], counts = null } = {}) {
  const source = fs.readFileSync(new URL('../modules/sp.js', import.meta.url), 'utf8');
  const helpers = source.slice(source.indexOf('const MUSIC_DURATION_WINDOW_SEC'), source.indexOf('async function waitForCatalogSearchCooldown'));
  const search = source.slice(source.indexOf('export async function searchYtmBestMatch'), source.indexOf('// Backward-compatible id-only API')).replace(/^export /, '');
  const cache = new Map();
  const context = vm.createContext({
    buildMappedMusicSearchQueries: buildCatalogMusicSearchQueries,
    sourceDurationMs: (item) => item.duration_ms, _normMatch: (value) => String(value).toLowerCase(),
    _cacheGet: (key) => cache.get(key), _cacheSet: (key, value) => cache.set(key, value),
    isCatalogMusicProvider, mappedMusicMatchMode, MAPPED_MUSIC_YT_STRICT_MATCH_SCORE,
    MAPPED_MUSIC_YT_SEARCH_RESULTS: 5, YT_SEARCH_RESULTS: 3,
    uniqueSearchQueries: (values) => [...new Set(values.filter(Boolean))],
    searchYouTubeMusicSongs: async (query) => { if (counts) counts.songs++; return songs(query); },
    runMappedMusicSearchQuery: async (query) => { if (counts) counts.videos++; return { entries: videos(query) }; },
    hasMusicArtistEvidence, isPlausibleMusicDuration, isMappedMusicDurationCompatible,
    SOUNDCLOUD_YT_MIN_MATCH_SCORE: 6,
    isYouTubeSearchRateLimitError: () => false,
    scoreSearchEntries: (entries, artist, title) => entries
      .map((entry) => ({ entry, score: scoreCatalogMusicCandidateText(artist, title, entry.title, entry.uploader) })),
    youtubeMatchFromEntry: (entry, song) => entry && { ...entry, song: Boolean(song) },
    entryDurationSeconds: (entry) => entry.duration, isCatalogTextDurationMatch
  });
  vm.runInContext(helpers + search + '\nglobalThis.search = searchYtmBestMatch;', context);
  return context.search;
}

test('the real search loop accepts recovered candidates for every catalogue provider', async () => {
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
      const search = matcherScenario({ videos: () => [row.entry] });
      const result = await search(row.artist, row.title, { provider, sourceItem: row });
      assert.equal(result?.id || null, row.rejected ? null : row.entry.id, provider + ': ' + row.title);
    }
  }
});

test('Songs take priority and catalogue edits rank by source duration with video fallback', async () => {
  const title = 'Gül Tükendi, Ben Tükendim';
  const artist = 'Kıvırcık Ali';
  const entry = (id, duration) => ({ id, duration, title, uploader: artist });
  const search = matcherScenario({
    songs: () => [entry('far', 360), entry('within-one-second', 348), entry('alternate-edit', 310)],
    videos: () => [entry('video', 347)]
  });
  const source = (provider, duration_ms, format = 'mp3') => ({ provider, format, sourceItem: { duration_ms } });
  assert.equal((await search(artist, title, source('deezer', 347000))).id, 'within-one-second');
  assert.equal((await search(artist, title, source('spotify', 310000))).id, 'alternate-edit');
  assert.equal((await search(artist, title, source('deezer', 347000, 'mp4'))).id, 'video');
  assert.equal((await search(artist, title, source('deezer', 347000, 'mkv'))).song, true);
  const videoOnly = matcherScenario({ videos: () => [entry('video-at-six-minutes', 360)] });
  assert.equal((await videoOnly(artist, title, source('deezer', 347000))).id, 'video-at-six-minutes');
});

test('a cover by another artist never beats the original because it is a second closer', async () => {
  const title = 'Gül Tükendi, Ben Tükendim';
  const artist = 'Kıvırcık Ali';
  const search = matcherScenario({
    songs: () => [
      { id: 'cover', duration: 347, title, uploader: 'Başka Sanatçı' },
      { id: 'original', duration: 348, title, uploader: artist }
    ]
  });
  const match = await search(artist, title, { provider: 'deezer', sourceItem: { duration_ms: 347000 } });
  assert.equal(match.id, 'original');
  assert.equal(match.song, true);
});

test('within a few seconds the stronger match wins; 5:40-5:50 is never skipped for 6:00', async () => {
  const title = 'Gül Tükendi, Ben Tükendim';
  const artist = 'Kıvırcık Ali';
  const search = matcherScenario({
    songs: () => [
      { id: 'six-minutes', duration: 360, title, uploader: artist },
      { id: 'five-fifty', duration: 350, title, uploader: artist }
    ]
  });
  assert.equal((await search(artist, title, { provider: 'deezer', sourceItem: { duration_ms: 347000 } })).id, 'five-fifty');
});

test('the closest credited video still downloads, but never an hour-long compilation', async () => {
  const title = 'Gül Tükendi, Ben Tükendim';
  const artist = 'Kıvırcık Ali';
  const source = { provider: 'deezer', sourceItem: { duration_ms: 347000 } };
  const compilation = matcherScenario({ videos: () => [{ id: 'one-hour', duration: 3600, title, uploader: artist }] });
  assert.equal(await compilation(artist, title, source), null);
  const both = matcherScenario({ videos: () => [
    { id: 'one-hour', duration: 3600, title, uploader: artist },
    { id: 'seven-minutes', duration: 420, title, uploader: artist }
  ] });
  assert.equal((await both(artist, title, source)).id, 'seven-minutes');
  assert.equal(isPlausibleMusicDuration(347000, 360), true);
  assert.equal(isPlausibleMusicDuration(347000, 694), true);
  assert.equal(isPlausibleMusicDuration(347000, 3600), false);
  assert.equal(isPlausibleMusicDuration(347000, 120), false);
  assert.equal(isPlausibleMusicDuration(0, 25 * 60), false);
  assert.equal(isPlausibleMusicDuration(0, 5 * 60), true);
});

test('a YouTube Music outage falls back to a video without remembering it', async () => {
  const title = 'Gül Tükendi, Ben Tükendim';
  const artist = 'Kıvırcık Ali';
  const counts = { songs: 0, videos: 0 };
  let down = true;
  const search = matcherScenario({
    counts,
    songs: () => {
      if (down) throw Object.assign(new Error('rate limited'), { code: 'YTM_RATE_LIMITED' });
      return [{ id: 'song', duration: 348, title, uploader: artist }];
    },
    videos: () => [{ id: 'video', duration: 347, title, uploader: artist }]
  });
  const source = { provider: 'deezer', sourceItem: { duration_ms: 347000 } };
  assert.equal((await search(artist, title, source)).id, 'video');
  down = false;
  const again = await search(artist, title, source);
  assert.equal(again.id, 'song');
  assert.equal(again.song, true);
});

test('artist evidence: byline, title, or a collaborator of a multi-artist credit', () => {
  assert.equal(hasMusicArtistEvidence('Kıvırcık Ali', 'Gül Tükendi', 'Kivircik Ali'), true);
  assert.equal(hasMusicArtistEvidence('Kıvırcık Ali', 'Kıvırcık Ali - Gül Tükendi', 'Some Channel'), true);
  assert.equal(hasMusicArtistEvidence('Kıvırcık Ali', 'Gül Tükendi', 'Başka Sanatçı'), false);
  assert.equal(hasMusicArtistEvidence('Ilkay Sencan, Mahmut Orhan', 'Şaşkın', 'Mahmut Orhan & Ilkay Sencan'), true);
  assert.equal(hasMusicArtistEvidence('Ilkay Sencan, Mahmut Orhan', 'Şaşkın', 'Mahmut Orhan'), true);
  assert.equal(hasMusicArtistEvidence('', 'Şaşkın', 'Mahmut Orhan'), false);
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
