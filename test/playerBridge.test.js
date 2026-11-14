import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'

import { writeTrack, tmpDir, waitFor, silentLogger } from './fixtures/playerAudio.mjs'
import { startPlayerService, normalizeConfig } from '../modules/player/service.js'
import { createPlayerRouter } from '../modules/player/router.js'
import { BridgeError, collectJobOutputs } from '../modules/player/coreAdapter.js'
import { cleanTitleForMatch, primaryArtistKey, splitArtistFromTitle } from '../modules/player/matching.js'
import { mapDeezerTrack, mapYouTubeItem, mapSpotifyTrack, mergeOnlineItems, cleanYouTubeArtist } from '../modules/player/online.js'

// ---------------------------------------------------------------------------
// Fake Gharmonize core pipeline: jobs are driven explicitly by the test.

function createFakeCore({ outputDir }) {
  const jobs = new Map()
  const calls = { created: [], canceled: [], cleaned: [] }
  let seq = 0
  const core = {
    async inspect(url) {
      if (!/^https:\/\/(music\.youtube\.com|www\.deezer\.com|open\.spotify\.com)\//.test(url)) {
        throw new BridgeError('UNSUPPORTED_SOURCE', 'unsupported', { permanent: true })
      }
      const provider = url.includes('deezer') ? 'deezer' : url.includes('spotify') ? 'spotify' : 'youtube'
      // Mimic URL normalisation by the real core.
      return { provider, url: url.replace('music.youtube.com', 'www.youtube.com'), isPlaylist: !url.includes('/watch') && !url.includes('/track/') }
    },
    async createAndEnqueue({ url, preset, tag }) {
      if (core.failResolve) throw core.failResolve
      const id = `job-${++seq}`
      jobs.set(id, { status: 'queued', progress: 0, phase: 'queued', error: null, outputs: [], url, preset, tag })
      calls.created.push({ id, url, preset, tag })
      return { jobId: id, provider: 'youtube' }
    },
    async getJob(id) {
      const job = jobs.get(id)
      return job ? { ...job } : null
    },
    async cleanupJob(id) { calls.cleaned.push(id); return true },
    async cancel(id) {
      calls.canceled.push(id)
      const job = jobs.get(id)
      if (job) job.status = 'canceled'
    },
    // ---- test controls ----
    jobs,
    calls,
    progress(id, progress) { Object.assign(jobs.get(id), { status: 'processing', progress, phase: 'downloading' }) },
    complete(id, files) { Object.assign(jobs.get(id), { status: 'completed', progress: 100, outputs: files }) },
    fail(id, error = 'yt-dlp error') { Object.assign(jobs.get(id), { status: 'error', error }) },
    vanish(id) { jobs.delete(id) },
    produce(name, tags) { return writeTrack(path.join(outputDir, name), tags) },
    failResolve: null
  }
  return core
}

function fakeProvider(name, results) {
  return { name, available: () => true, async search(q, kind) { return (results[kind] || []).filter((i) => !q || true) } }
}

async function setup(t, { providers = [], config = {}, root = tmpDir('bridge'), core = null } = {}) {
  const downloads = path.join(root, 'outputs')
  fs.mkdirSync(downloads, { recursive: true })
  const fakeCore = core || createFakeCore({ outputDir: downloads })
  const service = await startPlayerService({
    env: {},
    logger: silentLogger,
    dataDir: path.join(root, 'data'),
    cacheDir: path.join(root, 'cache'),
    defaultLibraryDir: downloads,
    initialScanDelayMs: -1,
    core: fakeCore,
    bridgePollMs: 40,
    onlineOptions: { providers }
  })
  service.context.updateConfig({ ...config })
  await service.context.scanner.requestScan('all')
  const router = createPlayerRouter(service.context, {
    adminBridge: () => ({ getSession: () => false, verifyPassword: (pw) => pw === 'GharmonizeAdmin1' }),
    getMode: () => 'off'
  })
  const app = express()
  app.use(express.json())
  app.use('/api/player', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/player`
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    server.close()
    await service.stop()
  }
  t.after(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }) })

  const call = async (method, url, { body, token } = {}) => {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, body: json }
  }
  // First account (admin) + a device token for it.
  await call('POST', '/setup', { body: { username: 'admin', password: 'supersecret', adminPassword: 'GharmonizeAdmin1' } })
  const login = await call('POST', '/auth/login', { body: { username: 'admin', password: 'supersecret', client: 'device', deviceName: 'test' } })
  const admin = login.body.token
  return { service, core: fakeCore, call, admin, downloads, root, stop, base, bridge: service.context.bridge }
}

const ytTrack = (id, title, artist, extra = {}) => ({ kind: 'track', url: `https://music.youtube.com/watch?v=${id}`, title, artist, ...extra })

async function waitStatus(call, token, id, statuses) {
  const wanted = Array.isArray(statuses) ? statuses : [statuses]
  return waitFor(async () => {
    const r = await call('GET', `/downloads/${id}`, { token })
    return wanted.includes(r.body?.status) ? r.body : null
  }, { label: `download ${id} → ${wanted.join('/')}` })
}

// ---------------------------------------------------------------------------
// Pure units

test('title and artist folding for library matching', () => {
  assert.equal(cleanTitleForMatch('Firuze (Official Video)'), 'firuze')
  assert.equal(cleanTitleForMatch('Firuze [Lyrics | Şarkı Sözleri]'), 'firuze')
  assert.equal(cleanTitleForMatch('Firuze (Live)'), 'firuze live', 'version markers are kept')
  assert.equal(cleanTitleForMatch('Firuze (2019 Remastered)'), 'firuze')
  assert.equal(cleanTitleForMatch('Dans Et (feat. Kenan Doğulu)'), 'dans et')
  assert.equal(cleanTitleForMatch('Dans Et ft. Kenan Doğulu'), 'dans et')
  assert.equal(cleanTitleForMatch('Gülümse - Official Audio'), 'gulumse')
  assert.equal(primaryArtistKey('Sezen Aksu - Topic'), 'sezen aksu')
  assert.equal(primaryArtistKey('Sezen Aksu - 166M plays'), 'sezen aksu')
  assert.equal(primaryArtistKey('Tarkan & Sezen Aksu'), 'tarkan')
  assert.equal(primaryArtistKey('Ceza feat. Sagopa'), 'ceza')
  assert.deepEqual(splitArtistFromTitle('Sezen Aksu - Firuze (Lyrics)', 'Sezen Aksu'), { title: 'Firuze (Lyrics)', artist: 'Sezen Aksu' })
  assert.deepEqual(splitArtistFromTitle('Kara Sevda - Dizi Müziği', 'Toygar Işıklı'), { title: 'Kara Sevda - Dizi Müziği', artist: 'Toygar Işıklı' })
})

test('online provider mapping and merging', () => {
  const dz = mapDeezerTrack({ id: 1, title: 'Firuze', duration: 245, link: 'https://www.deezer.com/track/1', artist: { name: 'Sezen Aksu' }, album: { title: 'Firuze', cover_xl: 'https://x/c.jpg' } })
  assert.equal(dz.provider, 'deezer')
  assert.equal(dz.duration, 245)
  const yt = mapYouTubeItem({ id: 'abc', title: 'Sezen Aksu - Firuze (Lyrics | Şarkı Sözleri)', uploader: 'Sezen Aksu - 166M plays', url: 'https://music.youtube.com/watch?v=abc' }, 'track')
  assert.equal(yt.title, 'Firuze (Lyrics | Şarkı Sözleri)')
  assert.equal(yt.artist, 'Sezen Aksu')
  assert.equal(cleanYouTubeArtist('Tarkan - Topic'), 'Tarkan')
  const sp = mapSpotifyTrack({ id: 's1', name: 'Firuze', artists: [{ name: 'Sezen Aksu' }], album: { name: 'Firuze', images: [{ url: 'https://i/1.jpg' }], release_date: '1982-01-01' }, duration_ms: 244000, external_ids: { isrc: 'TRA000000001' }, external_urls: { spotify: 'https://open.spotify.com/track/s1' } })
  assert.equal(sp.isrc, 'TRA000000001')

  const merged = mergeOnlineItems([[yt], [dz], [sp]])
  assert.equal(merged.length, 1, 'the same song from three providers is merged')
  assert.equal(merged[0].provider, 'spotify', 'richest source wins')
  assert.equal(merged[0].isrc, 'TRA000000001')
  assert.deepEqual(merged[0].alternatives.map((a) => a.provider).sort(), ['deezer', 'youtube'])
})

test('core job outputs are resolved to audio files only', () => {
  const resolve = (p) => (String(p).startsWith('/download/') ? `/data/outputs/${decodeURIComponent(p.slice(10))}` : null)
  assert.deepEqual(collectJobOutputs({ resultPath: '/download/a%20b.mp3' }, resolve), ['/data/outputs/a b.mp3'])
  assert.deepEqual(collectJobOutputs({ resultPath: [{ outputPath: '/download/x.flac' }, { outputPath: '/download/x.zip' }, { path: '/download/y.m4a' }] }, resolve), ['/data/outputs/x.flac', '/data/outputs/y.m4a'])
  assert.deepEqual(collectJobOutputs({ resultPath: null }, resolve), [])
})

test('download config is validated', () => {
  const cfg = normalizeConfig({ downloadFormat: 'flac', downloadBitrate: '320k', maxParallelDownloads: 99, onlineProviders: 'youtube, bogus,DEEZER' })
  assert.equal(cfg.downloadFormat, 'flac')
  assert.equal(cfg.downloadBitrate, 'lossless')
  assert.equal(cfg.maxParallelDownloads, 10)
  assert.deepEqual(cfg.onlineProviders, ['deezer', 'youtube'])
  assert.equal(normalizeConfig({ downloadFormat: 'wma' }).downloadFormat, 'mp3')
})

// ---------------------------------------------------------------------------
// Bridge integration

test('download → core job → instant indexing → playlist', async (t) => {
  const { call, admin, core, downloads } = await setup(t)
  const pl = await call('POST', '/playlists', { token: admin, body: { name: 'Yeni' } })

  let r = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('a1', 'Firuze', 'Sezen Aksu'), playlistId: pl.body.id } })
  assert.equal(r.status, 202)
  const id = r.body.id
  const dl = await waitStatus(call, admin, id, 'downloading')
  assert.equal(core.calls.created.length, 1)
  assert.deepEqual(core.calls.created[0].preset, { format: 'mp3', bitrate: '320k', lyrics: true })
  assert.equal(core.calls.created[0].tag, id)

  const jobId = core.calls.created[0].id
  core.progress(jobId, 42.5)
  await waitFor(async () => (await call('GET', `/downloads/${id}`, { token: admin })).body.progress === 42.5, { label: 'progress' })

  // Files written by the job are fresh (just modified) — indexFiles must still take them.
  const file = writeTrack(path.join(downloads, 'Sezen Aksu - Firuze.mp3'), { title: 'Firuze', artist: 'Sezen Aksu', album: 'Firuze' }, { fresh: true })
  core.complete(jobId, [file])
  const done = await waitStatus(call, admin, id, 'completed')
  assert.equal(done.trackIds.length, 1)
  assert.equal(dl.provider, 'youtube')

  r = await call('GET', `/tracks/${done.trackIds[0]}`, { token: admin })
  assert.equal(r.body.title, 'Firuze')
  r = await call('GET', `/playlists/${pl.body.id}`, { token: admin })
  assert.deepEqual(r.body.tracks.map((x) => x.id), done.trackIds, 'downloaded track was added to the playlist')

  // Asking again finds it in the library: no second download.
  r = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('zz', 'Firuze (Official Video)', 'Sezen Aksu - Topic') } })
  assert.equal(r.status, 200)
  assert.equal(r.body.status, 'exists')
  assert.deepEqual(r.body.trackIds, done.trackIds)
  assert.equal(core.calls.created.length, 1)

  // force=true downloads anyway.
  r = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('zz', 'Firuze', 'Sezen Aksu'), force: true } })
  assert.equal(r.status, 202)
})

test('same link twice joins the running download', async (t) => {
  const { call, admin, core } = await setup(t)
  const a = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('dup', 'Song', 'Artist') } })
  // The second request uses the raw (un-normalised) link from search results.
  const b = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('dup', 'Song', 'Artist') } })
  assert.equal(a.body.id, b.body.id)
  await waitStatus(call, admin, a.body.id, 'downloading')
  assert.equal(core.calls.created.length, 1)
})

test('transient failures retry with backoff, then fail; permanent ones fail fast', async (t) => {
  const { call, admin, core, service, bridge } = await setup(t)
  const r = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('f1', 'Flaky', 'Artist') } })
  const id = r.body.id
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitStatus(call, admin, id, 'downloading')
    core.fail(core.calls.created.at(-1).id, `boom ${attempt}`)
    const after = await waitStatus(call, admin, id, attempt < 3 ? 'queued' : 'failed')
    assert.equal(after.attempts, attempt)
    assert.equal(after.error.code, 'CORE_JOB_FAILED')
    if (attempt < 3) {
      assert.equal(after.phase, 'retry-wait')
      assert.ok(after.nextAttemptAt > Date.now() + 10_000, 'retry is delayed')
      service.context.db.prepare('UPDATE downloads SET next_attempt_at = 0 WHERE id = ?').run(id)
      await bridge.tick()
    }
  }
  assert.equal(core.calls.created.length, 3)
  assert.deepEqual(core.calls.cleaned, core.calls.created.map((c) => c.id), 'every failed job folder is cleaned up')

  // Manual retry starts over.
  let again = await call('POST', `/downloads/${id}/retry`, { token: admin })
  assert.equal(again.body.status, 'queued')
  assert.equal(again.body.attempts, 0)
  await waitStatus(call, admin, id, 'downloading')

  // Unsupported links are rejected before anything is queued.
  again = await call('POST', '/downloads', { token: admin, body: { item: { kind: 'track', url: 'https://example.com/song.mp3', title: 'x' } } })
  assert.equal(again.status, 400)
  assert.equal(again.body.error.code, 'UNSUPPORTED_SOURCE')

  // A permanent resolve error (e.g. bad Spotify link) does not retry.
  core.failResolve = new BridgeError('SOURCE_EMPTY', 'empty', { permanent: true })
  const p = await call('POST', '/downloads', { token: admin, body: { item: { kind: 'album', url: 'https://www.deezer.com/album/9', title: 'Empty', artist: 'Nobody' } } })
  const failed = await waitStatus(call, admin, p.body.id, 'failed')
  assert.equal(failed.attempts, 1)
  assert.equal(failed.error.code, 'SOURCE_EMPTY')
})

test('vanished core jobs (server restart) are re-run; finished ones are picked up after restart', async (t) => {
  const root = tmpDir('restart')
  const first = await setup(t, { root })
  const { call, admin, core } = first
  const a = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('r1', 'Lost', 'Artist') } })
  await waitStatus(call, admin, a.body.id, 'downloading')
  core.vanish(core.calls.created[0].id)
  const requeued = await waitStatus(call, admin, a.body.id, 'queued')
  assert.equal(requeued.error.code, 'INTERRUPTED')

  // A job that completes while the player is stopped is indexed after start.
  const b = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('r2', 'Survivor', 'Artist') } })
  await waitStatus(call, admin, b.body.id, 'downloading')
  const jobB = core.calls.created.find((c) => c.url.includes('r2')).id
  await first.stop()
  const file = core.produce('Artist - Survivor.mp3', { title: 'Survivor', artist: 'Artist' })
  core.complete(jobB, [file])

  const service = await startPlayerService({
    env: {}, logger: silentLogger, dataDir: path.join(root, 'data'), cacheDir: path.join(root, 'cache'),
    defaultLibraryDir: first.downloads, initialScanDelayMs: -1, core, bridgePollMs: 40, onlineOptions: { providers: [] }
  })
  t.after(() => service.stop())
  const row = await waitFor(() => {
    const r = service.context.db.prepare('SELECT status, result_track_ids FROM downloads WHERE id = ?').get(b.body.id)
    return r.status === 'completed' ? r : null
  }, { label: 'finalize after restart' })
  assert.equal(JSON.parse(row.result_track_ids).length, 1)
})

test('cancel, parallel limit and per-user queue limit', async (t) => {
  const { call, admin, core, service } = await setup(t, { config: { maxParallelDownloads: 2, maxQueuedPerUser: 4 } })
  const ids = []
  for (const n of [1, 2, 3, 4]) ids.push((await call('POST', '/downloads', { token: admin, body: { item: ytTrack(`p${n}`, `Song ${n}`, 'Artist') } })).body.id)
  await waitFor(() => core.calls.created.length === 2, { label: 'two started' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(core.calls.created.length, 2, 'never more than maxParallelDownloads in the core queue')

  const over = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('p5', 'Song 5', 'Artist') } })
  assert.equal(over.status, 429)
  assert.equal(over.body.error.code, 'TOO_MANY_DOWNLOADS')

  const first = await waitStatus(call, admin, ids[0], 'downloading')
  const canceled = await call('POST', `/downloads/${first.id}/cancel`, { token: admin })
  assert.equal(canceled.body.status, 'canceled')
  assert.deepEqual(core.calls.canceled, [core.calls.created[0].id])
  await waitFor(() => core.calls.created.length === 3, { label: 'next one starts after cancel' })

  const list = await call('GET', '/downloads?active=1', { token: admin })
  assert.equal(list.body.items.length, 3)
  void service
})

test('download permissions and library guards', async (t) => {
  const { call, admin, core, service, downloads } = await setup(t)
  const ayseUser = (await call('POST', '/admin/users', { token: admin, body: { username: 'ayse', password: 'anothersecret' } })).body
  assert.equal(ayseUser.canDownload, false, 'new users cannot download by default')
  const ayse = (await call('POST', '/auth/login', { body: { username: 'ayse', password: 'anothersecret', client: 'device' } })).body.token

  let r = await call('POST', '/downloads', { token: ayse, body: { item: ytTrack('u1', 'Song', 'Artist') } })
  assert.equal(r.status, 403, 'downloading is a per-user right')
  r = await call('GET', '/online/providers', { token: ayse })
  assert.equal(r.body.canDownload, false)

  const granted = await call('PATCH', `/admin/users/${ayseUser.id}`, { token: admin, body: { canDownload: true } })
  assert.equal(granted.body.canDownload, true)
  r = await call('GET', '/online/providers', { token: ayse })
  assert.equal(r.body.canDownload, true)
  r = await call('POST', '/downloads', { token: ayse, body: { item: ytTrack('u1', 'Song', 'Artist') } })
  assert.equal(r.status, 202)
  const forbidden = await call('GET', `/downloads/${r.body.id}`, { token: admin })
  assert.equal(forbidden.status, 200, 'admins see everyone\'s downloads')
  const mine = await call('GET', '/downloads', { token: ayse })
  assert.equal(mine.body.items.length, 1)

  // Files outside every library cannot be shown in the player.
  const job = (await waitStatus(call, ayse, r.body.id, 'downloading'))
  void job
  const outside = writeTrack(path.join(path.dirname(downloads), 'elsewhere', 'x.mp3'), { title: 'X' })
  core.complete(core.calls.created.at(-1).id, [outside])
  const failed = await waitStatus(call, ayse, r.body.id, 'failed')
  assert.equal(failed.error.code, 'NOT_IN_LIBRARY')

  // Disabled download library → refuse before downloading anything.
  const def = (await call('GET', '/admin/libraries', { token: admin })).body.items.find((l) => l.isDefault)
  await call('PATCH', `/admin/libraries/${def.id}`, { token: admin, body: { enabled: false } })
  r = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('u2', 'Other', 'Artist') } })
  assert.equal(r.status, 409)
  assert.equal(r.body.error.code, 'DEFAULT_LIBRARY_DISABLED')

  await call('PATCH', '/admin/config', { token: admin, body: { downloadsEnabled: false } })
  r = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('u3', 'Third', 'Artist') } })
  assert.equal(r.status, 403)
  void service
})

test('album requests use the library when the album is already complete', async (t) => {
  const root = tmpDir('album')
  writeTrack(path.join(root, 'outputs', 'A', '01.mp3'), { title: 'One', artist: 'Band', album: 'Record', trackNumber: '1' })
  writeTrack(path.join(root, 'outputs', 'A', '02.mp3'), { title: 'Two', artist: 'Band', album: 'Record', trackNumber: '2' })
  const { call, admin, core } = await setup(t, { root })
  let r = await call('POST', '/downloads', { token: admin, body: { item: { kind: 'album', url: 'https://www.deezer.com/album/1', title: 'Record', artist: 'Band', trackCount: 2 } } })
  assert.equal(r.body.status, 'exists')
  assert.equal(r.body.trackIds.length, 2)
  // The online album has more tracks than we own → download it.
  r = await call('POST', '/downloads', { token: admin, body: { item: { kind: 'album', url: 'https://www.deezer.com/album/1', title: 'Record', artist: 'Band', trackCount: 12 } } })
  assert.equal(r.status, 202)
  await waitStatus(call, admin, r.body.id, 'downloading')
  assert.equal(core.calls.created.length, 1)
})

test('online search merges providers and badges library / download state', async (t) => {
  const root = tmpDir('online')
  writeTrack(path.join(root, 'outputs', 'Firuze.mp3'), { title: 'Firuze', artist: 'Sezen Aksu', album: 'Firuze' })
  const providers = [
    fakeProvider('deezer', {
      track: [
        { provider: 'deezer', kind: 'track', id: '1', title: 'Firuze', artist: 'Sezen Aksu', url: 'https://www.deezer.com/track/1', duration: 1 },
        { provider: 'deezer', kind: 'track', id: '2', title: 'Gülümse', artist: 'Sezen Aksu', url: 'https://www.deezer.com/track/2' }
      ],
      album: [{ provider: 'deezer', kind: 'album', id: '9', title: 'Firuze', artist: 'Sezen Aksu', url: 'https://www.deezer.com/album/9', trackCount: 1 }]
    }),
    fakeProvider('youtube', {
      track: [{ provider: 'youtube', kind: 'track', id: 'y', title: 'Firuze (Official Video)', artist: 'Sezen Aksu', url: 'https://music.youtube.com/watch?v=y' }]
    }),
    { name: 'spotify', available: () => true, async search() { throw new Error('quota') } }
  ]
  const { call, admin } = await setup(t, { root, providers })
  await call('POST', '/downloads', { token: admin, body: { item: { kind: 'track', url: 'https://www.deezer.com/track/2', title: 'Gülümse', artist: 'Sezen Aksu' } } })

  const r = await call('GET', `/online/search?q=${encodeURIComponent('sezen aksu')}`, { token: admin })
  assert.equal(r.status, 200)
  assert.equal(r.body.providers.spotify.ok, false, 'a failing provider does not break the search')
  assert.equal(r.body.tracks.length, 2, 'YouTube + Deezer "Firuze" are merged')
  const firuze = r.body.tracks.find((x) => x.title === 'Firuze')
  assert.ok(firuze.library?.trackId, 'already in the library')
  assert.equal(firuze.alternatives[0].provider, 'youtube')
  const gulumse = r.body.tracks.find((x) => x.title === 'Gülümse')
  assert.equal(gulumse.library, null)
  assert.ok(gulumse.download?.id, 'shows the running download')
  assert.ok(r.body.albums[0].library?.albumId)
})

test('live download events over SSE', async (t) => {
  const { call, admin, base } = await setup(t)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const res = await fetch(`${base}/downloads/events`, { headers: { authorization: `Bearer ${admin}` }, signal: controller.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const readUntil = async (needle) => waitFor(async () => {
    if (buffer.includes(needle)) return true
    const { value, done } = await reader.read()
    if (done) throw new Error('stream closed')
    buffer += decoder.decode(value, { stream: true })
    return buffer.includes(needle)
  }, { label: needle })
  await readUntil('event: ready')
  const r = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('sse', 'Live', 'Artist') } })
  await readUntil(`"id":"${r.body.id}"`)
  assert.match(buffer, /event: download/)
})

test('an album whose store title differs from the tags is not downloaded twice', async (t) => {
  const { call, admin, core, downloads } = await setup(t)
  const album = { kind: 'album', url: 'https://www.deezer.com/album/77', title: 'Wake Up', artist: 'Tarkan', trackCount: 1 }
  let r = await call('POST', '/downloads', { token: admin, body: { item: album } })
  assert.equal(r.status, 202)
  await waitStatus(call, admin, r.body.id, 'downloading')
  // The files are tagged "Wake Up - Single" (Apple naming).
  const file = writeTrack(path.join(downloads, 'Tarkan - Wake Up - mp3', 'Tarkan - Wake Up.mp3'), { title: 'Wake Up', artist: 'Tarkan', album: 'Wake Up - Single' }, { fresh: true })
  core.complete(core.calls.created[0].id, [file])
  const done = await waitStatus(call, admin, r.body.id, 'completed')

  r = await call('POST', '/downloads', { token: admin, body: { item: album } })
  assert.equal(r.body.status, 'exists', 'second request reuses the library')
  assert.deepEqual(r.body.trackIds, done.trackIds)
  assert.equal(core.calls.created.length, 1)

  // A different link of the same release is still recognised by its base title.
  r = await call('POST', '/downloads', { token: admin, body: { item: { ...album, url: 'https://www.deezer.com/album/78' } } })
  assert.equal(r.body.status, 'exists')
  assert.equal(core.calls.created.length, 1)
})

test('an unavailable YouTube upload switches once to a public copy of the same song', async (t) => {
  const { call, admin, core } = await setup(t)
  const asked = []
  core.findAlternative = async (query) => { asked.push(query); return 'https://www.youtube.com/watch?v=ALTERNATIVE' }
  const r = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('gone1', 'git', 'Blok3', { duration: 159 }) } })
  await waitStatus(call, admin, r.body.id, 'downloading')
  core.fail(core.calls.created.at(-1).id, 'All metadata attempts failed. Last error: [meta+nocookies] exit code 1 ERROR: [youtube] gone1: Video unavailable. This video is not available')
  await waitFor(() => (core.calls.created.length === 2 ? true : null), { label: 'job for the substitute' })
  assert.equal(core.calls.created[1].url, 'https://www.youtube.com/watch?v=ALTERNATIVE')
  assert.deepEqual(asked, [{ title: 'git', artist: 'Blok3', duration: 159, excludeUrl: 'https://www.youtube.com/watch?v=gone1' }])
  const switched = await waitStatus(call, admin, r.body.id, 'downloading')
  assert.equal(switched.attempts, 0, 'switching is not counted as a failed attempt')
  assert.equal(switched.requestedUrl, 'https://music.youtube.com/watch?v=gone1', 'the original link still identifies the download')

  // The substitute is unavailable too: no second switch and no pointless retries.
  core.fail(core.calls.created.at(-1).id, 'ERROR: [youtube] ALTERNATIVE: Video unavailable')
  const failed = await waitStatus(call, admin, r.body.id, 'failed')
  assert.equal(asked.length, 1)
  assert.equal(core.calls.created.length, 2)
  assert.equal(failed.attempts, 1)
})

test('an unavailable upload without a substitute fails at once instead of retrying', async (t) => {
  const { call, admin, core } = await setup(t)
  core.findAlternative = async () => null
  const r = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('gone2', 'Lost Song', 'Nobody') } })
  await waitStatus(call, admin, r.body.id, 'downloading')
  core.fail(core.calls.created.at(-1).id, 'ERROR: [youtube] gone2: Video unavailable. This video is not available')
  const failed = await waitStatus(call, admin, r.body.id, 'failed')
  assert.equal(failed.attempts, 1)
  assert.equal(core.calls.created.length, 1)
})
