import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeJobTiming, setTrackStage, getJobTiming, serializeJobTiming, resolveTimingTrack } from '../modules/jobTiming.js';
import { jobTimingMarkup, timingRowsMarkup, formatTimingDuration } from '../public/ui/JobTimingView.js';

function job() {
  const value = { id: 'job_12345678-1234-1234-1234-123456789abc', status: 'queued', currentPhase: 'queued', createdAt: 1000 };
  initializeJobTiming(value, null, 1000);
  return value;
}

test('parallel tracks have independent stages, repeated progress does not reset clocks', () => {
  const j = job();
  setTrackStage(j, 'track:0', 'downloading', { title: 'One' }, 1100);
  setTrackStage(j, 'track:1', 'matching', { title: 'Two' }, 1200);
  const snapshot = j.timing;
  setTrackStage(j, 'track:0', 'downloading', {}, 1300);
  assert.equal(j.timing, snapshot);
  setTrackStage(j, 'track:0', 'provider_metadata', {}, 2100);
  setTrackStage(j, 'track:1', 'error', {}, 2200);
  setTrackStage(j, 'track:0', 'converting', {}, 2500);
  setTrackStage(j, 'track:0', 'completed', {}, 3000);
  const rows = getJobTiming(j).tracks;
  assert.deepEqual(rows[0].stageMs, { downloading: 1000, provider_metadata: 400, converting: 500 });
  assert.deepEqual(rows[1].stageMs, { matching: 1000 });
  assert.equal(rows[0].endedAt - rows[0].startedAt, 1900);
  setTrackStage(j, 'track:1', 'completed', {}, 3100);
  assert.equal(getJobTiming(j).tracks[1].phase, 'error');
});

test('cancel/error closes active clocks and ignores late async completions', () => {
  for (const status of ['canceled', 'error']) {
    const j = job();
    setTrackStage(j, 'single', 'lyrics_search', {}, 1200);
    j.status = status;
    const snapshot = serializeJobTiming(j);
    setTrackStage(j, 'single', 'completed');
    j.currentPhase = 'completed';
    assert.deepEqual(serializeJobTiming(j), snapshot);
    assert.equal(snapshot.tracks[0].phase, status);
    assert.ok(snapshot.tracks[0].endedAt);
  }
});

test('completed batches do not pretend unfinished tracks succeeded, ready single conversions can finish', () => {
  const j = job();
  setTrackStage(j, 'track:0', 'ready');
  setTrackStage(j, 'track:1', 'queued');
  setTrackStage(j, 'track:2', 'not_found');
  j.status = 'completed';
  assert.deepEqual(getJobTiming(j).tracks.map(row => row.phase), ['completed', 'interrupted', 'not_found']);
});

test('a terminal phase label does not freeze tracks before the job status actually ends', () => {
  const j = job();
  setTrackStage(j, 'single', 'converting');
  j.currentPhase = 'completed';
  assert.equal(j.timing.endedAt, null);
  setTrackStage(j, 'single', 'ready');
  j.status = 'completed';
  assert.equal(getJobTiming(j).tracks[0].phase, 'completed');
  assert.ok(getJobTiming(j).tracks[0].endedAt);
});

test('stage re-entry accumulates retry/waiting separately without manufacturing success', () => {
  const j = job();
  setTrackStage(j, 'single', 'matching', {}, 1000);
  setTrackStage(j, 'single', 'waiting', {}, 1100);
  setTrackStage(j, 'single', 'matching', {}, 2100);
  setTrackStage(j, 'single', 'retrying', {}, 2200);
  setTrackStage(j, 'single', 'matching', {}, 2400);
  setTrackStage(j, 'single', 'not_found', {}, 2500);
  assert.deepEqual(getJobTiming(j).tracks[0].stageMs, { matching: 300, waiting: 1000, retrying: 200 });
});

test('compact snapshots prioritize running workers over a long queued list', () => {
  const j = job();
  for (let i = 0; i < 60; i++) setTrackStage(j, `track:${i}`, 'queued');
  setTrackStage(j, 'track:59', 'converting');
  assert.equal(j.timing.tracks.length, 24);
  assert.equal(j.timing.tracks[0].key, 'track:59');
  assert.equal(j.timing.counts.queued, 59);
});

test('SSE snapshots stay bounded, detailed rows are paginated and stored history restores', () => {
  const j = job();
  for (let i = 0; i < 1010; i++) setTrackStage(j, `track:${i}`, 'queued', { title: '<script>track</script>', artist: 'Artist', localPath: '/secret' });
  assert.equal(j.timing.trackCount, 1000);
  assert.equal(j.timing.truncated, true);
  assert.equal(j.timing.tracks.length, 24);
  assert.ok(JSON.stringify(j.timing).length < 12_000);
  assert.equal(getJobTiming(j, 999, 999).tracks.length, 1);
  assert.equal(getJobTiming(j, -5, 5).tracks.length, 5);
  assert.ok(!JSON.stringify(getJobTiming(j)).includes('/secret'));
  j.status = 'completed';
  const saved = JSON.parse(JSON.stringify(serializeJobTiming(j)));
  const restored = { id: j.id, status: 'completed', currentPhase: 'completed', createdAt: 1000 };
  initializeJobTiming(restored, saved);
  assert.deepEqual(serializeJobTiming(restored), saved);
  const copy = getJobTiming(restored);
  copy.tracks[0].stageMs.queued = 999;
  assert.notEqual(getJobTiming(restored).tracks[0].stageMs.queued, 999);
});

test('old completed jobs have no invented timings, child IDs resolve the right parent and slot', () => {
  const legacy = { status: 'completed', createdAt: 1000 };
  initializeJobTiming(legacy);
  assert.equal(getJobTiming(legacy), null);
  const j = job();
  const jobs = new Map([[j.id, j]]);
  resolveTimingTrack(jobs, `${j.id}_13`, { title: 'Track' })('converting');
  resolveTimingTrack(jobs, j.id, { title: 'Single' })('lyrics_embed');
  resolveTimingTrack(jobs, `${j.id}_v2`, { title: 'Video' })('converting');
  assert.deepEqual(getJobTiming(j).tracks.map(row => row.key), ['track:13', 'single', 'video:2']);
  assert.doesNotThrow(() => resolveTimingTrack(jobs, 'invalid')('converting'));
});

test('both browser timing views escape titles, labels and attributes, and format elapsed wall time', () => {
  const j = job();
  setTrackStage(j, 'single', 'downloading', { title: '<img src=x onerror=alert(1)>', artist: 'A&B' });
  const t = key => key;
  const markup = jobTimingMarkup(j, t);
  assert.match(markup, /&lt;img/);
  assert.ok(!markup.includes('<img'));
  assert.match(markup, /data-job-timing=/);
  assert.equal(jobTimingMarkup({ id: 'old' }, t), '');
  assert.ok(!timingRowsMarkup(getJobTiming(j), t).includes('<img'));
  assert.equal(formatTimingDuration(3_661_000), '1:01:01');
  assert.equal(formatTimingDuration(-1000), '0:00');
  for (const lang of ['tr', 'en', 'de', 'fr', 'es']) {
    const messages = JSON.parse(fs.readFileSync(new URL(`../public/lang/${lang}.json`, import.meta.url)));
    for (const phase of ['matching', 'youtube_metadata', 'provider_metadata', 'cover', 'lyrics_embed', 'retrying', 'not_found', 'cached']) {
      assert.ok(messages[`timing.phase.${phase}`]);
    }
  }
});

test('store persists timings and restores completed measurements without changing prior history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-job-timing-'));
  try {
    const env = { ...process.env, DATA_DIR: root, CACHE_DIR: root, JOBS_STATE_DIR: root };
    const script = `import fs from 'node:fs'; import path from 'node:path';
      import {createJob, markJobCompleted} from './modules/store.js';
      import {setTrackStage} from './modules/jobTiming.js';
      const out=path.join(process.env.DATA_DIR,'outputs'); fs.mkdirSync(out,{recursive:true});
      fs.writeFileSync(path.join(out,'test.mp3'),'test');
      const j=createJob({resultPath:'/download/test.mp3'}); setTrackStage(j,'single','converting');
      setTrackStage(j,'single','ready'); markJobCompleted(j); process.exit(0);`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, timeout: 15_000 });
    const result = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import {jobs} from './modules/store.js'; import {getJobTiming} from './modules/jobTiming.js';
       console.log(JSON.stringify(getJobTiming([...jobs.values()][0]))); process.exit(0);`], { env, encoding: 'utf8', timeout: 15_000 });
    const timing = JSON.parse(result.trim());
    assert.equal(timing.tracks[0].phase, 'completed');
    assert.ok(timing.endedAt);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('actual parallel mapper distinguishes no match from search failure and reports logical positions', async () => {
  const source = fs.readFileSync(new URL('../modules/sp.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function mapSpotifyToYtm(');
  const code = source.slice(start, source.indexOf('\n// ', start + 1)).replace('export ', '');
  const events = [];
  const context = vm.createContext({ isMusicEnabled: () => true, isCatalogMusicProvider: () => false,
    YT_SEARCH_STAGGER_MS: 0, MAPPED_MUSIC_YT_SEARCH_STAGGER_MS: 0,
    searchYtmBestMatch: async (_artist, title, options) => {
      if (title === 'Failure') throw new Error('API outage');
      if (title === 'No match') return null;
      options.onStage('waiting');
      options.onStage('matching');
      return { id: 'abcdefghijk' };
    } });
  vm.runInContext(`${code}\nglobalThis.map = mapSpotifyToYtm;`, context);
  const results = await context.map({ items: ['Found', 'No match', 'Failure'].map(title => ({ title, artist: 'Artist' })) }, () => {}, {
    concurrency: 3, onStage: (index, phase) => events.push([index, phase])
  });
  assert.ok(results[0].id);
  assert.equal(results[1].id, null);
  assert.equal(results[2].id, null);
  assert.deepEqual(events.filter(([index]) => index === 0).map(([, phase]) => phase), ['matching', 'waiting', 'matching', 'queued']);
  assert.deepEqual(events.filter(([index]) => index === 1).map(([, phase]) => phase), ['matching', 'not_found']);
  assert.deepEqual(events.filter(([index]) => index === 2).map(([, phase]) => phase), ['matching', 'error']);
});

test('actual timing endpoint preserves the application access gate and paginates; shared SSE stays compact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-timing-api-'));
  try {
    const stdout = execFileSync(process.execPath, [
      '--loader', new URL('./fixtures/localJobAccessLoader.mjs', import.meta.url).href,
      fileURLToPath(new URL('./fixtures/jobTimingApi.mjs', import.meta.url)), root
    ], { cwd: root, timeout: 30_000, maxBuffer: 1_000_000, encoding: 'utf8',
      env: { ...process.env, DATA_DIR: root, CACHE_DIR: path.join(root, 'cache') } });
    assert.match(stdout, /JOB_TIMING_API_OK/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cached matches report their own stage before downstream work and cache holes keep logical slots', async () => {
  const source = fs.readFileSync(new URL('../modules/mappedMusicCache.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('export async function mapMappedMusicWithCache(')).replace('export ', '');
  const events = [];
  const items = ['A', 'B', 'C'].map(title => ({ title, artist: 'Artist' }));
  const context = vm.createContext({
    getMappedMusicSourceKey: () => 'fixture', parseMappedMusicSourceKey: () => ({}),
    readMappedMusicManifest: () => ({ tracks: [{ sourceItemKey: 'A', youtubeId: 'aaaaaaaaaaa' }, { sourceItemKey: 'C', youtubeId: 'ccccccccccc' }] }),
    getMappedMusicSourceItemKey: item => item.title, getMappedMusicSourceItemId: () => '', getMappedMusicSourceItemUrl: () => '',
    isCatalogMusicProvider: () => false, toDurationMs: n => n || null,
    normalizeManifestEntry: entry => entry, mappedItemFromManifestEntry: (entry, index) => ({ ...entry, id: entry.youtubeId, index: index + 1 }),
    manifestEntryFromMatch: ({ sourceItem, matchItem, index }) => ({ sourceItemKey: sourceItem.title, youtubeId: matchItem.id, index }),
    writeMappedMusicManifest: manifest => ({ manifest }), safeString: v => v, nowIso: () => 'fixture',
    mapSpotifyToYtm: async (sp, update, options) => {
      assert.equal(sp.items.length, 1);
      options.onStage(0, 'matching', sp.items[0]);
      options.onStage(0, 'queued', sp.items[0]);
      update(0, { id: 'bbbbbbbbbbb' });
    }
  });
  vm.runInContext(`${code}\nglobalThis.map = mapMappedMusicWithCache;`, context);
  const result = await context.map({ provider: 'fixture', items }, { source: 'fixture', indexOffset: 10,
    onStage: (i, phase) => events.push([i, phase]), onUpdate: i => events.push([i, 'downstream']) });
  assert.equal(result.cacheHits, 2);
  assert.deepEqual(events.filter(([i]) => i === 0).map(([, phase]) => phase), ['queued', 'cached', 'queued', 'downstream']);
  assert.deepEqual(events.filter(([i]) => i === 1).map(([, phase]) => phase), ['queued', 'matching', 'queued', 'downstream']);
  assert.deepEqual(Array.from(result.items, item => item.index), [11, 12, 13]);
});

test('selected YouTube IDs enter the queue before workers and cancellation closes unstarted IDs', async () => {
  const source = fs.readFileSync(new URL('../modules/yt.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function downloadSelectedIdsParallel(');
  const code = source.slice(start, source.indexOf('\n// Downloads standard', start));
  const events = [];
  let canceled = false;
  const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb'];
  const context = vm.createContext({
    path, fs: { mkdirSync() {} }, getDownloadedFiles: () => [], process: { env: {} },
    normalizeConcurrency: () => 1, DEFAULT_FRAGMENT_CONCURRENCY: 1,
    idsToDownloadUrls: values => values.map(id => `https://www.youtube.com/watch?v=${id}`),
    runWithConcurrency: async () => {
      assert.deepEqual(events.map(event => event.phase), ['queued', 'queued']);
      canceled = true;
      throw new Error('CANCELED');
    }
  });
  vm.runInContext(`${code}\nglobalThis.download = downloadSelectedIdsParallel;`, context);
  await assert.rejects(context.download('yt-dlp', ids, 'fixture', '/tmp', null, {
    frozenEntries: [{ id: ids[0], index: 11 }, { id: ids[1], index: 42 }], onTrackStage: event => events.push(event)
  }, { isCanceled: () => canceled }), /CANCELED/);
  assert.deepEqual(events.map(event => [event.id, event.playlistIndex, event.phase]), [
    [ids[0], 11, 'queued'], [ids[1], 42, 'queued'], [ids[0], 11, 'canceled'], [ids[1], 42, 'canceled']
  ]);
});
