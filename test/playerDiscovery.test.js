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
    async findArtistId(name) { count(`findArtistId:${name}`); return { 'Sezen Aksu': '100', 'Tarkan': '200' }[name] || (/^Seed \d+$/.test(name) ? `9${name.slice(5)}` : null) },
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
        ? [dzAlbum(20, 'Yepyeni', 'Sezen Aksu', isoDaysAgo(10)), dzAlbum(21, 'Eski Plak', 'Sezen Aksu', isoDaysAgo(900)), dzAlbum(22, 'Gülümse', 'Sezen Aksu', isoDaysAgo(20)), dzAlbum(23, 'Tek', 'Sezen Aksu', isoDaysAgo(5), { recordType: 'single', trackCount: 1 }), ...(deezer.extraAlbums || [])]
        : []
    },
    async artistRadio(id) { count(`artistRadio:${id}`); return [dzTrack(60, 'Radyo Şarkısı', 'Nilüfer')] },
    async album(id) {
      count(`album:${id}`)
      if (id !== '22') return null
      return { album: dzAlbum(22, 'Gülümse', 'Sezen Aksu', isoDaysAgo(20), { trackCount: 2 }), tracks: [dzTrack(70, 'Hadi Bakalım', 'Sezen Aksu'), dzTrack(71, 'Yeni Parça', 'Sezen Aksu')] }
    },
    async playlist(id) { count(`playlist:${id}`); return { playlist: { provider: 'deezer', kind: 'playlist', id, title: 'Liste', url: `https://www.deezer.com/playlist/${id}` }, tracks: [dzTrack(80, 'Gülümse', 'Sezen Aksu'), ...(deezer.extraTracks || [])] } }
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
    async playlist(url, { artist, automix }) {
      count(automix ? 'ytAutomix' : 'ytPlaylist')
      return { title: automix ? 'Mix - Sezen Aksu' : 'Gülümse', count: 1, tracks: [{ provider: 'youtube', kind: 'track', id: 'w1', title: 'Hadi Bakalım', artist: artist || 'Sezen Aksu', url: 'https://music.youtube.com/watch?v=w1' }] }
    },
    async artistMixes(name) {
      count(`ytArtistMixes:${name}`)
      if (youtube.slowMixMs) await new Promise((resolve) => setTimeout(resolve, youtube.slowMixMs))
      if (name !== 'Sezen Aksu') return null
      return {
        artist: 'Sezen Aksu',
        mix: { provider: 'youtube', kind: 'playlist', id: 'RDEMsezen', title: 'Sezen Aksu Mix', artist: 'YouTube Music', url: 'https://music.youtube.com/watch?v=v1&list=RDEMsezen', mix: 'youtube', seed: 'Sezen Aksu' },
        shelves: [{ title: 'Featured on', items: [{ provider: 'youtube', kind: 'playlist', id: 'RDCLAK1', title: 'Presenting Sezen Aksu', artist: 'YouTube Music', url: 'https://music.youtube.com/playlist?list=RDCLAK1' }] }]
      }
    }
  }
  const spotify = { name: 'spotify', available: () => false }
  const apple = {
    name: 'apple',
    available: () => true,
    async artistPlaylists(name) {
      count(`appleArtist:${name}`)
      if (name !== 'Sezen Aksu') return null
      return { artist: 'Sezen Aksu', items: [{ provider: 'apple', kind: 'playlist', id: 'pl.abc', title: 'Sezen Aksu Essentials', artist: 'Apple Music Pop', url: 'https://music.apple.com/tr/playlist/sezen-aksu-essentials/pl.abc', seed: 'Sezen Aksu' }] }
    },
    async playlist(url) {
      count('applePlaylist')
      if (!/^https:\/\/music\.apple\.com\/[a-z]{2}\/playlist\//.test(url)) return null
      return { title: 'Sezen Aksu Essentials', count: 1, tracks: [{ provider: 'apple', kind: 'track', id: 'a1', title: 'Gülümse', artist: 'Sezen Aksu', url: 'https://music.apple.com/tr/song/gulumse/1' }] }
    }
  }
  return { sources: { deezer, youtube, spotify, apple }, calls }
}

async function setup(t, { shelfTimeoutMs = 2000, core = null } = {}) {
  const root = tmpDir('discover')
  const downloads = path.join(root, 'outputs')
  await writeTrack(path.join(downloads, 'Sezen Aksu', 'Gülümse', '01.mp3'), { title: 'Hadi Bakalım', artist: 'Sezen Aksu', album: 'Gülümse', trackNumber: '1', genre: 'Pop' })
  await writeTrack(path.join(downloads, 'Sezen Aksu', 'Gülümse', '02.mp3'), { title: 'Gülümse', artist: 'Sezen Aksu', album: 'Gülümse', trackNumber: '2', genre: 'Pop' })
  const archive = path.join(root, 'archive')
  await writeTrack(path.join(archive, 'Tarkan.mp3'), { title: 'Şımarık', artist: 'Tarkan', genre: 'Pop' })
  const fake = createFakeSources()
  const service = await startPlayerService({
    env: {}, logger: silentLogger, dataDir: path.join(root, 'data'), cacheDir: path.join(root, 'cache'),
    defaultLibraryDir: downloads, initialScanDelayMs: -1, core: core || { inspect: async () => ({}) }, bridgePollMs: 1000,
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

test('library album lists the songs it is missing (same release on Deezer)', async (t) => {
  const { call, admin, fake } = await setup(t)
  const albums = (await call('GET', '/albums?limit=50', { token: admin })).body.items
  const local = albums.find((a) => a.title === 'Gülümse')
  assert.ok(local, 'library album exists')
  const r = await call('GET', `/albums/${local.id}/missing`, { token: admin })
  assert.equal(r.status, 200)
  assert.equal(r.body.found, true)
  assert.equal(r.body.total, 2)
  assert.deepEqual(r.body.missing.map((m) => m.title), ['Yeni Parça'], 'owned songs are not listed')
  assert.equal(r.body.album.id, '22')
  assert.ok(fake.calls['artistAlbums:100'] >= 1, 'found through the artist discography')
  // An album that is not on Deezer simply has nothing to add.
  fake.sources.deezer.searchAlbums = async () => []
  const other = albums.find((a) => a.title !== 'Gülümse')
  if (other) {
    const none = await call('GET', `/albums/${other.id}/missing`, { token: admin })
    assert.equal(none.status, 200)
    assert.deepEqual(none.body.missing, [])
  }
  assert.equal((await call('GET', '/albums/999999/missing', { token: admin })).status, 404)
})

test('suggestions: library songs + new songs for playlists and mixes, autoplay', async (t) => {
  const { call, admin } = await setup(t)
  const tracks = (await call('GET', '/tracks?limit=50', { token: admin })).body.items
  const hadi = tracks.find((tr) => tr.title === 'Hadi Bakalım')
  const gulumse = tracks.find((tr) => tr.title === 'Gülümse')
  const pl = (await call('POST', '/playlists', { token: admin, body: { name: 'Liste', trackIds: [hadi.id] } })).body
  const r = await call('GET', `/playlists/${pl.id}/suggestions`, { token: admin })
  assert.equal(r.status, 200)
  const lib = r.body.items.filter((i) => i.provider === 'library')
  assert.ok(lib.some((i) => i.library.trackId === gulumse.id), 'same artist / folder from the library')
  assert.ok(!lib.some((i) => i.library.trackId === hadi.id), 'songs already in the playlist are not suggested')
  assert.ok(r.body.items.some((i) => i.provider === 'deezer' && !i.library), 'new songs from the artist radio')
  // Autoplay: more songs like the seed, never the seed itself.
  const auto = await call('GET', `/autoplay?seed=${hadi.id}&exclude=${hadi.id}`, { token: admin })
  assert.ok(auto.body.items.some((tr) => tr.id === gulumse.id))
  assert.ok(!auto.body.items.some((tr) => tr.id === hadi.id))
  await call('POST', '/history', { token: admin, body: { trackId: gulumse.id, playedMs: 60_000 } })
  const fromPreview = await call('GET', `/autoplay?artist=${encodeURIComponent(gulumse.artist)}&exclude=${hadi.id}`, { token: admin })
  assert.equal(fromPreview.body.items[0]?.id, gulumse.id)
  const mixes = (await call('GET', '/mixes', { token: admin })).body
  const mix = (mixes.items || mixes.mixes || [])[0]
  if (mix) assert.equal((await call('GET', `/mixes/${encodeURIComponent(mix.id)}/online`, { token: admin })).status, 200)
})

test('autoplay: collaborations, related artists, listened first, never empty', async (t) => {
  const { call, admin, service } = await setup(t)
  const archive = service.context.libraries.list().find((l) => !l.isDefault).path
  await writeTrack(path.join(archive, 'Ilkay Sencan, Mahmut Orhan - Şașkın - mp3', 'Ilkay Sencan, Mahmut Orhan - Şașkın.mp3'), { title: 'Şașkın', artist: 'Ilkay Sencan, Mahmut Orhan' })
  await writeTrack(path.join(archive, 'Mahmut Orhan - Feel.mp3'), { title: 'Feel', artist: 'Mahmut Orhan' })
  await writeTrack(path.join(archive, 'Nilüfer - Ve Melankoli.mp3'), { title: 'Ve Melankoli', artist: 'Nilüfer' })
  await service.context.scanner.requestScan('all')
  const tracks = await waitFor(async () => {
    const items = (await call('GET', '/tracks?limit=50', { token: admin })).body.items
    return items.length >= 6 ? items : null
  }, { label: 'rescan' })
  const byTitle = (title) => tracks.find((tr) => tr.title === title)
  const saskin = byTitle('Şașkın')

  // Search finds the s-comma spelling with an s-cedilla query.
  const found = (await call('GET', `/search?q=${encodeURIComponent('şaşkın')}`, { token: admin })).body.tracks
  assert.ok(found.some((tr) => tr.id === saskin.id))

  // A collaboration continues with each collaborator's own songs, then the
  // rest of the library (no genre, no other match: still not empty).
  let r = await call('GET', `/autoplay?seed=${saskin.id}&artist=${encodeURIComponent(saskin.artist)}&exclude=${saskin.id}`, { token: admin })
  assert.equal(r.status, 200)
  assert.equal(r.body.items[0]?.id, byTitle('Feel').id)
  assert.ok(r.body.items.length >= 4, 'topped up from the library')
  assert.ok(!r.body.items.some((tr) => tr.id === saskin.id))

  // Related artists (Deezer) rank above a genre-only match; a listened song
  // comes first within its tier.
  const simarik = byTitle('Şımarık')
  r = await call('GET', `/autoplay?seed=${simarik.id}&artist=Tarkan&genre=Pop&exclude=${simarik.id}`, { token: admin })
  const order = r.body.items.map((tr) => tr.title)
  assert.ok(order.indexOf('Ve Melankoli') < order.indexOf('Gülümse'), order.join(', '))
  await call('POST', '/history', { token: admin, body: { trackId: byTitle('Hadi Bakalım').id, playedMs: 60_000 } })
  r = await call('GET', `/autoplay?seed=${simarik.id}&artist=Tarkan&genre=Pop&exclude=${simarik.id}`, { token: admin })
  const pop = r.body.items.filter((tr) => tr.artist === 'Sezen Aksu').map((tr) => tr.title)
  assert.equal(pop[0], 'Hadi Bakalım')
})

test('mixes & playlists: around an artist (search) and on home, with detail pages', async (t) => {
  const { call, admin } = await setup(t)
  const owned = (await call('GET', '/search?q=hadi', { token: admin })).body.tracks[0]
  await call('POST', '/history', { token: admin, body: { trackId: owned.id, playedMs: 60_000 } })

  let r = await call('GET', `/online/artist-mixes?name=${encodeURIComponent('Sezen Aksu')}&lang=tr`, { token: admin })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.mixes.map((m) => [m.provider, m.title]), [['youtube', 'Sezen Aksu Mix'], ['deezer', 'Sezen Aksu Mix']])
  const dzMix = r.body.mixes[1]
  assert.equal(dzMix.downloadable, false, 'Deezer artist mixes have no link the core can download')
  assert.equal(dzMix.url, null)
  assert.equal(dzMix.mixId, '100')
  assert.deepEqual(r.body.playlists.map((p) => p.title), ['Sezen Aksu Essentials', 'Presenting Sezen Aksu'], 'sources take turns')
  r = await call('GET', `/online/artist-mixes?name=${encodeURIComponent('Kimse Bilmez')}`, { token: admin })
  assert.deepEqual([r.body.mixes, r.body.playlists], [[], []])

  // Deezer mix detail: artist radio songs, owned ones badged.
  r = await call('GET', '/online/playlist?provider=deezer&mix=artist&id=100', { token: admin })
  assert.equal(r.status, 200)
  assert.equal(r.body.playlist.title, 'Sezen Aksu Mix')
  assert.equal(r.body.playlist.downloadable, false)
  assert.equal(r.body.tracks[0].title, 'Radyo Şarkısı')
  assert.equal((await call('GET', '/online/playlist?provider=deezer&mix=artist&id=abc', { token: admin })).status, 400)

  // YouTube mixes are read like the download pipeline reads automixes;
  // YouTube Music's own RDCLAK lists are plain playlists.
  r = await call('GET', `/online/playlist?provider=youtube&url=${encodeURIComponent('https://music.youtube.com/watch?v=v1&list=RDEMsezen')}`, { token: admin })
  assert.equal(r.body.playlist.mix, 'youtube')
  assert.equal(r.body.playlist.title, 'Mix - Sezen Aksu')
  assert.ok(r.body.tracks[0].library?.trackId)
  r = await call('GET', `/online/playlist?provider=youtube&url=${encodeURIComponent('https://music.youtube.com/playlist?list=RDCLAK1')}`, { token: admin })
  assert.equal(r.body.playlist.mix, undefined)

  r = await call('GET', `/online/playlist?provider=apple&url=${encodeURIComponent('https://music.apple.com/tr/playlist/sezen-aksu-essentials/pl.abc')}`, { token: admin })
  assert.equal(r.status, 200)
  assert.equal(r.body.playlist.provider, 'apple')
  assert.ok(r.body.tracks[0].library?.trackId, 'Apple songs you own are badged')
  assert.equal((await call('GET', `/online/playlist?provider=apple&url=${encodeURIComponent('https://evil.example/x')}`, { token: admin })).status, 400)

  // Home: one mix shelf per source, built from the artists you listen to.
  r = await call('GET', '/discover?lang=tr', { token: admin })
  const ids = r.body.shelves.map((s) => s.id)
  for (const id of ['mixes-youtube', 'mixes-yt-featured', 'mixes-deezer', 'mixes-apple']) assert.ok(ids.includes(id), id)
  assert.ok(!ids.includes('mixes-spotify'), 'Spotify lists need credentials')
  assert.equal(byId(r.body.shelves, 'mixes-youtube').kind, 'playlists')
  assert.ok(byId(r.body.shelves, 'mixes-deezer').items.some((m) => m.title === 'Sezen Aksu Mix' && m.mix === 'deezer'))

  // Switching a source off removes its mixes.
  await call('PATCH', '/admin/config', { token: admin, body: { onlineProviders: ['deezer', 'youtube'] } })
  r = await call('GET', '/discover?lang=tr', { token: admin })
  assert.ok(!r.body.shelves.some((s) => s.id === 'mixes-apple'))
})

test('units: playlist search mapping, Apple artist page, resolved tracks, provider migration', async () => {
  const { createOnlineSearch, mapSpotifyPlaylist } = await import('../modules/player/online.js')
  const { parseAppleArtistPlaylists, mapResolvedTrack, isApplePlaylistUrl } = await import('../modules/player/discoverySources.js')
  const { migrateConfig, normalizeConfig } = await import('../modules/player/service.js')

  const fetchImpl = async (url) => ({ ok: true, json: async () => (/\/search\/playlist/.test(url) ? { data: [{ id: 5, title: 'Sezen Aksu Hits', nb_tracks: 40, user: { name: 'Deezer Pop Editor' }, link: 'https://www.deezer.com/playlist/5' }] } : { data: [] }) })
  const searchPlaylistsImpl = async () => [{ type: 'playlist', id: 'RDCLAK9', playlistId: 'RDCLAK9', title: 'Presenting Sezen Aksu', uploader: 'Oynatma listesi • YouTube Music', webpage_url: 'https://music.youtube.com/playlist?list=RDCLAK9' }]
  const online = createOnlineSearch({ getEnabledProviders: () => ['deezer', 'youtube'], fetchImpl, searchPlaylistsImpl, logger: { debug() {} } })
  const res = await online.search('sezen aksu', { kinds: ['playlist'] })
  assert.deepEqual(res.playlists.map((p) => [p.provider, p.title, p.artist]), [['deezer', 'Sezen Aksu Hits', 'Deezer Pop Editor'], ['youtube', 'Presenting Sezen Aksu', 'YouTube Music']])

  const sp = mapSpotifyPlaylist({ id: '37i9dQZF1DZ06evO1', name: 'This Is Tarkan', owner: { id: 'spotify', display_name: 'Spotify' }, tracks: { total: 50 }, images: [{ url: 'https://i.scdn.co/x' }] })
  assert.equal(sp.editorial, true)
  assert.equal(sp.url, 'https://open.spotify.com/playlist/37i9dQZF1DZ06evO1')

  const data = { a: { items: [
    { titleLinks: [{ title: 'Tarkan Essentials' }], subtitleLinks: [{ title: 'Apple Music Pop' }], artwork: { dictionary: { url: 'https://is1-ssl.mzstatic.com/image/thumb/a/{w}x{h}SC.FPESS05.{f}' } }, contentDescriptor: { kind: 'playlist', identifiers: { storeAdamID: 'pl.c2c5' }, url: 'https://music.apple.com/tr/playlist/tarkan-essentials/pl.c2c5' } },
    { titleLinks: [{ title: 'Tarkan Video Essentials' }], contentDescriptor: { kind: 'playlist', identifiers: { storeAdamID: 'pl.b01b' }, url: 'https://music.apple.com/tr/playlist/tarkan-video-essentials/pl.b01b' } },
    { titleLinks: [{ title: 'Evil' }], contentDescriptor: { kind: 'playlist', identifiers: { storeAdamID: 'pl.evil' }, url: 'https://evil.example/tr/playlist/x/pl.evil' } },
    { titleLinks: [{ title: 'Kuantum 51' }], contentDescriptor: { kind: 'album', identifiers: { storeAdamID: '1' }, url: 'https://music.apple.com/tr/album/x/1' } }
  ] } }
  const html = `<html><script type="application/json" id="serialized-server-data">${JSON.stringify(data)}</script></html>`
  const lists = parseAppleArtistPlaylists(html, 'Tarkan')
  assert.deepEqual(lists.map((p) => p.title), ['Tarkan Essentials'], 'video lists, albums and foreign links are skipped')
  assert.equal(lists[0].artworkUrl, 'https://is1-ssl.mzstatic.com/image/thumb/a/600x600SC.FPESS05.jpg')
  assert.equal(lists[0].seed, 'Tarkan')
  assert.equal(isApplePlaylistUrl('https://music.apple.com/tr/playlist/a/pl.1'), true)
  assert.equal(isApplePlaylistUrl('https://music.apple.com.evil/tr/playlist/a/pl.1'), false)

  assert.deepEqual(mapResolvedTrack({ title: 'Dudu', artist: 'Tarkan', album: 'Dudu', duration_ms: 271000, coverUrl: 'https://img/x.jpg', spUrl: 'https://open.spotify.com/track/abc', isrc: 'TRX' }, 'spotify'),
    { provider: 'spotify', kind: 'track', id: 'https://open.spotify.com/track/abc', title: 'Dudu', artist: 'Tarkan', album: 'Dudu', duration: 271, artworkUrl: 'https://img/x.jpg', url: 'https://open.spotify.com/track/abc', isrc: 'TRX' })
  assert.equal(mapResolvedTrack({ title: '' }, 'apple'), null)

  // Apple Music joins saved provider lists once; turning it off later sticks.
  const migrated = normalizeConfig(migrateConfig({ onlineProviders: ['deezer', 'youtube'] }))
  assert.deepEqual(migrated.onlineProviders, ['deezer', 'youtube', 'apple'])
  const off = normalizeConfig({ onlineProviders: ['deezer'] }, migrated)
  assert.deepEqual(normalizeConfig(migrateConfig(off)).onlineProviders, ['deezer'])
})

test('home never waits for mix lookups: cached ones show, the rest arrive on a later load', async (t) => {
  const { call, admin, fake } = await setup(t)
  const owned = (await call('GET', '/search?q=hadi', { token: admin })).body.tracks[0]
  await call('POST', '/history', { token: admin, body: { trackId: owned.id, playedMs: 60_000 } })
  fake.sources.youtube.slowMixMs = 1500
  const started = Date.now()
  let r = await call('GET', '/discover?lang=tr', { token: admin })
  assert.ok(Date.now() - started < 1200, 'slow mix lookups do not delay the page')
  assert.ok(!r.body.shelves.some((s) => s.id === 'mixes-youtube'))
  assert.equal(r.body.partial, true, 'the client is told to ask again')
  await waitFor(async () => (await call('GET', '/discover?lang=tr', { token: admin })).body.shelves?.some((s) => s.id === 'mixes-youtube'), { timeoutMs: 8000, intervalMs: 400, label: 'YouTube mixes shelf' })
  r = await call('GET', '/discover?lang=tr', { token: admin })
  assert.equal(byId(r.body.shelves, 'mixes-youtube').items[0].title, 'Sezen Aksu Mix')
})

test('personal shelves come from a wide artist pool: a different pick per day / refresh, stable within one', async (t) => {
  const { call, admin, service } = await setup(t)
  const root = path.dirname(service.context.libraries.list().find((l) => l.isDefault)?.path || '')
  for (let i = 1; i <= 12; i++) {
    const name = `Seed ${String(i).padStart(2, '0')}`
    await writeTrack(path.join(root, 'outputs', name, 'Album', '01.mp3'), { title: `Song ${i}`, artist: name, album: 'Album' })
  }
  await service.context.scanner.requestScan('all')
  const picks = async (round) => {
    const r = await call('GET', `/discover?scope=personal&round=${round}`, { token: admin })
    return r.body.shelves.filter((s) => s.id.startsWith('fans-')).map((s) => s.seed).sort()
  }
  const first = await picks(0)
  assert.equal(first.length, 3)
  assert.deepEqual(await picks(0), first, 'same day + same round = same artists')
  const seen = new Set(first)
  for (let round = 1; round <= 6; round++) for (const name of await picks(round)) seen.add(name)
  assert.ok(seen.size > 4, `refreshing brings other artists (${[...seen].join(', ')})`)
})

test('followed playlists: library songs added, new ones downloaded into it, removed ones stay removed', async (t) => {
  const core = {
    inspect: async (url) => ({ provider: 'deezer', url, isPlaylist: false }),
    createAndEnqueue: () => new Promise(() => {}),
    getJob: async () => null,
    cancel: async () => {},
    cleanupJob: async () => false
  }
  const { call, admin, fake, service } = await setup(t, { core })
  // The follow cache answers come from the online cache: start clean each sync.
  const clearCache = () => service.context.db.prepare("DELETE FROM online_cache WHERE key LIKE 'dz:playlist:%'").run()

  let r = await call('POST', '/follows/playlists', { token: admin, body: { provider: 'deezer', id: '7', title: 'Takip Listesi' } })
  assert.equal(r.status, 201)
  const followId = r.body.id
  const playlistId = r.body.playlistId
  await waitFor(async () => (await call('GET', '/follows/playlists', { token: admin })).body.items[0]?.lastSyncAt, { label: 'first sync' })
  let pl = (await call('GET', `/playlists/${playlistId}`, { token: admin })).body
  assert.equal(pl.name, 'Takip Listesi')
  assert.deepEqual(pl.tracks.map((tr) => tr.title), ['Gülümse'], 'the song you own is added right away')
  assert.equal(pl.follow.provider, 'deezer')
  assert.equal((await call('GET', '/online/playlist?provider=deezer&id=7', { token: admin })).body.follow.id, followId)
  r = await call('POST', '/follows/playlists', { token: admin, body: { provider: 'deezer', id: '7', title: 'Again' } })
  assert.equal(r.body.id, followId, 'following twice keeps one follow')

  // A new song on the list: downloaded into the playlist.
  fake.sources.deezer.extraTracks = [dzTrack(81, 'Yepyeni Şarkı', 'Sezen Aksu')]
  clearCache()
  r = await call('POST', `/follows/playlists/${followId}/sync`, { token: admin })
  assert.equal(r.body.lastAdded, 1)
  const dl = (await call('GET', '/downloads?all=1', { token: admin })).body.items.find((d) => d.title === 'Yepyeni Şarkı')
  assert.ok(dl, 'download requested')
  assert.equal(dl.playlistId, playlistId)

  // Removed by hand: not added back on the next sync.
  pl = (await call('GET', `/playlists/${playlistId}`, { token: admin })).body
  await call('DELETE', `/playlists/${playlistId}/tracks/${pl.tracks[0].entryId}`, { token: admin })
  clearCache()
  r = await call('POST', `/follows/playlists/${followId}/sync`, { token: admin })
  assert.equal(r.body.lastAdded, 0)
  assert.equal((await call('GET', `/playlists/${playlistId}`, { token: admin })).body.tracks.length, 0)

  // Artist radios cannot be followed; unfollowing keeps the playlist.
  r = await call('POST', '/follows/playlists', { token: admin, body: { provider: 'deezer', id: '100', mix: 'artist', title: 'Radio' } })
  assert.equal(r.body.error.code, 'FOLLOW_UNSUPPORTED')
  assert.equal((await call('DELETE', `/follows/playlists/${followId}`, { token: admin })).status, 200)
  assert.deepEqual((await call('GET', '/follows/playlists', { token: admin })).body.items, [])
  assert.equal((await call('GET', `/playlists/${playlistId}`, { token: admin })).status, 200)
})

test('new releases of followed artists: first look is silent, later ones notify (and download when chosen)', async (t) => {
  const core = {
    inspect: async (url) => ({ provider: 'deezer', url, isPlaylist: true }),
    createAndEnqueue: () => new Promise(() => {}),
    getJob: async () => null,
    cancel: async () => {},
    cleanupJob: async () => false
  }
  const { call, admin, fake, service } = await setup(t, { core })
  const artist = (await call('GET', '/search?q=sezen', { token: admin })).body.artists[0]
  await call('PUT', `/favorites/artist/${artist.id}`, { token: admin })

  let r = await call('POST', '/releases/check', { token: admin })
  assert.equal(r.body.checked, 1)
  assert.equal(r.body.found, 0, 'the existing discography is not "new"')
  assert.equal((await call('GET', '/notifications', { token: admin })).body.unread, 0)

  await call('PUT', '/releases/settings', { token: admin, body: { autoDownload: true } })
  fake.sources.deezer.extraAlbums = [dzAlbum(30, 'Taze Albüm', 'Sezen Aksu', isoDaysAgo(1)), dzAlbum(31, 'Arşivden', 'Sezen Aksu', isoDaysAgo(400))]
  service.context.db.prepare("DELETE FROM online_cache WHERE key LIKE 'dz:artist-albums:%'").run()
  r = await call('POST', '/releases/check', { token: admin })
  assert.equal(r.body.found, 1, 'only the recent release counts')
  const n = (await call('GET', '/notifications', { token: admin })).body
  assert.equal(n.unread, 1)
  assert.equal(n.items[0].title, 'Taze Albüm')
  assert.equal(n.items[0].link, '/online/album?provider=deezer&id=30')
  assert.ok((await call('GET', '/downloads?all=1', { token: admin })).body.items.some((d) => d.title === 'Taze Albüm' && d.kind === 'album'), 'auto-downloaded')

  r = await call('POST', '/releases/check', { token: admin })
  assert.equal(r.body.found, 0, 'announced once')
  assert.equal((await call('POST', '/notifications/read', { token: admin, body: {} })).body.unread, 0)
})

test('library health: duplicates (best copy first), trash moves the file, covers, low bitrate', async (t) => {
  const { call, admin, service } = await setup(t)
  const lib = service.context.libraries.list().find((l) => l.isDefault)
  await writeTrack(path.join(lib.path, 'Kopya', 'Hadi Bakalım.mp3'), { title: 'Hadi Bakalım', artist: 'Sezen Aksu', album: 'Kopya' })
  await service.context.scanner.requestScan('all')

  let r = await call('POST', '/admin/health/check', { token: admin })
  assert.equal(r.status, 200)
  const report = await waitFor(async () => (await call('GET', '/admin/health', { token: admin })).body.report, { label: 'health report' })
  assert.equal(report.duplicates.length, 1)
  assert.deepEqual(report.duplicates[0].map((x) => x.title), ['Hadi Bakalım', 'Hadi Bakalım'])
  assert.ok(report.missingCovers.some((a) => a.title === 'Gülümse'), 'fixture files have no cover')
  assert.ok(Array.isArray(report.lowBitrate) && Array.isArray(report.untagged))

  const copy = report.duplicates[0].find((x) => x.path.startsWith('Kopya'))
  r = await call('POST', '/admin/health/trash', { token: admin, body: { trackId: copy.id } })
  assert.equal(r.status, 200)
  assert.ok(!fs.existsSync(path.join(lib.path, 'Kopya', 'Hadi Bakalım.mp3')), 'moved away')
  assert.ok(fs.existsSync(path.join(service.dataDir, 'trash', r.body.trashedTo)), 'kept in the player trash')
  assert.equal((await call('GET', '/search?q=hadi', { token: admin })).body.tracks.length, 1)
  assert.equal((await call('GET', '/admin/health', { token: admin })).body.report.duplicates.length, 0)

  const album = report.missingCovers.find((a) => a.title === 'Gülümse')
  r = await call('POST', '/admin/health/cover', { token: admin, body: { albumId: album.id } })
  assert.equal(r.body.error.code, 'COVER_NOT_FOUND')

  await call('POST', '/admin/users', { token: admin, body: { username: 'normal', password: 'normalsecret' } })
  const user = (await call('POST', '/auth/login', { body: { username: 'normal', password: 'normalsecret', client: 'device' } })).body.token
  assert.equal((await call('GET', '/admin/health', { token: user })).status, 403)
})

test('units: duplicate grouping keeps different versions apart', async () => {
  const { findDuplicates } = await import('../modules/player/health.js')
  const row = (id, title, duration, extra = {}) => ({ id, title, artist_name: 'Tarkan', duration, bitrate: 128000, lossless: 0, size: 1, ...extra })
  const groups = findDuplicates([
    row(1, 'Dudu', 271), row(2, 'Dudu', 273, { bitrate: 320000 }), row(3, 'Dudu', 340),
    row(4, 'Kuzu Kuzu', 230, { lossless: 1 }), row(5, 'Kuzu Kuzu', 231)
  ])
  assert.deepEqual(groups.map((g) => g.map((x) => x.id)), [[2, 1], [4, 5]], 'best copy first; a much longer version is not a duplicate')
})
