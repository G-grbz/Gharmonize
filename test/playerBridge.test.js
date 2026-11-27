import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'

import { writeTrack, tmpDir, waitFor, silentLogger } from './fixtures/playerAudio.mjs'
import { startPlayerService, normalizeConfig } from '../modules/player/service.js'
import { createPlayerRouter } from '../modules/player/router.js'
import { BridgeError, collectJobOutputs, jobSteps } from '../modules/player/coreAdapter.js'
import { getSetting, setSetting } from '../modules/player/db.js'
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
    async createAndEnqueue({ url, preset, tag, only = null }) {
      if (core.failResolve) throw core.failResolve
      const id = `job-${++seq}`
      jobs.set(id, { status: 'queued', progress: 0, phase: 'queued', error: null, outputs: [], url, preset, tag })
      calls.created.push({ id, url, preset, tag, only })
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
    async produce(name, tags, options) { return writeTrack(path.join(outputDir, name), tags, options) },
    failResolve: null
  }
  return core
}

function fakeProvider(name, results) {
  return { name, available: () => true, async search(q, kind) { return (results[kind] || []).filter((i) => !q || true) } }
}

async function setup(t, { providers = [], config = {}, root = tmpDir('bridge'), core = null, env = null } = {}) {
  const downloads = path.join(root, 'outputs')
  fs.mkdirSync(downloads, { recursive: true })
  const fakeCore = core || createFakeCore({ outputDir: downloads })
  const service = await startPlayerService({
    env: env || {},
    logger: silentLogger,
    dataDir: env ? null : path.join(root, 'data'),
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
  const file = await writeTrack(path.join(downloads, 'Sezen Aksu - Firuze.mp3'), { title: 'Firuze', artist: 'Sezen Aksu', album: 'Firuze' }, { fresh: true })
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

test('a playlist the library partly has downloads only its missing songs', async (t) => {
  const { call, admin, core, service } = await setup(t)
  const owned = await core.produce('Var Olan.mp3', { title: 'Var Olan', artist: 'Sanatçı', album: 'Albüm' })
  await service.context.scanner.indexFiles([owned])
  const playlist = { kind: 'playlist', url: 'https://www.deezer.com/playlist/77', title: 'Liste', trackCount: 3 }
  const song = (title, isrc = null) => ({ title, artist: 'Sanatçı', isrc, duration: title === 'Var Olan' ? null : 200 })

  // The client's list is stale: "Var Olan" arrived meanwhile and is skipped.
  let r = await call('POST', '/downloads', { token: admin, body: { item: { ...playlist, only: [song('Var Olan'), song('Eksik Bir', 'trabc1234567'), song('Eksik İki')] } } })
  assert.equal(r.status, 202)
  assert.equal(r.body.kind, 'playlist')
  await waitFor(() => core.calls.created.length === 1)
  assert.deepEqual(core.calls.created[0].only.map((s) => [s.title, s.isrc]), [['Eksik Bir', 'TRABC1234567'], ['Eksik İki', null]])
  const partial = await waitStatus(call, admin, r.body.id, 'downloading')

  // A whole-playlist request does not join the partial download …
  r = await call('POST', '/downloads', { token: admin, body: { item: playlist } })
  assert.notEqual(r.body.id, partial.id)
  await waitFor(() => core.calls.created.length === 2)
  assert.equal(core.calls.created[1].only, null)
  // … and every song already in the library: nothing is downloaded.
  r = await call('POST', '/downloads', { token: admin, body: { item: { ...playlist, url: 'https://www.deezer.com/playlist/78', only: [song('Var Olan')] } } })
  assert.equal(r.status, 200)
  assert.equal(r.body.status, 'exists')
  assert.equal(core.calls.created.length, 2)

  // A song an earlier download of this link brought, with another length in
  // the store: the core's mapping cache links it to the downloaded video.
  const mapped = await core.produce('Eşlenen.mp3', {
    title: 'Eşlenen', artist: 'Sanatçı',
    userDefinedUrl: [{ description: 'SOURCE_URL', url: 'https://music.youtube.com/watch?v=xLX10_p5Nnw' }]
  })
  const mappedId = (await service.context.scanner.indexFiles([mapped])).get(mapped)
  core.mappedLinks = async (url) => url.endsWith('/79') ? [{ sourceItemId: '5', sourceTitle: 'Eşlenen', sourceArtist: 'Sanatçı', youtubeId: 'xLX10_p5Nnw' }] : []
  r = await call('POST', '/downloads', { token: admin, body: { item: { ...playlist, url: 'https://www.deezer.com/playlist/79', only: [{ id: '5', title: 'Eşlenen', artist: 'Sanatçı', duration: 400 }] } } })
  assert.equal(r.body.status, 'exists')
  assert.deepEqual(r.body.trackIds, [mappedId])
  assert.equal(core.calls.created.length, 2)
})

test('missing songs are picked from the source by ISRC or title and main artist', async () => {
  const { pickWantedEntries } = await import('../modules/player/coreAdapter.js')
  const entries = [
    { title: 'Hırka', artist: 'Onur Can Özcan' },
    { title: 'Kibrit', artist: 'Onur Can Özcan', isrc: 'TR1' },
    { title: 'Yalnızlığın Ezgisi', artist: 'Ferhat Göçer, Onur Can Özcan' },
    { title: 'Kış Ortasında (Official Video)', uploader: 'Onur Can Özcan' },
    null,
    { title: 'Dip (Live)', artist: 'Onur Can Özcan' }
  ]
  assert.deepEqual(pickWantedEntries(entries, [
    { title: 'Başka Ad', artist: 'Kimse', isrc: 'tr1' },
    { title: 'Yalnızlığın Ezgisi', artist: 'Ferhat Göçer' },
    { title: 'Kış Ortasında', artist: 'Onur Can Özcan' },
    { title: 'Dip', artist: 'Onur Can Özcan' }
  ]), [1, 2, 3], 'a live version is another song')

  // A compilation credits every song with all of its artists; the store
  // names the one artist of each song.
  const compilation = [
    { title: 'Vasiyet', artist: 'Sagopa Kajmer, Fuat, Kolera, Cash Flow' },
    { title: 'Okyanuslar', artist: 'Sagopa Kajmer, Fuat, Kolera, Cash Flow' },
    { title: 'Matine Araları', artist: 'Sagopa Kajmer, Fuat, Kolera, Cash Flow' },
    { title: 'Okyanuslar', artist: 'Başka Biri' }
  ]
  assert.deepEqual(pickWantedEntries(compilation, [
    { title: 'Okyanuslar', artist: 'Fuat' },
    { title: 'Matine Araları', artist: 'Kolera' }
  ]), [1, 2], 'an artist in common counts, a stranger with the same title does not')
})

test('refresh online replaces a song with the chosen version and keeps its places', async (t) => {
  const { call, admin, core, service } = await setup(t, { config: { downloadBitrate: 'auto' } })
  const { scanner, db } = service.context
  const original = await core.produce('Sanatçı - Şarkı.mp3', { title: 'Şarkı', artist: 'Sanatçı', album: 'Albüm' })
  fs.writeFileSync(original.replace(/\.mp3$/, '.lrc'), '[00:01.00]Eski')
  const oldId = (await scanner.indexFiles([original])).get(original)
  const added = Date.parse('2024-05-06T07:08:09Z')
  db.prepare('UPDATE tracks SET added_at = ? WHERE id = ?').run(added, oldId)
  const playlist = (await call('POST', '/playlists', { token: admin, body: { name: 'Liste' } })).body
  await call('POST', `/playlists/${playlist.id}/tracks`, { token: admin, body: { trackIds: [oldId] } })
  await call('PUT', `/favorites/track/${oldId}`, { token: admin })
  await call('POST', '/history', { token: admin, body: { trackId: oldId, playedMs: 60000, completed: true } })
  const replace = (body) => call('POST', '/admin/health/replace', { token: admin, body })

  assert.equal((await replace({ trackId: oldId, source: { url: 'https://www.youtube.com/playlist?list=PL1' } })).status, 400, 'a playlist link is not one song')
  assert.equal((await replace({ trackId: oldId, source: { url: 'http://music.youtube.com/watch?v=abcdefghijk' } })).status, 400)
  const started = await replace({ trackId: oldId, source: { url: 'https://www.youtube.com/watch?v=abcdefghijk&list=RDabc', title: 'Şarkı (Canlı)', artist: 'Sanatçı' } })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  await waitFor(() => core.calls.created.length === 1)
  assert.equal(core.calls.created[0].url, 'https://www.youtube.com/watch?v=abcdefghijk', 'only the video, not its mix')
  const progress = (await call('GET', '/admin/health/batch', { token: admin })).body.batch
  assert.equal(progress.current.title, 'Şarkı')

  // The chosen version: another title and a lower bitrate are fine.
  const output = await core.produce('yeni.mp3', { title: 'Şarkı (Canlı)', artist: 'Sanatçı', album: 'Konser' })
  fs.writeFileSync(output.replace(/\.mp3$/, '.lrc'), '[00:01.00]Yeni')
  core.complete(core.calls.created[0].id, [output])
  const done = await waitFor(async () => {
    const { batch } = (await call('GET', '/admin/health/batch', { token: admin })).body
    return batch && !batch.running ? batch : null
  })
  assert.equal(done.succeeded, 1, JSON.stringify(done.errors))
  assert.ok(!fs.existsSync(output), 'the new file took the old name')
  assert.equal(fs.readFileSync(original.replace(/\.mp3$/, '.lrc'), 'utf8'), '[00:01.00]Yeni')
  const row = db.prepare('SELECT * FROM tracks WHERE rel_path = ?').get('Sanatçı - Şarkı.mp3')
  assert.notEqual(row.id, oldId)
  assert.equal(row.title, 'Şarkı (Canlı)')
  assert.equal(row.added_at, added)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE id = ?').get(oldId).n, 0)
  const pl = (await call('GET', `/playlists/${playlist.id}`, { token: admin })).body
  assert.deepEqual(pl.tracks.map((x) => x.id), [row.id], 'the playlist keeps its song')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM favorites WHERE item_type = 'track' AND item_id = ?").get(row.id).n, 1)
  assert.equal(db.prepare('SELECT play_count FROM play_stats WHERE track_id = ?').get(row.id)?.play_count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM play_history WHERE track_id = ?').get(row.id).n, 1)

  // Only admins.
  await call('POST', '/admin/users', { token: admin, body: { username: 'dinleyici', password: 'dinleyici123' } })
  const user = (await call('POST', '/auth/login', { body: { username: 'dinleyici', password: 'dinleyici123', client: 'device' } })).body.token
  assert.equal((await call('POST', '/admin/health/replace', { token: user, body: { trackId: row.id, source: { url: 'https://music.youtube.com/watch?v=abcdefghijk' } } })).status, 403)
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

test('quality upgrade batches keep originals until a better recording is indexed', async (t) => {
  const track = mapDeezerTrack({ id: 123, title: 'Parça', duration: 1, artist: { name: 'Sanatçı' } })
  const { call, admin, core, service } = await setup(t, {
    providers: [fakeProvider('deezer', { track: [track] })],
    config: { downloadBitrate: 'auto', maxQueuedPerUser: 1 }
  })
  const { db, scanner } = service.context
  const tags = { title: track.title, artist: track.artist, album: 'Albüm' }
  const oldFiles = await Promise.all([core.produce('old-1.mp3', tags), core.produce('old-2.mp3', tags)])
  const oldIds = [...(await scanner.indexFiles(oldFiles)).values()]
  const addedLongAgo = Date.parse('2024-01-02T03:04:05Z')
  db.prepare('UPDATE tracks SET added_at = ? WHERE id IN (?, ?)').run(addedLongAgo, ...oldIds)
  await call('POST', '/admin/health/check', { token: admin })
  const report = await waitFor(async () => (await call('GET', '/admin/health', { token: admin })).body.report)
  assert.equal(report.lowBitrate.length, 2)
  const runBatch = (action) => call('POST', '/admin/health/batch', { token: admin, body: { action, ids: oldIds } })
  const finish = () => waitFor(async () => {
    const { batch } = (await call('GET', '/admin/health', { token: admin })).body
    return batch && !batch.running ? batch : null
  })
  async function completeUpgrade(name, bitrate) {
    const file = await core.produce(name, tags)
    const id = (await scanner.indexFiles([file])).get(file)
    db.prepare('UPDATE tracks SET bitrate = ? WHERE id = ?').run(bitrate, id)
    core.complete(core.calls.created.at(-1).id, [file])
    return file
  }

  let result = await runBatch('replace-copies')
  assert.equal(result.status, 202)
  assert.equal(result.body.batch.total, 1, 'two low-quality copies share one download')
  await waitFor(() => core.calls.created.length === 1)
  assert.equal(core.calls.created[0].preset.bitrate, 'auto')
  const current = await waitFor(async () => (await call('GET', '/admin/health', { token: admin })).body.batch.current?.download)
  assert.ok(['queued', 'resolving', 'downloading'].includes(current.status), 'the batch shows its running download')
  const { batch: running } = (await call('GET', '/admin/health', { token: admin })).body
  assert.equal(running.current.title, track.title)
  assert.equal(running.current.artist, track.artist)
  assert.equal((await runBatch('download-better')).status, 409)
  assert.equal((await call('POST', '/admin/health/trash', { token: admin, body: { trackId: oldIds[0] } })).status, 409)
  assert.ok(oldFiles.every((file) => fs.existsSync(file)), 'both originals survive while the download runs')
  await completeUpgrade('same-quality.mp3', 128000)
  assert.equal((await finish()).errors[0].code, 'NO_BETTER_COPY')
  assert.ok(oldFiles.every((file) => fs.existsSync(file)), 'unverified upgrades keep the originals')

  service.context.updateConfig({ downloadBitrate: '192k' })
  // "download-better" (the older action name) replaces the copies as well.
  result = await runBatch('download-better')
  assert.equal(result.status, 202)
  await waitFor(() => core.calls.created.length === 2)
  assert.equal(core.calls.created[1].preset.bitrate, '192k')
  const best = await completeUpgrade('better-1.mp3', 192000)
  const bestSize = fs.statSync(best).size
  assert.equal((await finish()).succeeded, 1)
  assert.ok(!fs.existsSync(best), 'the new copy takes over an old name')
  const renamed = oldFiles.filter((file) => fs.existsSync(file))
  assert.equal(renamed.length, 1, 'the other old copy is in the trash')
  assert.equal(fs.statSync(renamed[0]).size, bestSize)
  const row = db.prepare('SELECT bitrate, added_at FROM tracks WHERE rel_path = ?').get(path.relative(service.context.libraries.list().find((lib) => lib.isDefault).path, renamed[0]))
  assert.equal(row?.bitrate, 192000, 'the library entry follows the rename')
  assert.equal(row.added_at, addedLongAgo, 'a replacement is not "recently added"')
})

test('replacement reuses a download when provider seconds explain the duration difference', async (t) => {
  const track = mapDeezerTrack({ id: 403, title: 'Parça', duration: 291, artist: { name: 'Sanatçı' } })
  const { call, admin, core, service } = await setup(t, {
    providers: [fakeProvider('deezer', { track: [track] })],
    config: { downloadBitrate: 'auto' }
  })
  const { scanner, db } = service.context
  const tags = { title: track.title, artist: track.artist, album: 'Albüm' }
  const original = await core.produce('original.mp3', tags)
  const originalId = (await scanner.indexFiles([original])).get(original)
  const setDuration = db.prepare('UPDATE tracks SET duration = ? WHERE id = ?')
  setDuration.run(272.3, originalId)

  const status = async () => (await call('GET', '/admin/health', { token: admin })).body
  await call('POST', '/admin/health/check', { token: admin })
  await waitFor(async () => (await status()).report)
  const start = () => call('POST', '/admin/health/batch', { token: admin, body: { action: 'replace-copies' } })
  const finish = () => waitFor(async () => {
    const { batch } = await status()
    return batch && !batch.running ? batch : null
  })

  // The single-song button runs a batch of one.
  const single = await call('POST', '/admin/health/redownload', { token: admin, body: { trackId: originalId } })
  assert.equal(single.status, 200)
  assert.equal(single.body.batch.total, 1)
  await waitFor(() => core.calls.created.length === 1)
  const output = await core.produce('already-downloaded.mp3', tags, { bitrate: 192 })
  const outputId = (await scanner.indexFiles([output])).get(output)
  setDuration.run(292.1, outputId)
  core.complete(core.calls.created[0].id, [output])
  assert.equal((await finish()).errors[0]?.code, 'NO_BETTER_COPY', 'a download of another length is not used')
  assert.ok(fs.existsSync(original))

  const batch = await start()
  assert.equal(batch.status, 202)
  await waitFor(() => core.calls.created.length === 2, { label: 'different provider second requires a fresh download' })
  assert.ok(fs.existsSync(original))
  await call('POST', `/admin/health/batch/${batch.body.batch.id}/control`, { token: admin, body: { command: 'cancel' } })
  await finish()

  setDuration.run(291.744, outputId)
  const outputSize = fs.statSync(output).size
  assert.equal((await start()).status, 202)
  assert.equal((await finish()).succeeded, 1)
  assert.equal(core.calls.created.length, 2, 'reuse the verified local file')
  assert.ok(!fs.existsSync(output))
  assert.equal(fs.statSync(original).size, outputSize, 'the upgrade takes the original name')
})

test('quality upgrades search the main artist and can take a different length when asked', async (t) => {
  const tracks = [
    mapDeezerTrack({ id: 404, title: 'Tavla', duration: 271, artist: { name: 'Sanatçı' } }),
    mapDeezerTrack({ id: 405, title: 'Zor Mu', duration: 251, artist: { name: 'Sanatçı' } })
  ]
  const queries = []
  const provider = { name: 'deezer', available: () => true, async search(q) { queries.push(q); return tracks } }
  const { call, admin, core, service } = await setup(t, { providers: [provider], config: { downloadBitrate: 'auto' } })
  const { scanner, db } = service.context
  const files = await Promise.all(tracks.map((track) =>
    core.produce(`${track.title}.mp3`, { title: track.title, artist: 'Sanatçı, Çeşitli Sanatçılar', album: 'Albüm' })))
  const indexed = await scanner.indexFiles(files)
  const ids = files.map((file) => indexed.get(file))
  const setDuration = db.prepare('UPDATE tracks SET duration = ? WHERE id = ?')
  setDuration.run(244.2, ids[0])
  setDuration.run(233, ids[1])
  const status = async () => (await call('GET', '/admin/health', { token: admin })).body
  await call('POST', '/admin/health/check', { token: admin })
  await waitFor(async () => (await status()).report)
  const startBatch = (body) => call('POST', '/admin/health/batch', { token: admin, body: { action: 'replace-copies', ...body } })
  const finish = () => waitFor(async () => {
    const { batch } = await status()
    return batch && !batch.running ? batch : null
  })

  assert.equal((await startBatch({})).status, 202)
  const failed = await finish()
  assert.deepEqual(failed.errors.map((e) => e.code), ['LENGTH_MISMATCH', 'LENGTH_MISMATCH'])
  const tavla = failed.errors.find((e) => e.title === 'Tavla')
  assert.equal(tavla.detail, '4:04 ↔ 4:31')
  assert.deepEqual(tavla.trackIds, [ids[0]])
  assert.ok(queries.includes('Sanatçı Tavla'), 'only the main artist is searched')
  assert.equal(core.calls.created.length, 0)

  assert.equal((await startBatch({ force: true })).status, 400, 'download anyway needs chosen songs')
  const forced = await startBatch({ ids: tavla.trackIds, force: true })
  assert.equal(forced.status, 202)
  assert.equal(forced.body.batch.earlierErrors.length, 1, 'the other failure stays listed')
  await waitFor(() => core.calls.created.length === 1)
  assert.equal(core.calls.created[0].url, tracks[0].url)
  const output = await core.produce('new/Tavla.mp3', { title: 'Tavla', artist: 'Sanatçı', album: 'Albüm' }, { bitrate: 192 })
  const outputId = (await scanner.indexFiles([output])).get(output)
  setDuration.run(271.2, outputId)
  core.complete(core.calls.created[0].id, [output])
  const done = await finish()
  assert.equal(done.succeeded, 1, JSON.stringify(done.errors))
  assert.deepEqual(done.earlierErrors.map((e) => e.title), ['Zor Mu'])
  assert.equal(db.prepare('SELECT duration FROM tracks WHERE id = ?').get(outputId).duration, 271.2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE id = ?').get(ids[0]).n, 0, 'the old copy left the library')
})

test('health upgrades use the original folder and empty only the player trash', async (t) => {
  const track = mapDeezerTrack({ id: 403, title: 'Parça', duration: 1, artist: { name: 'Sanatçı' } })
  const mount = process.env.GH_PLAYER_TEST_MUSIC_MOUNT
  const { call, admin, core, service, root, downloads } = await setup(t, {
    providers: [fakeProvider('deezer', { track: [track] })],
    config: { downloadBitrate: 'auto' },
    env: mount ? { DATA_DIR: '/usr/src/app' } : null
  })
  const music = mount ? fs.mkdtempSync(path.join(mount, 'gh-player-music-')) : path.join(root, 'music')
  if (mount) {
    t.after(() => fs.rmSync(music, { recursive: true, force: true }))
    assert.notEqual(fs.statSync(music).dev, fs.statSync(service.dataDir).dev, 'exercise cross-device trash')
    assert.equal(service.dataDir, '/usr/src/app/cache/player')
  }
  const { libraries, scanner } = service.context
  const tags = { title: track.title, artist: track.artist, album: 'Albüm' }
  const original = await writeTrack(path.join(music, 'album', 'original.mp3'), tags)
  const previous = fs.readFileSync(original)
  fs.writeFileSync(path.join(music, 'album', 'original.lrc'), '[00:01.00]Old')
  fs.writeFileSync(path.join(music, 'album', 'original.lyrics'), '[00:01.00]Old tagger')
  const library = libraries.add({ name: 'Music', path: music })
  const oldId = (await scanner.indexFiles([original])).get(original)
  const defaultLibrary = libraries.list().find((lib) => lib.isDefault)
  libraries.update(defaultLibrary.id, { enabled: false })
  const configured = path.join(root, 'configured')
  fs.mkdirSync(configured)
  libraries.setDownloadFolder(configured)

  const status = async () => (await call('GET', '/admin/health', { token: admin })).body
  const finish = () => waitFor(async () => {
    const { batch } = await status()
    return batch && !batch.running ? batch : null
  })
  await call('POST', '/admin/health/check', { token: admin })
  await waitFor(async () => (await status()).report)

  // One song: the upgrade lands in the original folder, the old copy goes to
  // the trash and the new one takes its name (also for its lyrics).
  const single = await call('POST', '/admin/health/redownload', { token: admin, body: { trackId: oldId } })
  assert.equal(single.status, 200)
  await waitFor(() => core.calls.created.length === 1)
  const output = await writeTrack(path.join(downloads, 'staging', 'original.mp3'), tags, { bitrate: 192 })
  fs.writeFileSync(path.join(path.dirname(output), 'original.lrc'), '[00:01.00]Fixture')
  core.complete(core.calls.created[0].id, [output])
  const first = await finish()
  assert.equal(first.succeeded, 1, JSON.stringify(first.errors))
  assert.notDeepEqual(fs.readFileSync(original), previous)
  assert.ok(!fs.existsSync(path.join(path.dirname(original), 'original (2).mp3')))
  assert.ok(!fs.existsSync(path.join(path.dirname(original), 'original (2).lrc')))
  assert.equal(fs.readFileSync(path.join(path.dirname(original), 'original.lrc'), 'utf8'), '[00:01.00]Fixture')
  assert.ok(!fs.existsSync(path.join(path.dirname(original), 'original.lyrics')), 'every old lyrics file goes with the old copy')
  assert.ok(!fs.existsSync(output))
  assert.deepEqual(fs.readdirSync(configured), [])

  const other = await writeTrack(path.join(music, 'other-album', 'original.mp3'), tags)
  const otherLyrics = path.join(music, 'other-album', 'original.lyrics')
  fs.writeFileSync(otherLyrics, '[00:01.00]Kept')
  await scanner.indexFiles([other])
  await call('POST', '/admin/health/check', { token: admin })
  await waitFor(async () => (await status()).report?.lowBitrate.length === 1)
  const batch = await call('POST', '/admin/health/batch', { token: admin, body: { action: 'replace-copies' } })
  assert.equal(batch.status, 202)
  assert.equal(batch.body.batch.total, 1, 'the upgraded folder is done')
  assert.equal((await call('POST', '/admin/health/trash/empty', { token: admin })).status, 409)
  await waitFor(() => core.calls.created.length === 2)
  const newest = await core.produce('staging/newest.mp3', tags, { bitrate: 192 })
  core.complete(core.calls.created[1].id, [newest])
  const finished = await finish()
  assert.equal(finished.succeeded, 1, JSON.stringify(finished.errors))
  assert.ok(!fs.existsSync(path.join(path.dirname(other), 'newest.mp3')))
  assert.ok(fs.existsSync(other))
  assert.ok(fs.existsSync(otherLyrics), 'old lyrics stay when the new copy has none')

  const { trashPath } = await status()
  assert.equal(trashPath, path.join(service.dataDir, 'trash'))
  const [day] = fs.readdirSync(trashPath)
  assert.deepEqual(fs.readFileSync(path.join(trashPath, day, String(library.id), 'album', 'original.mp3')), previous)
  assert.equal(fs.readFileSync(path.join(trashPath, day, String(library.id), 'album', 'original.lrc'), 'utf8'), '[00:01.00]Old',
    'old lyrics go to the trash when the new copy has its own')
  assert.equal(fs.readFileSync(path.join(trashPath, day, String(library.id), 'album', 'original.lyrics'), 'utf8'), '[00:01.00]Old tagger')
  if (process.platform !== 'win32') fs.symlinkSync(music, path.join(trashPath, 'outside'))
  assert.equal((await call('POST', '/admin/health/trash/empty')).status, 401)
  assert.equal((await call('POST', '/admin/health/trash/empty', { token: admin })).status, 200)
  assert.deepEqual(fs.readdirSync(trashPath), [])
  assert.ok(fs.existsSync(original))
  assert.ok(fs.existsSync(other))
})

test('quality batches pause between tracks and cancel only their own active download', async (t) => {
  const tracks = ['Birinci', 'İkinci'].map((title, i) =>
    mapDeezerTrack({ id: i + 1, title, duration: 1, artist: { name: 'Sanatçı' } }))
  const { call, admin, core, service } = await setup(t, { providers: [fakeProvider('deezer', { track: tracks })] })
  const { db, scanner } = service.context
  const tags = (track) => ({ title: track.title, artist: track.artist, album: 'Albüm' })
  const originals = await Promise.all(tracks.map((track) => core.produce(`${track.title}.mp3`, tags(track))))
  const originalIds = await scanner.indexFiles(originals)
  const status = async () => (await call('GET', '/admin/health', { token: admin })).body
  await call('POST', '/admin/health/check', { token: admin })
  await waitFor(async () => (await status()).report)
  const start = async (action, ids) => {
    const res = await call('POST', '/admin/health/batch', { token: admin, body: { action, ids } })
    assert.equal(res.status, 202)
    return res.body.batch.id
  }
  const control = async (id, command) => {
    const res = await call('POST', `/admin/health/batch/${id}/control`, { token: admin, body: { command } })
    assert.equal(res.status, 200)
    return res.body.batch
  }
  const finished = () => waitFor(async () => {
    const { batch } = await status()
    return batch && !batch.running ? batch : null
  })

  const id = await start('download-better')
  await waitFor(() => core.calls.created.length === 1)
  assert.equal((await control(id, 'pause')).paused, true)
  const first = tracks.find((track) => track.url === core.calls.created[0].url)
  const newFile = await core.produce('upgrade.mp3', tags(first))
  const newId = (await scanner.indexFiles([newFile])).get(newFile)
  db.prepare('UPDATE tracks SET bitrate = 192000 WHERE id = ?').run(newId)
  core.complete(core.calls.created[0].id, [newFile])
  await waitFor(async () => {
    const { batch } = await status()
    return batch.paused && batch.succeeded === 1 && !batch.currentTitle
  })
  assert.equal(core.calls.created.length, 1, 'pause leaves the next track waiting')
  assert.equal((await control(id, 'resume')).paused, false)
  await waitFor(() => core.calls.created.length === 2)
  const active = core.calls.created[1]
  assert.equal((await control(id, 'cancel')).canceled, true)
  assert.equal((await finished()).done, 1)
  assert.deepEqual(core.calls.canceled, [active.id])
  await waitStatus(call, admin, active.tag, 'canceled')

  const track = tracks.find((entry) => entry.url === active.url)
  const regular = await call('POST', '/downloads', { token: admin, body: { item: track, force: true } })
  await waitStatus(call, admin, regular.body.id, 'downloading')
  const replacement = await start('replace-copies', [originalIds.get(originals[tracks.indexOf(track)])])
  await waitFor(() => core.calls.created.length === 4)
  const upgrade = core.calls.created[3]
  await control(replacement, 'pause')
  await control(replacement, 'cancel')
  assert.equal((await finished()).canceled, true)
  assert.deepEqual(core.calls.canceled, [active.id, upgrade.id], 'regular downloads survive batch cancellation')
  await waitStatus(call, admin, regular.body.id, 'downloading')
  assert.ok(originals.every((file) => fs.existsSync(file)))
})

test('a replacement batch resumes an existing download and interrupted trash move after restart', async (t) => {
  const track = mapDeezerTrack({ id: 123, title: 'Parça', duration: 1, artist: { name: 'Sanatçı' } })
  const first = await setup(t, { providers: [fakeProvider('deezer', { track: [track] })] })
  const { call, admin, core } = first
  const { db, scanner } = first.service.context
  const tags = { title: track.title, artist: track.artist, album: 'Albüm' }
  const oldFiles = await Promise.all(['same-song/a.mp3', 'same-song/b.mp3'].map((file) => core.produce(file, tags)))
  const oldIds = [...(await scanner.indexFiles(oldFiles)).values()]
  await call('POST', '/admin/health/check', { token: admin })
  await waitFor(async () => (await call('GET', '/admin/health', { token: admin })).body.report)
  const started = await call('POST', '/admin/health/batch', { token: admin, body: { action: 'replace-copies' } })
  assert.equal(started.status, 202)
  assert.equal(started.body.batch.total, 1)
  await waitFor(() => core.calls.created.length === 1)
  const job = core.calls.created[0]
  await waitStatus(call, admin, job.tag, 'downloading')
  const betterFile = await core.produce('new-version.mp3', tags, { bitrate: 192 })
  const saved = getSetting(db, 'health_download_batch')
  assert.deepEqual(saved.download, { id: job.tag, owned: true })

  // Simulate a stop after the first file moved and before its library entry was dropped.
  const archived = path.join(first.service.dataDir, 'trash', 'original.mp3')
  fs.mkdirSync(path.dirname(archived), { recursive: true })
  saved.moves[oldIds[0]] = archived
  setSetting(db, 'health_download_batch', saved)
  fs.renameSync(oldFiles[0], archived)
  const source = path.dirname(oldFiles[1])
  const placed = path.join(source, 'new-version.mp3')
  const plan = { source: betterFile, file: placed, size: fs.statSync(betterFile).size }
  db.prepare("UPDATE downloads SET status = 'indexing', upgrade_output = ? WHERE id = ?").run(JSON.stringify(plan), job.tag)
  await first.stop()
  assert.deepEqual(core.calls.canceled, [])
  fs.renameSync(betterFile, placed)
  core.vanish(job.id)

  // Simulate an unplugged source drive at startup.
  fs.renameSync(source, `${source}-unplugged`)
  const restarted = await startPlayerService({
    env: {}, logger: silentLogger, dataDir: first.service.dataDir, cacheDir: first.service.cacheDir,
    defaultLibraryDir: first.downloads, initialScanDelayMs: -1, core, bridgePollMs: 40,
    onlineOptions: { providers: [] }
  })
  t.after(() => restarted.stop())
  const { health } = restarted.context
  const paused = await waitFor(() => {
    const { batch } = health.status()
    return batch?.blocked ? batch : null
  })
  assert.equal(paused.id, started.body.batch.id)
  assert.equal(paused.paused, true)
  assert.equal(paused.done, 0)
  fs.renameSync(`${source}-unplugged`, source)
  health.controlBatch(paused.id, 'resume')
  const done = await waitFor(() => !health.status().batch.running && health.status().batch)
  assert.equal(done.succeeded, 1)
  assert.deepEqual(done.errors, [])
  assert.equal(core.calls.created.length, 1, 'reuse the persisted download without searching or creating it again')
  assert.ok(fs.existsSync(archived))
  assert.ok(!fs.existsSync(path.join(source, 'new-version.mp3')))
  assert.deepEqual(oldFiles.filter((file) => fs.existsSync(file)).length, 1, 'the new copy takes an old name')
  assert.ok(!fs.existsSync(betterFile))
  assert.equal(restarted.context.db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE id IN (?,?)').get(...oldIds).n, 0)
})

test('removing a downloaded track invalidates online ownership even with a reused legacy ID', async (t) => {
  const item = mapDeezerTrack({
    id: 66133873, title: 'Gül Tükendi, Ben Tükendim', duration: 347,
    link: 'https://www.deezer.com/track/66133873', artist: { name: 'Kıvırcık Ali' }
  })
  const { call, base, admin, core, service } = await setup(t, {
    providers: [fakeProvider('deezer', { track: [item] })]
  })
  const { db, scanner } = service.context
  const response = await call('POST', '/downloads', { token: admin, body: { item } })
  const job = await waitStatus(call, admin, response.body.id, 'downloading')
  const file = await core.produce('original.mp3', { title: 'Different provider tags', artist: 'Kıvırcık Ali' })
  core.complete(core.calls.created[0].id, [file])
  const done = await waitStatus(call, admin, job.id, 'completed')
  const [originalId] = done.trackIds
  assert.ok(originalId)
  const onlineItem = async () => (await call('GET', '/online/search?q=Kivircik&kinds=track', { token: admin })).body.tracks[0]
  assert.equal((await onlineItem()).library.trackId, originalId)

  const updates = await fetch(base + '/downloads/events', {
    headers: { authorization: `Bearer ${admin}` }, signal: AbortSignal.timeout(5000)
  })
  const reader = updates.body.getReader()
  const decoder = new TextDecoder()
  try {
    let received = decoder.decode((await reader.read()).value)
    assert.match(received, /event: ready/)
    assert.equal((await call('POST', '/admin/health/trash', { token: admin, body: { trackId: originalId } })).status, 200)
    while (!received.includes('event: library-removed')) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += decoder.decode(chunk.value)
    }
    assert.match(received, /event: library-removed/)
  } finally {
    await reader.cancel()
  }
  assert.equal((await onlineItem()).library, null)
  assert.equal((await call('GET', `/tracks/${originalId}`, { token: admin })).status, 404)

  const replacement = await core.produce('replacement.mp3', { title: 'Vay', artist: 'Hande Yener' })
  const replacementId = (await scanner.indexFiles([replacement])).get(replacement)
  assert.ok(replacementId > originalId, 'the scanner never recycles IDs')
  // Represent a completed row that still points to an ID already reused by an older version.
  db.prepare('UPDATE downloads SET result_track_ids = ? WHERE id = ?').run(JSON.stringify([replacementId]), done.id)
  db.prepare('UPDATE tracks SET added_at = ? WHERE id = ?').run(done.completedAt + 1, replacementId)
  assert.equal((await onlineItem()).library, null)
  assert.deepEqual((await call('GET', `/downloads/${done.id}`, { token: admin })).body.trackIds, [])
  const again = await call('POST', '/downloads', { token: admin, body: { item } })
  assert.equal(again.status, 202)
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
  const file = await core.produce('Artist - Survivor.mp3', { title: 'Survivor', artist: 'Artist' })
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

test('album downloads report which song of how many they are on', async (t) => {
  assert.equal(jobSteps({ counters: { dlTotal: 1, dlDone: 0 } }), null, 'a single song has no steps')
  assert.deepEqual(jobSteps({ counters: { dlTotal: 12, dlDone: 5, cvTotal: 12, cvDone: 3 } }), { total: 12, downloaded: 5, converted: 3 })
  assert.deepEqual(jobSteps({ playlist: { total: 4 }, counters: { dlDone: 9 } }), { total: 4, downloaded: 4, converted: 0 })

  const { call, admin, core } = await setup(t)
  const r = await call('POST', '/downloads', { token: admin, body: { item: { kind: 'album', url: 'https://www.deezer.com/album/77', title: 'Uzun Albüm', artist: 'Biri', trackCount: 12 } } })
  await waitStatus(call, admin, r.body.id, 'downloading')
  const jobId = core.calls.created[0].id
  Object.assign(core.jobs.get(jobId), { status: 'processing', progress: 40, phase: 'downloading', steps: { total: 12, downloaded: 5, converted: 0 } })
  const d = await waitFor(async () => { const x = (await call('GET', `/downloads/${r.body.id}`, { token: admin })).body; return x.steps ? x : null }, { label: 'steps' })
  assert.deepEqual(d.steps, { total: 12, downloaded: 5, converted: 0 })
})

test('many songs at once are one group: over the queue limit they wait, then follow', async (t) => {
  const { call, admin, core, downloads } = await setup(t, { config: { maxParallelDownloads: 1, maxQueuedPerUser: 2 } })
  const items = [1, 2, 3, 4, 5].map((n) => ytTrack(`g${n}`, `Grup ${n}`, 'Grup Sanatçı'))
  // The same link twice is one song.
  const r = await call('POST', '/downloads/groups', { token: admin, body: { title: 'Seçim', items: [...items, items[0]] } })
  assert.equal(r.status, 202)
  assert.equal(r.body.counts.total, 5)
  assert.equal(r.body.title, 'Seçim')
  assert.equal(r.body.pendingUrls.length, 5)
  const gid = r.body.id

  const group = async () => (await call('GET', `/downloads/groups/${gid}`, { token: admin })).body
  let g = await waitFor(async () => { const x = await group(); return x.counts.waiting === 3 ? x : null }, { label: 'two queued, three waiting' })
  assert.equal(g.counts.queued + g.counts.running, 2, 'never more than the queue limit at once')
  assert.equal(g.status, 'active')
  let active = await call('GET', '/downloads?active=1', { token: admin })
  assert.equal(active.body.items.length, 2)
  assert.ok(active.body.items.every((d) => d.groupId === gid))
  // Grouped songs stay off the plain list of the downloads page.
  assert.equal((await call('GET', '/downloads?ungrouped=1', { token: admin })).body.items.length, 0)

  // Each finished song lets the next waiting one in, until all are done.
  for (let n = 0; n < 5; n++) {
    const job = await waitFor(() => [...core.jobs.entries()].find(([, j]) => j.status === 'queued'), { label: `job ${n + 1}` })
    const [jobId, info] = job
    const id = info.url.split('v=')[1]
    const file = await writeTrack(path.join(downloads, `${id}.mp3`), { title: `Grup ${id.slice(1)}`, artist: 'Grup Sanatçı' }, { fresh: true })
    core.complete(jobId, [file])
    await waitFor(async () => (await group()).counts.done === n + 1, { label: `done ${n + 1}` })
  }
  g = await group()
  assert.equal(g.status, 'done')
  assert.equal(g.active, false)
  assert.deepEqual({ done: g.counts.done, waiting: g.counts.waiting, failed: g.counts.failed }, { done: 5, waiting: 0, failed: 0 })
  const songs = await call('GET', `/downloads?group=${gid}`, { token: admin })
  assert.equal(songs.body.items.length, 5)
})

test('a download group can be canceled (waiting songs too) and its failures retried', async (t) => {
  const { call, admin, core } = await setup(t, { config: { maxParallelDownloads: 1, maxQueuedPerUser: 1 } })
  const items = [1, 2, 3].map((n) => ytTrack(`c${n}`, `İptal ${n}`, 'Sanatçı'))
  const bad = { kind: 'track', url: 'https://evil.example/x', title: 'Kötü link', artist: 'Sanatçı' }
  const r = await call('POST', '/downloads/groups', { token: admin, body: { items: [bad, ...items] } })
  const gid = r.body.id
  const group = async () => (await call('GET', `/downloads/groups/${gid}`, { token: admin })).body
  let g = await waitFor(async () => { const x = await group(); return x.counts.failed === 1 && x.counts.waiting === 2 ? x : null }, { label: 'bad link failed, one queued' })
  assert.equal(g.errors[0].code, 'UNSUPPORTED_SOURCE')
  await waitFor(() => core.calls.created.length === 1, { label: 'first song started' })

  const canceled = await call('POST', `/downloads/groups/${gid}/cancel`, { token: admin })
  assert.equal(canceled.body.status, 'canceled')
  assert.equal(canceled.body.counts.canceled, 3, 'the running song and both waiting ones')
  assert.equal(canceled.body.counts.waiting, 0)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(core.calls.created.length, 1, 'nothing new starts after a cancel')

  const retried = await call('POST', `/downloads/groups/${gid}/retry`, { token: admin })
  assert.equal(retried.body.active, true)
  // The canceled song is queued again; the bad link and the two songs that
  // never started wait for the queue limit again.
  g = await waitFor(async () => { const x = await group(); return x.counts.queued + x.counts.running === 1 && x.counts.waiting === 3 ? x : null }, { label: 'retried' })
  assert.equal(g.status, 'active')
  assert.equal(g.counts.failed, 0)
  assert.equal(g.counts.canceled, 0)
  // Someone else's group is not visible.
  assert.equal((await call('GET', '/downloads/groups/nope', { token: admin })).status, 404)
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
  const outside = await writeTrack(path.join(path.dirname(downloads), 'elsewhere', 'x.mp3'), { title: 'X' })
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
  await writeTrack(path.join(root, 'outputs', 'A', '01.mp3'), { title: 'One', artist: 'Band', album: 'Record', trackNumber: '1' })
  await writeTrack(path.join(root, 'outputs', 'A', '02.mp3'), { title: 'Two', artist: 'Band', album: 'Record', trackNumber: '2' })
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
  await writeTrack(path.join(root, 'outputs', 'Firuze.mp3'), { title: 'Firuze', artist: 'Sezen Aksu', album: 'Firuze' })
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
  const file = await writeTrack(path.join(downloads, 'Tarkan - Wake Up - mp3', 'Tarkan - Wake Up.mp3'), { title: 'Wake Up', artist: 'Tarkan', album: 'Wake Up - Single' }, { fresh: true })
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

test('with the download library off, player downloads move to the chosen folder and play from there', async (t) => {
  const { call, admin, core, downloads, root } = await setup(t)
  const libs = (await call('GET', '/admin/libraries', { token: admin })).body.items
  const def = libs.find((lib) => lib.isDefault)
  await call('PATCH', `/admin/libraries/${def.id}`, { token: admin, body: { enabled: false } })

  // No folder yet: downloading is refused with a clear reason.
  let r = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('m1', 'Kuzu Kuzu', 'Tarkan') } })
  assert.equal(r.status, 409)
  assert.equal(r.body.error.code, 'DEFAULT_LIBRARY_DISABLED')

  const target = path.join(root, 'my-music')
  fs.mkdirSync(target)
  r = await call('PUT', '/admin/download-folder', { token: admin, body: { path: target } })
  assert.equal(r.status, 200)
  assert.equal(r.body.active, true)
  assert.equal(r.body.created, true)
  r = await call('PUT', '/admin/download-folder', { token: admin, body: { path: path.join(root, 'missing') } })
  assert.equal(r.body.error.code, 'LIBRARY_PATH_NOT_FOUND')

  r = await call('POST', '/downloads', { token: admin, body: { item: ytTrack('m1', 'Kuzu Kuzu', 'Tarkan') } })
  assert.equal(r.status, 202)
  const id = r.body.id
  await waitStatus(call, admin, id, 'downloading')
  const jobId = core.calls.created.at(-1).id
  fs.mkdirSync(path.join(downloads, 'Tarkan'), { recursive: true })
  const file = await writeTrack(path.join(downloads, 'Tarkan', 'Tarkan - Kuzu Kuzu.mp3'), { title: 'Kuzu Kuzu', artist: 'Tarkan', album: 'Karma' }, { fresh: true })
  core.complete(jobId, [file])
  const done = await waitStatus(call, admin, id, ['completed', 'failed'])
  assert.equal(done.status, 'completed', JSON.stringify(done))
  assert.equal(done.trackIds.length, 1)
  assert.ok(!fs.existsSync(file), 'moved out of the Gharmonize download folder')
  assert.ok(fs.existsSync(path.join(target, 'Tarkan', 'Tarkan - Kuzu Kuzu.mp3')))
  r = await call('GET', `/tracks/${done.trackIds[0]}`, { token: admin })
  assert.equal(r.body.title, 'Kuzu Kuzu')
})
