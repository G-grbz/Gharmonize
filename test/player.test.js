import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import express from 'express'
import { writeTrack, age, tmpDir, silentLogger } from './fixtures/playerAudio.mjs'

import { createPlayerGate, normalizePlayerEnabled, normalizeRemoteAccessMode, isPlayerEnabled } from '../modules/player/gate.js'
import { classifyClientIp, isNetworkAllowed } from '../modules/player/network.js'
import { parseRange, resolveStreamTarget } from '../modules/player/stream.js'
import { parseFileNameFallback, normalizeKey } from '../modules/player/scanner.js'
import { buildFtsQuery } from '../modules/player/catalog.js'
import { parseLrc } from '../modules/player/lyrics.js'
import { validateLibraryPath } from '../modules/player/libraries.js'
import { resolvePlayerDataDir } from '../modules/player/paths.js'
import { startPlayerService, normalizeConfig } from '../modules/player/service.js'
import { createPlayerRouter } from '../modules/player/router.js'

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0

// ---------------------------------------------------------------------------
// Pure units

test('player gate normalizers and default-off behaviour', () => {
  assert.equal(normalizePlayerEnabled('on'), '1')
  assert.equal(normalizePlayerEnabled(''), '0')
  assert.equal(normalizePlayerEnabled('nope'), '0')
  assert.equal(normalizeRemoteAccessMode('TAILSCALE'), 'tailscale')
  assert.equal(normalizeRemoteAccessMode('everything'), 'off')
  assert.equal(isPlayerEnabled({}), false)
  assert.equal(isPlayerEnabled({ GHARMONIZE_PLAYER_ENABLED: '1' }), true)
})

test('disabled gate never loads the player service', async () => {
  const before = process.env.GHARMONIZE_PLAYER_ENABLED
  process.env.GHARMONIZE_PLAYER_ENABLED = '0'
  let loads = 0
  const gate = createPlayerGate({ loadService: async () => { loads += 1; throw new Error('must not load') }, logger: silentLogger })
  const app = express()
  app.use('/api/player', gate.middleware)
  const server = app.listen(0)
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/player`
    const status = await fetch(`${base}/status`)
    assert.equal(status.status, 200)
    assert.deepEqual(await status.json(), { enabled: false, name: 'Gharmonize Player' })
    const home = await fetch(`${base}/home`)
    assert.equal(home.status, 404)
    assert.equal((await home.json()).error.code, 'PLAYER_DISABLED')
    await gate.sync()
    assert.equal(loads, 0)
    assert.equal(gate.isRunning(), false)
  } finally {
    server.close()
    if (before === undefined) delete process.env.GHARMONIZE_PLAYER_ENABLED
    else process.env.GHARMONIZE_PLAYER_ENABLED = before
  }
})

test('gate starts lazily when enabled and fully stops when disabled', async () => {
  const before = process.env.GHARMONIZE_PLAYER_ENABLED
  let started = 0
  let stopped = 0
  const gate = createPlayerGate({
    logger: silentLogger,
    loadService: async () => ({
      startPlayerService: async () => {
        started += 1
        return { router: (_req, res) => res.json({ ok: true }), stop: async () => { stopped += 1 } }
      }
    })
  })
  try {
    process.env.GHARMONIZE_PLAYER_ENABLED = '1'
    await gate.sync()
    assert.equal(started, 1)
    assert.equal(gate.isRunning(), true)
    await gate.sync()
    assert.equal(started, 1, 'sync is idempotent')
    process.env.GHARMONIZE_PLAYER_ENABLED = '0'
    await gate.sync()
    assert.equal(stopped, 1)
    assert.equal(gate.isRunning(), false)
  } finally {
    if (before === undefined) delete process.env.GHARMONIZE_PLAYER_ENABLED
    else process.env.GHARMONIZE_PLAYER_ENABLED = before
  }
})

test('client network classification and remote access consent', () => {
  assert.equal(classifyClientIp('127.0.0.1'), 'loopback')
  assert.equal(classifyClientIp('::ffff:192.168.1.20'), 'lan')
  assert.equal(classifyClientIp('10.1.2.3'), 'lan')
  assert.equal(classifyClientIp('100.101.102.103'), 'tailscale')
  assert.equal(classifyClientIp('fd7a:115c:a1e0::1'), 'tailscale')
  assert.equal(classifyClientIp('fd00::1'), 'lan')
  assert.equal(classifyClientIp('8.8.8.8'), 'public')
  assert.equal(classifyClientIp('garbage'), 'unknown')

  for (const mode of ['off', 'tailscale', 'any']) {
    assert.equal(isNetworkAllowed('loopback', mode), true)
    assert.equal(isNetworkAllowed('lan', mode), true, 'local network always works')
    assert.equal(isNetworkAllowed('unknown', mode), false)
  }
  assert.equal(isNetworkAllowed('tailscale', 'off'), false)
  assert.equal(isNetworkAllowed('tailscale', 'tailscale'), true)
  assert.equal(isNetworkAllowed('public', 'tailscale'), false)
  assert.equal(isNetworkAllowed('public', 'any'), true)
})

test('range parsing', () => {
  assert.equal(parseRange('', 100), null)
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=50-1000', 100), { start: 50, end: 99 })
  assert.equal(parseRange('bytes=100-', 100), 'invalid')
  assert.equal(parseRange('bytes=5-1', 100), 'invalid')
  assert.equal(parseRange('items=0-1', 100), 'invalid')
  assert.equal(parseRange('bytes=0-1,5-6', 100), null)
})

test('stream target resolution never upgrades lossy sources', () => {
  assert.equal(resolveStreamTarget({}, {}), null)
  assert.equal(resolveStreamTarget({ quality: 'original' }, {}), null)
  assert.deepEqual(resolveStreamTarget({ quality: 'normal' }, { rel_path: 'a.flac', lossless: 1 }), { format: 'opus', bitrate: 128 })
  assert.deepEqual(resolveStreamTarget({ format: 'mp3', bitrate: 300 }, { rel_path: 'a.flac', lossless: 1 }), { format: 'mp3', bitrate: 320 })
  assert.equal(resolveStreamTarget({ format: 'mp3', bitrate: 320 }, { rel_path: 'a.mp3', bitrate: 192000 }), null)
  assert.deepEqual(resolveStreamTarget({ format: 'mp3', bitrate: 128 }, { rel_path: 'a.mp3', bitrate: 320000 }), { format: 'mp3', bitrate: 128 })
})

test('file name fallback, search keys and FTS query building', () => {
  assert.deepEqual(parseFileNameFallback('03 - Sezen Aksu - Firuze.mp3'), { artist: 'Sezen Aksu', title: 'Firuze', trackNo: 3 })
  assert.deepEqual(parseFileNameFallback('Only Title.flac'), { artist: null, title: 'Only Title', trackNo: null })
  assert.equal(normalizeKey('  Şarkı   IŞIK '), 'sarki isik')
  assert.equal(buildFtsQuery('Şarkı "x" *'), '"sarki"* AND "x"*')
  assert.equal(buildFtsQuery('  '), null)
})

test('LRC parsing supports offsets and multiple stamps', () => {
  const lines = parseLrc('[offset:+500]\n[00:01.00]one\n[00:03.50][00:05.00]two\nplain')
  assert.deepEqual(lines, [
    { timeMs: 500, text: 'one' },
    { timeMs: 3000, text: 'two' },
    { timeMs: 4500, text: 'two' }
  ])
})

test('library path validation refuses system folders and files', () => {
  if (process.platform === 'win32') return
  assert.throws(() => validateLibraryPath('relative/path'), /absolute/)
  assert.throws(() => validateLibraryPath('/etc'), /System folders/)
  assert.throws(() => validateLibraryPath('/'), /System folders/)
  assert.throws(() => validateLibraryPath('/definitely/not/here'), /does not exist/)
  const dir = tmpDir('valid')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x')
  assert.throws(() => validateLibraryPath(path.join(dir, 'file.txt')), /not a folder/)
  assert.equal(validateLibraryPath(dir), fs.realpathSync(dir))
})

test('player data stays on persistent volumes', () => {
  assert.equal(resolvePlayerDataDir({ PLAYER_DATA_DIR: '/x/y' }), path.resolve('/x/y'))
  assert.equal(resolvePlayerDataDir({ DATA_DIR: '/srv/app' }, { inDocker: true }), path.join('/srv/app', 'cache', 'player'))
  assert.equal(resolvePlayerDataDir({ DATA_DIR: '/srv/app' }, { inDocker: false }), path.join('/srv/app', 'player-data'))
})

test('config normalization clamps values', () => {
  const cfg = normalizeConfig({ scanIntervalMinutes: 1, transcodeCacheMb: -5, serverName: '  ', onlineLyrics: 0 })
  assert.equal(cfg.scanIntervalMinutes, 5)
  assert.equal(cfg.transcodeCacheMb, 0)
  assert.equal(cfg.serverName, 'Gharmonize Player')
  assert.equal(cfg.onlineLyrics, false)
  assert.equal(normalizeConfig({ scanIntervalMinutes: 0 }).scanIntervalMinutes, 0)
})

// ---------------------------------------------------------------------------
// Integration: real SQLite, real scan, real HTTP

async function setupPlayer(t, { mode = 'off' } = {}) {
  const root = tmpDir('int')
  const downloads = path.join(root, 'outputs')
  writeTrack(path.join(downloads, 'Sezen Aksu', 'Gülümse', '01 - Hadi Bakalım.mp3'), { title: 'Hadi Bakalım', artist: 'Sezen Aksu', album: 'Gülümse', trackNumber: '1', year: '1991', genre: 'Pop' }, { cover: true })
  writeTrack(path.join(downloads, 'Sezen Aksu', 'Gülümse', '02 - Gülümse.mp3'), { title: 'Gülümse', artist: 'Sezen Aksu', album: 'Gülümse', trackNumber: '2', year: '1991', genre: 'Pop' })
  writeTrack(path.join(downloads, 'Single', 'Barış Manço - Dağlar Dağlar.mp3'), {})
  writeTrack(path.join(downloads, 'Single', 'kirmizi.mp3'), { title: 'Kırmızı Işık', artist: 'İlhan Şeşen' })
  fs.writeFileSync(path.join(downloads, 'Single', 'Barış Manço - Dağlar Dağlar.lrc'), '[00:01.00]Dağlar dağlar\n[00:02.00]kurban olam')
  fs.writeFileSync(path.join(downloads, 'notes.txt'), 'not audio')

  const service = await startPlayerService({
    env: {},
    logger: silentLogger,
    dataDir: path.join(root, 'data'),
    cacheDir: path.join(root, 'cache'),
    defaultLibraryDir: downloads,
    initialScanDelayMs: -1
  })
  await service.context.scanner.requestScan('all')

  const currentMode = { value: mode }
  const router = createPlayerRouter(service.context, {
    adminBridge: () => ({
      getSession: (req) => req.get('x-test-gharmonize-admin') === 'yes',
      verifyPassword: (pw) => pw === 'GharmonizeAdmin1'
    }),
    getMode: () => currentMode.value
  })
  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())
  app.use('/api/player', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/player`
  t.after(async () => {
    server.close()
    await service.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const jar = { cookie: '' }
  async function call(method, url, { body, headers = {}, raw = false, auth = 'cookie' } = {}) {
    const h = { ...headers }
    if (body !== undefined) h['content-type'] = 'application/json'
    if (auth === 'cookie' && jar.cookie) h.cookie = jar.cookie
    const res = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie && auth === 'cookie') {
      const match = setCookie.match(/gharmonize_player_session=([^;]*)/)
      if (match) jar.cookie = match[1] ? `gharmonize_player_session=${match[1]}` : ''
    }
    if (raw) return res
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, body: json, headers: res.headers }
  }
  return { service, call, root, downloads, currentMode, jar, base, cookie: () => jar.cookie }
}

test('player end-to-end: setup, login, catalog, search, stream, personal data', async (t) => {
  const { call, downloads, base, cookie } = await setupPlayer(t)

  let r = await call('GET', '/status')
  assert.equal(r.status, 200)
  assert.equal(r.body.setupRequired, true)
  assert.equal(r.body.network, 'loopback')

  r = await call('GET', '/home')
  assert.equal(r.status, 401)

  r = await call('POST', '/setup', { body: { username: 'gokhan', password: 'short' , adminPassword: 'wrong' } })
  assert.equal(r.status, 401, 'first setup needs the Gharmonize admin')
  r = await call('POST', '/setup', { body: { username: 'gokhan', password: 'short', adminPassword: 'GharmonizeAdmin1' } })
  assert.equal(r.status, 400)
  assert.equal(r.body.error.code, 'WEAK_PASSWORD')
  r = await call('POST', '/setup', { body: { username: 'gokhan', displayName: 'Gökhan', password: 'supersecret', adminPassword: 'GharmonizeAdmin1' } })
  assert.equal(r.status, 201)
  assert.equal(r.body.user.role, 'admin')
  r = await call('POST', '/setup', { body: { username: 'x2', password: 'supersecret', adminPassword: 'GharmonizeAdmin1' } })
  assert.equal(r.status, 409)

  // Session cookie from setup works.
  r = await call('GET', '/me')
  assert.equal(r.status, 200)
  assert.equal(r.body.user.username, 'gokhan')

  r = await call('GET', '/stats')
  assert.equal(r.body.tracks, 4)
  assert.equal(r.body.albums, 1)

  r = await call('GET', '/albums')
  assert.equal(r.body.items.length, 1)
  const album = r.body.items[0]
  assert.equal(album.title, 'Gülümse')
  assert.equal(album.artist, 'Sezen Aksu')
  assert.equal(album.trackCount, 2)

  r = await call('GET', `/albums/${album.id}`)
  assert.deepEqual(r.body.tracks.map((t) => t.title), ['Hadi Bakalım', 'Gülümse'])
  const firstTrack = r.body.tracks[0]

  // Filename fallback for an untagged file.
  r = await call('GET', '/tracks?sort=alpha')
  const single = r.body.items.find((t) => t.title === 'Dağlar Dağlar')
  assert.ok(single, 'untagged file indexed from its file name')
  assert.equal(single.artist, 'Barış Manço')
  assert.equal(single.albumId, null)

  // Diacritic-insensitive search.
  r = await call('GET', '/search?q=daglar')
  assert.equal(r.body.tracks[0].id, single.id)
  r = await call('GET', '/search?q=gulumse')
  assert.equal(r.body.albums[0].id, album.id)
  r = await call('GET', '/search?q=kirmizi isik')
  assert.equal(r.body.tracks[0]?.title, 'Kırmızı Işık', 'Turkish dotless ı is folded for search')
  r = await call('GET', '/search?q=ilhan')
  assert.equal(r.body.tracks[0]?.artist, 'İlhan Şeşen')
  r = await call('GET', '/search?q=sezen')
  assert.equal(r.body.artists[0].name, 'Sezen Aksu')

  r = await call('GET', `/artists/${r.body.artists[0].id}`)
  assert.equal(r.body.albums.length, 1)
  assert.equal(r.body.topTracks.length, 2)

  // Original stream with ranges.
  const size = fs.statSync(path.join(downloads, 'Sezen Aksu', 'Gülümse', '01 - Hadi Bakalım.mp3')).size
  let res = await fetch(`${base}/stream/${firstTrack.id}`)
  assert.equal(res.status, 401, 'stream requires auth')
  res = await fetch(`${base}/stream/${firstTrack.id}`, { headers: { cookie: cookie(), range: 'bytes=0-99' } })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes 0-99/${size}`)
  assert.equal(res.headers.get('content-type'), 'audio/mpeg')
  assert.equal((await res.arrayBuffer()).byteLength, 100)
  res = await fetch(`${base}/stream/${firstTrack.id}`, { headers: { cookie: cookie(), range: `bytes=${size}-` } })
  assert.equal(res.status, 416)
  res = await fetch(`${base}/stream/${firstTrack.id}`, { headers: { cookie: cookie() } })
  assert.equal(res.status, 200)
  assert.equal(Number(res.headers.get('content-length')), size)
  await res.arrayBuffer()

  // Embedded artwork (falls back to the original image if ffmpeg is missing).
  res = await fetch(`${base}/artwork/album/${album.id}?size=128`, { headers: { cookie: cookie() } })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /image\//)
  res = await fetch(`${base}/artwork/track/${single.id}`, { headers: { cookie: cookie() } })
  assert.equal(res.status, 404, 'no artwork for the untagged single')

  // Sidecar LRC lyrics.
  r = await call('GET', `/tracks/${single.id}/lyrics`)
  assert.equal(r.status, 200)
  assert.equal(r.body.source, 'file')
  assert.equal(r.body.synced, true)
  assert.deepEqual(r.body.lines[1], { timeMs: 2000, text: 'kurban olam' })

  // Favorites + history feed the home page.
  r = await call('PUT', `/favorites/track/${firstTrack.id}`)
  assert.equal(r.body.favorite, true)
  r = await call('POST', '/history', { body: { trackId: firstTrack.id, playedMs: 45_000 } })
  assert.equal(r.body.counted, true)
  r = await call('POST', '/history', { body: { trackId: single.id, playedMs: 300 } })
  assert.equal(r.body.skipped, true)
  r = await call('GET', '/home')
  const shelfIds = r.body.shelves.map((s) => s.id)
  for (const id of ['recently-played', 'recently-added', 'liked', 'all-time-top', 'genres']) assert.ok(shelfIds.includes(id), `home has ${id}`)
  assert.equal(r.body.shelves.find((s) => s.id === 'liked').items[0].id, firstTrack.id)
  assert.equal(r.body.shelves.find((s) => s.id === 'all-time-top').items[0].playCount, 1)

  // Playlists.
  r = await call('POST', '/playlists', { body: { name: 'Yolculuk', trackIds: [firstTrack.id, single.id] } })
  assert.equal(r.status, 201)
  const playlist = r.body
  assert.equal(playlist.tracks.length, 2)
  r = await call('POST', `/playlists/${playlist.id}/move`, { body: { entryId: playlist.tracks[1].entryId, toIndex: 0 } })
  assert.deepEqual(r.body.tracks.map((t) => t.id), [single.id, firstTrack.id])
  r = await call('DELETE', `/playlists/${playlist.id}/tracks/${r.body.tracks[0].entryId}`)
  assert.equal(r.body.tracks.length, 1)
  res = await fetch(`${base}/artwork/playlist/${playlist.id}`, { headers: { cookie: cookie() } })
  assert.equal(res.status, 200)

  // Second, regular user: private data is isolated, admin endpoints are closed.
  r = await call('POST', '/admin/users', { body: { username: 'ayse', password: 'anothersecret' } })
  assert.equal(r.status, 201)
  const ayse = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ayse', password: 'anothersecret', client: 'device', deviceName: 'Pixel' }) }).then((x) => x.json())
  assert.match(ayse.token, /^ghp_/)
  const bearer = { authorization: `Bearer ${ayse.token}` }
  let other = await fetch(`${base}/playlists/${playlist.id}`, { headers: bearer })
  assert.equal(other.status, 404, 'private playlist is hidden from other users')
  other = await fetch(`${base}/home`, { headers: bearer }).then((x) => x.json())
  assert.equal(other.shelves.find((s) => s.id === 'liked'), undefined)
  other = await fetch(`${base}/admin/libraries`, { headers: bearer })
  assert.equal(other.status, 403)

  r = await call('PATCH', `/playlists/${playlist.id}`, { body: { isPublic: true } })
  other = await fetch(`${base}/playlists/${playlist.id}`, { headers: bearer }).then((x) => x.json())
  assert.equal(other.editable, false)
  other = await fetch(`${base}/playlists/${playlist.id}`, { method: 'DELETE', headers: bearer })
  assert.equal(other.status, 403)

  // Logout revokes the session.
  r = await call('POST', '/auth/logout')
  assert.equal(r.status, 200)
  r = await call('GET', '/me')
  assert.equal(r.status, 401)
})

test('pairing, device tokens and revocation', async (t) => {
  const { call, base } = await setupPlayer(t)
  await call('POST', '/setup', { body: { username: 'admin', password: 'supersecret', adminPassword: 'GharmonizeAdmin1' } })
  const baseUrl = base

  let r = await call('POST', '/me/pairing-code')
  assert.match(r.body.code, /^[A-Z2-9]{8}$/)
  const code = r.body.code

  let res = await fetch(`${baseUrl}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'AAAA-BBBB' }) })
  assert.equal(res.status, 401)
  res = await fetch(`${baseUrl}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: `${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`, deviceName: 'Telefon', platform: 'android' }) })
  assert.equal(res.status, 200)
  const paired = await res.json()
  assert.match(paired.token, /^ghp_/)
  res = await fetch(`${baseUrl}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
  assert.equal(res.status, 401, 'pairing codes are single use')

  const bearer = { authorization: `Bearer ${paired.token}` }
  const me = await fetch(`${baseUrl}/me`, { headers: bearer }).then((x) => x.json())
  assert.equal(me.user.username, 'admin')
  assert.ok(me.devices.some((d) => d.name === 'Telefon' && d.platform === 'android'))

  r = await call('DELETE', `/me/devices/${paired.tokenId}`)
  assert.equal(r.body.ok, true)
  res = await fetch(`${baseUrl}/me`, { headers: bearer })
  assert.equal(res.status, 401, 'revoked device is signed out')
})

test('remote access consent gates external clients but never the local network', async (t) => {
  const { currentMode, base: baseUrl } = await setupPlayer(t)
  const from = (ip) => fetch(`${baseUrl}/status`, { headers: { 'x-forwarded-for': ip } })

  assert.equal((await from('192.168.1.50')).status, 200)
  let res = await from('100.88.1.2')
  assert.equal(res.status, 403)
  assert.equal((await res.json()).error.code, 'PLAYER_REMOTE_ACCESS_DISABLED')
  assert.equal((await from('203.0.113.9')).status, 403)

  currentMode.value = 'tailscale'
  assert.equal((await from('100.88.1.2')).status, 200)
  assert.equal((await from('203.0.113.9')).status, 403)

  currentMode.value = 'any'
  assert.equal((await from('203.0.113.9')).status, 200)
  assert.equal((await from('192.168.1.50')).status, 200)
})

test('multiple libraries, disable/remove rules, rescans and offline drives', async (t) => {
  const { call, root, downloads, service } = await setupPlayer(t)
  await call('POST', '/setup', { body: { username: 'admin', password: 'supersecret', adminPassword: 'GharmonizeAdmin1' } })

  let r = await call('GET', '/admin/libraries')
  assert.equal(r.body.items.length, 1)
  const defaultLib = r.body.items[0]
  assert.equal(defaultLib.isDefault, true)
  assert.equal(defaultLib.path, fs.realpathSync(downloads))

  const archive = path.join(root, 'archive')
  writeTrack(path.join(archive, 'Jazz', 'Take Five.mp3'), { title: 'Take Five', artist: 'Dave Brubeck', album: 'Time Out', genre: 'Jazz' })

  r = await call('DELETE', `/admin/libraries/${defaultLib.id}`)
  assert.equal(r.status, 409, 'default library cannot be removed')
  r = await call('POST', '/admin/libraries', { body: { name: 'Arşiv', path: path.join(downloads, 'Sezen Aksu') } })
  assert.equal(r.status, 409, 'nested libraries are rejected')
  r = await call('POST', '/admin/libraries', { body: { name: 'Arşiv', path: archive } })
  assert.equal(r.status, 201)
  const archiveLib = r.body
  await service.context.scanner.requestScan('all')

  r = await call('GET', '/stats')
  assert.equal(r.body.tracks, 5)
  r = await call('GET', '/genres')
  assert.deepEqual(r.body.items.map((g) => g.name).sort(), ['Jazz', 'Pop'])

  // Disabling hides content without deleting it.
  r = await call('PATCH', `/admin/libraries/${archiveLib.id}`, { body: { enabled: false } })
  assert.equal(r.body.enabled, false)
  r = await call('GET', '/stats')
  assert.equal(r.body.tracks, 4)
  r = await call('GET', '/search?q=take five')
  assert.equal(r.body.tracks.length, 0)
  r = await call('PATCH', `/admin/libraries/${archiveLib.id}`, { body: { enabled: true } })
  await service.context.scanner.requestScan('all')
  r = await call('GET', '/stats')
  assert.equal(r.body.tracks, 5)

  // A deleted file disappears; a modified one is re-read.
  fs.rmSync(path.join(downloads, 'Sezen Aksu', 'Gülümse', '02 - Gülümse.mp3'))
  writeTrack(path.join(downloads, 'Single', 'Barış Manço - Dağlar Dağlar.mp3'), { title: 'Dağlar Dağlar', artist: 'Barış Manço', album: '2023', genre: 'Anadolu Rock' })
  const touched = new Date(Date.now() - 30_000)
  fs.utimesSync(path.join(downloads, 'Single', 'Barış Manço - Dağlar Dağlar.mp3'), touched, touched)
  await service.context.scanner.requestScan('all')
  r = await call('GET', '/stats')
  assert.equal(r.body.tracks, 4)
  assert.equal(r.body.albums, 3)
  const status = service.context.scanner.getStatus()
  assert.equal(status.removed, 1)
  assert.equal(status.updated, 1)

  // Files that are still being written (fresh mtime) are skipped for now.
  writeTrack(path.join(downloads, 'fresh.mp3'), { title: 'Fresh', artist: 'Someone' })
  const now = new Date()
  fs.utimesSync(path.join(downloads, 'fresh.mp3'), now, now)
  await service.context.scanner.requestScan('all')
  r = await call('GET', '/search?q=fresh')
  assert.equal(r.body.tracks.length, 0)
  age(path.join(downloads, 'fresh.mp3'))
  await service.context.scanner.requestScan('all')
  r = await call('GET', '/search?q=fresh')
  assert.equal(r.body.tracks.length, 1)

  // An unplugged drive keeps its index (no mass deletion).
  fs.renameSync(archive, `${archive}-unplugged`)
  await service.context.scanner.requestScan('all')
  r = await call('GET', '/admin/libraries')
  assert.equal(r.body.items.find((l) => l.id === archiveLib.id).lastScanStatus, 'offline')
  r = await call('GET', '/stats')
  assert.equal(r.body.tracks, 5)

  // Removing a library deletes its index.
  r = await call('DELETE', `/admin/libraries/${archiveLib.id}`)
  assert.equal(r.status, 200)
  r = await call('GET', '/stats')
  assert.equal(r.body.tracks, 4)
})

test('the Gharmonize admin session alone can manage but not listen', async (t) => {
  const { call } = await setupPlayer(t)
  let r = await call('GET', '/admin/libraries', { headers: { 'x-test-gharmonize-admin': 'yes' }, auth: 'none' })
  assert.equal(r.status, 200)
  r = await call('PATCH', '/admin/config', { headers: { 'x-test-gharmonize-admin': 'yes' }, auth: 'none', body: { scanIntervalMinutes: 0, serverName: 'Ev Sunucusu' } })
  assert.equal(r.body.config.scanIntervalMinutes, 0)
  r = await call('GET', '/status', { auth: 'none' })
  assert.equal(r.body.name, 'Ev Sunucusu')
  r = await call('GET', '/home', { headers: { 'x-test-gharmonize-admin': 'yes' }, auth: 'none' })
  assert.equal(r.status, 401)
  r = await call('POST', '/setup', { headers: { 'x-test-gharmonize-admin': 'yes' }, auth: 'none', body: { username: 'first', password: 'supersecret' } })
  assert.equal(r.status, 201, 'a signed-in Gharmonize admin can create the first account')
})

test('transcoding streams live, then serves seeks from cache', { skip: !HAS_FFMPEG && 'ffmpeg not available' }, async (t) => {
  const { call, downloads, service, jar, base } = await setupPlayer(t)
  const flac = path.join(downloads, 'Tone', 'tone.flac')
  fs.mkdirSync(path.dirname(flac), { recursive: true })
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-metadata', 'title=Tone', '-metadata', 'artist=Test', '-y', flac])
  assert.equal(made.status, 0)
  age(flac)
  await service.context.scanner.requestScan('all')
  await call('POST', '/setup', { body: { username: 'admin', password: 'supersecret', adminPassword: 'GharmonizeAdmin1' } })
  const baseUrl = base
  const r = await call('GET', '/search?q=tone')
  const track = r.body.tracks[0]
  assert.equal(track.lossless, true)
  assert.equal(track.codec, 'FLAC')

  let res = await fetch(`${baseUrl}/stream/${track.id}?quality=normal`, { headers: { cookie: jar.cookie } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-gharmonize-transcode'), 'live')
  assert.equal(res.headers.get('content-type'), 'audio/ogg')
  const live = Buffer.from(await res.arrayBuffer())
  assert.equal(live.subarray(0, 4).toString(), 'OggS')

  // Wait for the job to finish and land in the cache.
  for (let i = 0; i < 50 && service.context.stream.activeJobs(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100))
  res = await fetch(`${baseUrl}/stream/${track.id}?quality=normal`, { headers: { cookie: jar.cookie, range: 'bytes=100-199' } })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('x-gharmonize-transcode'), 'cached')
  const part = Buffer.from(await res.arrayBuffer())
  assert.deepEqual(part, live.subarray(100, 200))

  // A seek on a cold cache waits for the transcode instead of failing.
  await service.context.stream.clearCache()
  res = await fetch(`${baseUrl}/stream/${track.id}?format=mp3&bitrate=192`, { headers: { cookie: jar.cookie, range: 'bytes=500-' } })
  assert.equal(res.status, 206)
  assert.match(res.headers.get('content-range'), /^bytes 500-\d+\/\d+$/)
  await res.arrayBuffer()
})

test('per-user library access and download rights', async (t) => {
  const { call, root, service, base } = await setupPlayer(t)
  await call('POST', '/setup', { body: { username: 'admin', password: 'supersecret', adminPassword: 'GharmonizeAdmin1' } })
  const archive = path.join(root, 'archive')
  writeTrack(path.join(archive, 'Private', 'Secret Song.mp3'), { title: 'Secret Song', artist: 'Hidden Artist', album: 'Vault', genre: 'Jazz' }, { cover: true })
  fs.writeFileSync(path.join(archive, 'Private', 'Secret Song.lrc'), '[00:01.00]sshh')
  const lib = (await call('POST', '/admin/libraries', { body: { name: 'Arşiv', path: archive } })).body
  await service.context.scanner.requestScan('all')
  const adminStats = (await call('GET', '/stats')).body
  assert.equal(adminStats.tracks, 5, 'admins see every library')
  const secret = (await call('GET', '/search?q=secret')).body.tracks[0]
  assert.ok(secret)

  // Admin puts the secret track into a PUBLIC playlist.
  const pl = (await call('POST', '/playlists', { body: { name: 'Karışık', isPublic: true, trackIds: [secret.id] } })).body
  const defaultTrack = (await call('GET', '/search?q=hadi')).body.tracks[0]
  await call('POST', `/playlists/${pl.id}/tracks`, { body: { trackIds: [defaultTrack.id] } })

  // New user: download library only, no download right.
  let r = await call('POST', '/admin/users', { body: { username: 'misafir', password: 'guestsecret' } })
  assert.equal(r.status, 201)
  const guest = r.body
  assert.equal(guest.canDownload, false)
  assert.equal(guest.allLibraries, false)
  const defaultLib = (await call('GET', '/admin/libraries')).body.items.find((l) => l.isDefault)
  assert.deepEqual(guest.libraryIds, [defaultLib.id])

  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'misafir', password: 'guestsecret', client: 'device' }) }).then((x) => x.json())
  const as = (url, init = {}) => fetch(`${base}${url}`, { ...init, headers: { authorization: `Bearer ${login.token}`, 'content-type': 'application/json', ...(init.headers || {}) } })
  const json = async (url, init) => (await as(url, init)).json()

  const hiddenChecks = async () => {
    assert.equal((await json('/stats')).tracks, 4)
    assert.equal((await json('/search?q=secret')).tracks.length, 0)
    assert.equal((await json('/search?q=hidden')).artists.length, 0)
    assert.equal((await as(`/tracks/${secret.id}`)).status, 404)
    assert.equal((await as(`/stream/${secret.id}`)).status, 404)
    assert.equal((await as(`/tracks/${secret.id}/lyrics`)).status, 404)
    assert.equal((await as(`/artwork/track/${secret.id}`)).status, 404)
    assert.equal((await as(`/albums/${secret.albumId}`)).status, 404)
    assert.equal((await as(`/artists/${secret.artistId}`)).status, 404)
    assert.ok(!(await json('/genres')).items.some((g) => g.name === 'Jazz'))
    assert.deepEqual((await json('/tracks/batch', { method: 'POST', body: JSON.stringify({ ids: [secret.id, defaultTrack.id] }) })).items.map((x) => x.id), [defaultTrack.id])
    const shared = await json(`/playlists/${pl.id}`)
    assert.deepEqual(shared.tracks.map((x) => x.id), [defaultTrack.id], 'public playlist hides tracks from libraries you cannot see')
    assert.equal(shared.trackCount, 1)
    assert.equal((await as('/history', { method: 'POST', body: JSON.stringify({ trackId: secret.id, playedMs: 60000 }) })).status, 404)
  }
  await hiddenChecks()

  let me = await json('/me')
  assert.equal(me.permissions.canDownload, false)
  assert.deepEqual(me.permissions.libraries.map((l) => l.id), [defaultLib.id])

  // Grant the archive → visible.
  r = await call('PATCH', `/admin/users/${guest.id}`, { body: { libraryAccess: [defaultLib.id, lib.id] } })
  assert.deepEqual(r.body.libraryIds, [defaultLib.id, lib.id])
  assert.equal((await json('/stats')).tracks, 5)
  assert.equal((await as(`/stream/${secret.id}`, { headers: { range: 'bytes=0-9' } })).status, 206)
  assert.equal((await as(`/artwork/track/${secret.id}`)).status, 200)

  // Revoke again.
  await call('PATCH', `/admin/users/${guest.id}`, { body: { libraryAccess: [defaultLib.id] } })
  await hiddenChecks()

  // Download right always includes the download library, even if not listed.
  r = await call('PATCH', `/admin/users/${guest.id}`, { body: { canDownload: true, libraryAccess: [lib.id] } })
  assert.equal(r.body.canDownload, true)
  assert.deepEqual(r.body.libraryIds.sort(), [defaultLib.id, lib.id].sort())
  me = await json('/me')
  assert.equal(me.permissions.canDownload, true)

  // "All libraries" also covers libraries added later.
  r = await call('PATCH', `/admin/users/${guest.id}`, { body: { libraryAccess: 'all' } })
  assert.equal(r.body.allLibraries, true)
  assert.equal(r.body.libraryIds, null)
  const later = path.join(root, 'later')
  writeTrack(path.join(later, 'Late.mp3'), { title: 'Late Arrival', artist: 'Someone' })
  await call('POST', '/admin/libraries', { body: { name: 'Sonra', path: later } })
  await service.context.scanner.requestScan('all')
  assert.equal((await json('/search?q=late arrival')).tracks.length, 1)

  // Validation.
  r = await call('PATCH', `/admin/users/${guest.id}`, { body: { libraryAccess: [9999] } })
  assert.equal(r.status, 404)
  assert.equal(r.body.error.code, 'LIBRARY_NOT_FOUND')
  r = await call('POST', '/admin/users', { body: { username: 'x3', password: 'whatever1', libraryAccess: 'some' } })
  assert.equal(r.status, 400)
  // Non-admins cannot change permissions.
  assert.equal((await as(`/admin/users/${guest.id}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) })).status, 403)
})

test('pickAlternativeVideo finds a public copy of an unavailable YouTube song', async () => {
  const { pickAlternativeVideo, youTubeVideoId } = await import('../modules/player/coreAdapter.js')
  const entries = [
    { id: 'ZYlr1gd1LnE', title: 'git', channel: 'Blok3 - Topic', duration: 159 },
    { id: 'Z-jgvaZVKyw', title: 'Blok3 - GİT (Maximum Uniq Açıkhava) (13.09.2025) (8)', channel: 'Fatih Taş', duration: 159 },
    { id: 'L0jNjNe1Vq4', title: 'BLOK3 - GİT (Sözleri/Lyrics)', channel: 'BUR4K MUSIC', duration: 159 },
    { id: 'JWLWczFtCag', title: 'BLOK3 - GİT (Official Music Video)', channel: 'Blok3', duration: 159 },
    { id: 'cover123456', title: 'Blok3 - Git (Cover)', channel: 'Blok3', duration: 160 },
    { id: 'longer12345', title: 'Blok3 - Git', channel: 'Blok3', duration: 240 }
  ]
  const want = { title: 'git', artist: 'Blok3', duration: 159, excludeId: youTubeVideoId('https://music.youtube.com/watch?v=ZYlr1gd1LnE') }
  assert.equal(pickAlternativeVideo(entries, want).id, 'JWLWczFtCag')
  // Other songs, other artists, covers and different lengths never qualify.
  assert.equal(pickAlternativeVideo(entries.slice(4), want), null)
  assert.equal(pickAlternativeVideo(entries, { ...want, artist: 'Someone Else' }), null)
  assert.equal(youTubeVideoId('https://youtu.be/JWLWczFtCag'), 'JWLWczFtCag')
  assert.equal(youTubeVideoId('not a url'), null)
})

test('pairingStatus tells only the owner whether a pairing code was used', async () => {
  const { openPlayerDatabase } = await import('../modules/player/db.js')
  const { createAuthStore } = await import('../modules/player/auth.js')
  let clock = 1_800_000_000_000
  const db = await openPlayerDatabase(null, { fileName: ':memory:' })
  const auth = createAuthStore(db, { now: () => clock })
  const owner = auth.createUser({ username: 'owner', displayName: 'Owner', password: 'Password123', role: 'admin' })
  const other = auth.createUser({ username: 'other', displayName: 'Other', password: 'Password123' })
  const { code } = auth.createPairingCode(owner.id)
  assert.deepEqual(auth.pairingStatus(code, owner.id), { used: false, expired: false })
  assert.equal(auth.pairingStatus(code, other.id), null, 'other users learn nothing')
  assert.equal(auth.pairingStatus('bad', owner.id), null)
  auth.redeemPairingCode(code, { name: 'Phone' })
  assert.deepEqual(auth.pairingStatus(`${code.slice(0, 4)}-${code.slice(4)}`, owner.id), { used: true, expired: false })
  const second = auth.createPairingCode(owner.id)
  clock += 11 * 60 * 1000
  assert.deepEqual(auth.pairingStatus(second.code, owner.id), { used: false, expired: true })
  db.close()
})
