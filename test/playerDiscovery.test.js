import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'

import { writeTrack, tmpDir, waitFor, silentLogger } from './fixtures/playerAudio.mjs'
import { startPlayerService } from '../modules/player/service.js'
import { createPlayerRouter } from '../modules/player/router.js'
import { openPlayerDatabase } from '../modules/player/db.js'
import { createOnlineCache } from '../modules/player/onlineCache.js'
import { normalizeLang } from '../modules/player/discovery.js'
import { mapYouTubeItem, cleanYouTubeArtist, mapDeezerTrack } from '../modules/player/online.js'

const DAY = 24 * 60 * 60 * 1000
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10)

const dzTrack = (id, title, artist, extra = {}) => ({ provider: 'deezer', kind: 'track', id: String(id), title, artist, url: `https://www.deezer.com/track/${id}`, duration: 1, previewUrl: `https://cdnt-preview.dzcdn.net/${id}.mp3`, ...extra })
const dzAlbum = (id, title, artist, releaseDate, extra = {}) => ({ provider: 'deezer', kind: 'album', id: String(id), title, artist, url: `https://www.deezer.com/album/${id}`, releaseDate, recordType: 'album', trackCount: 10, ...extra })
const dzArtist = (id, name) => ({ provider: 'deezer', kind: 'artist', id: String(id), title: name, artist: name, url: `https://www.deezer.com/artist/${id}` })

function createFakeSources() {
  const calls = {}
  const count = (name) => { calls[name] = (calls[name] || 0) + 1 }
  const deezer = {
    name: 'deezer',
    available: () => true,
    async chartTracks() { count('chartTracks'); return deezer.failChart ? Promise.reject(new Error('down')) : [dzTrack(1, 'Hadi Bakalım', 'Sezen Aksu'), dzTrack(2, 'Dai Dai', 'Shiva')] },
    async chartAlbums() { count('chartAlbums'); return [dzAlbum(10, 'SWALLOW!', 'Someone', isoDaysAgo(3))] },
    async chartArtists() { count('chartArtists'); return [dzArtist(100, 'Sezen Aksu'), dzArtist(101, 'Shiva')] },
    async chartPlaylists() { count('chartPlaylists'); return [{ provider: 'deezer', kind: 'playlist', id: '7', title: 'Calm Piano', artist: 'Deezer', url: 'https://www.deezer.com/playlist/7' }] },
    async genres() { count('genres'); return [{ id: 132, name: 'Pop' }, { id: 116, name: 'Rap/Hip Hop' }] },
    async genreChartTracks(id) { count(`genreChart:${id}`); return [dzTrack(50, 'Pop Hit', 'Popstar')] },
    async findArtistId(name) { count(`findArtistId:${name}`); return { 'Sezen Aksu': '100', 'Tarkan': '200' }[name] || null },
    async artist(id) { count('artist'); return id === '100' ? dzArtist(100, 'Sezen Aksu') : null },
    async artistTop(id) {
      count(`artistTop:${id}`)
      return id === '100'
        ? [dzTrack(1, 'Hadi Bakalım', 'Sezen Aksu'), dzTrack(3, 'Firuze', 'Sezen Aksu'), dzTrack(4, 'Gülümse (Official Video)', 'Sezen Aksu')]
        : [dzTrack(5, 'Şımarık', 'Tarkan')]
    },
    async artistRelated(id) { count(`artistRelated:${id}`); return [dzArtist(300, 'Nilüfer'), dzArtist(200, 'Tarkan')] },
    async artistAlbums(id) {
      count(`artistAlbums:${id}`)
      return id === '100'
        ? [dzAlbum(20, 'Yepyeni', 'Sezen Aksu', isoDaysAgo(10)), dzAlbum(21, 'Eski Plak', 'Sezen Aksu', isoDaysAgo(900)), dzAlbum(22, 'Gülümse', 'Sezen Aksu', isoDaysAgo(20)), dzAlbum(23, 'Tek', 'Sezen Aksu', isoDaysAgo(5), { recordType: 'single', trackCount: 1 })]
        : []
    },
    async artistRadio(id) { count(`artistRadio:${id}`); return [dzTrack(60, 'Radyo Şarkısı', 'Nilüfer')] },
    async album(id) {
      count(`album:${id}`)
      if (id !== '22') return null
      return { album: dzAlbum(22, 'Gülümse', 'Sezen Aksu', isoDaysAgo(20), { trackCount: 2 }), tracks: [dzTrack(70, 'Hadi Bakalım', 'Sezen Aksu'), dzTrack(71, 'Yeni Parça', 'Sezen Aksu')] }
    },
    async playlist(id) { count(`playlist:${id}`); return { playlist: { provider: 'deezer', kind: 'playlist', id, title: 'Liste', url: `https://www.deezer.com/playlist/${id}` }, tracks: [dzTrack(80, 'Gülümse', 'Sezen Aksu')] } }
  }
  const youtube = {
    name: 'youtube',
    available: () => true,
    async home() {
      count('ytHome')
      if (youtube.hang) return new Promise(() => {})
      return { personalized: true, shelves: [{ title: 'Hızlı seçimler', items: [{ provider: 'youtube', kind: 'track', id: 'q1', title: 'Firuze', artist: 'Sezen Aksu', url: 'https://music.youtube.com/watch?v=q1' }] }] }
    },
    async discover(preset) { count(`ytDiscover:${preset}`); return [{ provider: 'youtube', kind: 'track', id: `p-${preset}`, title: `${preset} song`, artist: 'YT Artist', url: `https://music.youtube.com/watch?v=p${preset}` }] },
    async playlist(url, { artist }) { count('ytPlaylist'); return { title: 'Gülümse', count: 1, tracks: [{ provider: 'youtube', kind: 'track', id: 'w1', title: 'Hadi Bakalım', artist, url: 'https://music.youtube.com/watch?v=w1' }] } }
  }
  const spotify = { name: 'spotify', available: () => false }
  return { sources: { deezer, youtube, spotify }, calls }
}

async function setup(t, { shelfTimeoutMs = 2000 } = {}) {
  const root = tmpDir('discover')
  const downloads = path.join(root, 'outputs')
  writeTrack(path.join(downloads, 'Sezen Aksu', 'Gülümse', '01.mp3'), { title: 'Hadi Bakalım', artist: 'Sezen Aksu', album: 'Gülümse', trackNumber: '1', genre: 'Pop' })
  writeTrack(path.join(downloads, 'Sezen Aksu', 'Gülümse', '02.mp3'), { title: 'Gülümse', artist: 'Sezen Aksu', album: 'Gülümse', trackNumber: '2', genre: 'Pop' })
  const archive = path.join(root, 'archive')
  writeTrack(path.join(archive, 'Tarkan.mp3'), { title: 'Şımarık', artist: 'Tarkan', genre: 'Pop' })
  const fake = createFakeSources()
  const service = await startPlayerService({
    env: {}, logger: silentLogger, dataDir: path.join(root, 'data'), cacheDir: path.join(root, 'cache'),
    defaultLibraryDir: downloads, initialScanDelayMs: -1, core: { inspect: async () => ({}) }, bridgePollMs: 1000,
    discoverySources: fake.sources, discoveryOptions: { shelfTimeoutMs }
  })
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
  t.after(async () => { server.close(); await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
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
  await call('POST', '/setup', { body: { username: 'admin', password: 'supersecret', adminPassword: 'GharmonizeAdmin1' } })
  const admin = (await call('POST', '/auth/login', { body: { username: 'admin', password: 'supersecret', client: 'device' } })).body.token
  await call('POST', '/admin/libraries', { token: admin, body: { name: 'Arşiv', path: archive } })
  await service.context.scanner.requestScan('all')
  return { call, admin, service, fake }
}

const byId = (shelves, id) => shelves.find((s) => s.id === id)

// ---------------------------------------------------------------------------

test('units: language, YouTube artist cleanup, Deezer preview', () => {
  assert.equal(normalizeLang('tr-TR'), 'tr')
  assert.equal(normalizeLang('xx', 'de'), 'de')
  assert.equal(cleanYouTubeArtist('Zeynep Bastık & ​Emre Aydın | Zeynep Bastık'), 'Zeynep Bastık & Emre Aydın')
  assert.equal(cleanYouTubeArtist('Jennifer Lopez ve Pitbull - 3,9 Mr dinlenme'), 'Jennifer Lopez ve Pitbull')
  assert.equal(mapYouTubeItem({ id: 'RDCLAK', type: 'playlist', title: 'Pump-Up Pop', uploader: 'Oynatma listesi • YouTube Music', url: 'https://music.youtube.com/playlist?list=RDCLAK' }).kind, 'playlist')
  assert.equal(mapDeezerTrack({ id: 1, title: 'x', preview: 'https://cdn/p.mp3', artist: { id: 9, name: 'A' }, album: { id: 3 } }).previewUrl, 'https://cdn/p.mp3')
  assert.equal(mapDeezerTrack({ id: 1, title: 'x', preview: 'http://cdn/p.mp3' }).previewUrl, null, 'only https previews')
})

test('online cache: fresh hits, stale-while-revalidate, outage tolerance, per-value TTL', async (t) => {
  const root = tmpDir('cache')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const db = await openPlayerDatabase(root)
  let clock = 1_000_000
  const cache = createOnlineCache(db, { now: () => clock, logger: silentLogger })
  let loads = 0
  let fail = false
  const loader = async () => { loads += 1; if (fail) throw new Error('down'); return { v: loads } }

  assert.deepEqual(await cache.wrap('k', 1000, loader), { v: 1 })
  assert.deepEqual(await cache.wrap('k', 1000, loader), { v: 1 })
  assert.equal(loads, 1, 'fresh hit')

  // Concurrent misses share one request.
  const [a, b] = await Promise.all([cache.wrap('k2', 1000, loader), cache.wrap('k2', 1000, loader)])
  assert.deepEqual(a, b)
  assert.equal(loads, 2)

  clock += 5000
  assert.deepEqual(await cache.wrap('k', 1000, loader), { v: 1 }, 'stale value served instantly')
  await waitFor(() => cache.inflightCount() === 0)
  assert.deepEqual(await cache.wrap('k', 1000, loader), { v: 3 }, 'refreshed in the background')

  fail = true
  clock += 5000
  assert.deepEqual(await cache.wrap('k', 1000, loader), { v: 3 }, 'provider outage keeps the stale value')
  await waitFor(() => cache.inflightCount() === 0)
  assert.deepEqual(cache.peek('k'), { v: 3 })

  fail = false
  await cache.wrap('miss', 10_000, async () => null, { ttlFor: (v) => (v ? 10_000 : 100) })
  clock += 200
  let reloaded = false
  await cache.wrap('miss', 10_000, async () => { reloaded = true; return 'found' }, { ttlFor: (v) => (v ? 10_000 : 100) })
  await waitFor(() => cache.inflightCount() === 0)
  assert.equal(reloaded, true, '"not found" answers expire sooner')
  db.close()
})

test('discover: personal shelves from your library, then global shelves, all badged', async (t) => {
  const { call, admin } = await setup(t)
  // Listening history makes Sezen Aksu the main seed.
  const owned = (await call('GET', '/search?q=hadi', { token: admin })).body.tracks[0]
  await call('POST', '/history', { token: admin, body: { trackId: owned.id, playedMs: 60_000 } })

  const r = await call('GET', '/discover?lang=tr', { token: admin })
  assert.equal(r.status, 200)
  assert.equal(r.body.enabled, true)
  assert.equal(r.body.lang, 'tr')
  const ids = r.body.shelves.map((s) => s.id)
  assert.ok(ids.indexOf('new-from-your-artists') < ids.indexOf('yt-home-0'), 'personal shelves come first')

  const fresh = byId(r.body.shelves, 'new-from-your-artists')
  assert.deepEqual(fresh.items.map((a) => a.title), ['Tek', 'Yepyeni', 'Gülümse'], 'only releases from the last 180 days, newest first')
  assert.ok(fresh.items.find((a) => a.title === 'Gülümse').library?.albumId, 'owned album is badged')

  const missing = byId(r.body.shelves, 'missing-sezen-aksu')
  assert.equal(missing.titleKey, 'player.discover.missingFromArtist')
  assert.deepEqual(missing.titleVars, { artist: 'Sezen Aksu' })
  assert.deepEqual(missing.items.map((x) => x.title), ['Firuze'], 'songs you already own (also "Official Video" variants) are left out')

  const fans = byId(r.body.shelves, 'fans-sezen-aksu')
  assert.equal(fans.kind, 'artists')
  assert.ok(fans.items.find((a) => a.title === 'Tarkan').library?.artistId, 'artists in your library are badged')
  const radio = r.body.shelves.find((s) => s.id.startsWith('radio-'))
  assert.ok(radio && ['Sezen Aksu', 'Tarkan'].includes(radio.seed), 'daily-rotating artist radio')
  assert.deepEqual(byId(r.body.shelves, 'genre-132').titleVars, { genre: 'Pop' }, 'top library genre → Deezer genre chart')

  const home = byId(r.body.shelves, 'yt-home-0')
  assert.equal(home.title, 'Hızlı seçimler')
  assert.equal(home.subtitleKey, 'player.discover.ytPersonal')
  assert.equal(home.items[0].library, null, '"Firuze" is not in the library yet')
  const chart = byId(r.body.shelves, 'dz-chart-tracks')
  assert.equal(chart.items[0].library?.trackId, owned.id, 'chart song you own is badged')
  assert.equal(chart.items[0].previewUrl, 'https://cdnt-preview.dzcdn.net/1.mp3')
  const country = byId(r.body.shelves, 'dz-country-top')
  assert.deepEqual(country.titleVars, { country: 'TR' }, 'Turkish UI gets the Top Turkey chart')
  for (const id of ['yt-popular', 'yt-new', 'yt-local', 'yt-playlists', 'dz-chart-albums', 'dz-chart-artists', 'dz-chart-playlists']) assert.ok(ids.includes(id), id)
  assert.ok(!ids.includes('sp-new-releases'), 'Spotify shelves need credentials')
})

test('discover is cached, survives outages and never waits for a hanging source', async (t) => {
  const { call, admin, fake, service } = await setup(t, { shelfTimeoutMs: 300 })
  await call('GET', '/discover', { token: admin })
  const before = { ...fake.calls }
  await call('GET', '/discover', { token: admin })
  assert.deepEqual(fake.calls, before, 'second load is served from the cache')

  // Charts expire and Deezer is down → the stale chart is still shown.
  service.context.db.prepare("UPDATE online_cache SET expires_at = 0 WHERE key = 'dz:chart:tracks'").run()
  fake.sources.deezer.failChart = true
  let r = await call('GET', '/discover', { token: admin })
  assert.ok(byId(r.body.shelves, 'dz-chart-tracks'), 'stale chart shown during outage')

  // A hanging YouTube Music home does not block the page.
  service.context.db.prepare("DELETE FROM online_cache WHERE key LIKE 'yt:home:%'").run()
  fake.sources.youtube.hang = true
  const started = Date.now()
  r = await call('GET', '/discover', { token: admin })
  assert.ok(Date.now() - started < 2000)
  assert.equal(r.body.partial, true)
  assert.ok(!r.body.shelves.some((s) => s.id.startsWith('yt-home')))
  assert.ok(byId(r.body.shelves, 'yt-popular'), 'other shelves still arrive')
})

test('discovery respects provider toggles, the master switch and user permissions', async (t) => {
  const { call, admin } = await setup(t)
  await call('PATCH', '/admin/config', { token: admin, body: { onlineProviders: ['deezer'] } })
  let r = await call('GET', '/discover', { token: admin })
  assert.ok(!r.body.shelves.some((s) => s.source === 'youtube'))
  r = await call('GET', '/discover/mood/party', { token: admin })
  assert.deepEqual(r.body.items, [])

  await call('PATCH', '/admin/config', { token: admin, body: { onlineProviders: ['deezer', 'youtube'] } })
  r = await call('GET', '/discover/mood/party', { token: admin })
  assert.equal(r.body.items[0].title, 'party song')
  assert.equal((await call('GET', '/discover/mood/nope', { token: admin })).status, 404)
  assert.ok((await call('GET', '/discover/moods', { token: admin })).body.items.includes('focus'))

  // A guest only sees the download library: Tarkan (archive) is not "theirs".
  await call('POST', '/admin/users', { token: admin, body: { username: 'misafir', password: 'guestsecret' } })
  const guest = (await call('POST', '/auth/login', { body: { username: 'misafir', password: 'guestsecret', client: 'device' } })).body.token
  r = await call('GET', '/discover?scope=personal', { token: guest })
  assert.ok(!r.body.shelves.some((s) => s.seed === 'Tarkan'), 'seeds come only from libraries the user can see')
  const fans = byId(r.body.shelves, 'fans-sezen-aksu')
  assert.equal(fans.items.find((a) => a.title === 'Tarkan').library, null, 'no badge for artists in libraries you cannot see')

  await call('PATCH', '/admin/config', { token: admin, body: { discoveryEnabled: false } })
  r = await call('GET', '/discover', { token: admin })
  assert.equal(r.body.enabled, false)
  assert.deepEqual(r.body.shelves, [])
})

test('online detail pages: album, playlist, artist (discography completion)', async (t) => {
  const { call, admin } = await setup(t)
  let r = await call('GET', '/online/album?provider=deezer&id=22', { token: admin })
  assert.equal(r.status, 200)
  assert.ok(r.body.album.library?.albumId)
  assert.equal(r.body.album.library.complete, false, 'same track count, but one song is not owned')
  assert.equal(r.body.ownedTracks, 1)
  assert.ok(r.body.tracks[0].library?.trackId)
  assert.equal(r.body.tracks[1].library, null)

  assert.equal((await call('GET', '/online/album?provider=deezer&id=999', { token: admin })).status, 404)
  assert.equal((await call('GET', '/online/album?provider=deezer&id=../../etc', { token: admin })).status, 400)
  assert.equal((await call('GET', '/online/album?provider=spotify&id=abc', { token: admin })).status, 409)

  const ytUrl = 'https://music.youtube.com/browse/MPREb_n2Dx35j93lZ'
  r = await call('GET', `/online/album?provider=youtube&url=${encodeURIComponent(ytUrl)}&artist=${encodeURIComponent('Sezen Aksu')}`, { token: admin })
  assert.equal(r.body.album.title, 'Gülümse')
  assert.ok(r.body.tracks[0].library?.trackId, 'artist from the page is used for matching')
  r = await call('GET', `/online/album?provider=youtube&url=${encodeURIComponent('https://evil.example/browse/MPREb_x')}`, { token: admin })
  assert.equal(r.status, 400)

  r = await call('GET', '/online/playlist?provider=deezer&id=7', { token: admin })
  assert.ok(r.body.tracks[0].library?.trackId)

  r = await call('GET', `/online/artist?name=${encodeURIComponent('Sezen Aksu')}`, { token: admin })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.singles.map((a) => a.title), ['Tek'])
  assert.deepEqual(r.body.albums.map((a) => a.title), ['Yepyeni', 'Gülümse', 'Eski Plak'])
  assert.equal(r.body.missingAlbums, 2)
  assert.ok(r.body.artist.library?.artistId)
  assert.equal((await call('GET', `/online/artist?name=${encodeURIComponent('Kimse Bilmez')}`, { token: admin })).status, 404)
})

test('Deezer artist lookup picks the most-followed exact name match', async () => {
  const { createDeezerSource } = await import('../modules/player/discoverySources.js')
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ data: [
      { id: 101507802, name: 'Tarkan', nb_fan: 47 },
      { id: 3254, name: 'Tarkan', nb_fan: 542341 },
      { id: 97171, name: 'Tarkan Erkan', nb_fan: 190 }
    ] })
  })
  const dz = createDeezerSource({ fetchImpl })
  assert.equal(await dz.findArtistId('tarkan'), '3254')
  assert.equal(await dz.findArtistId('Tarkan Bagci'), null, 'no partial-name matches')
})
