import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import express from 'express'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import { writeTrack, age, tmpDir, silentLogger } from './fixtures/playerAudio.mjs'
import { startPlayerService } from '../modules/player/service.js'
import { createPlayerRouter } from '../modules/player/router.js'

// A distinct, valid 2x2 PNG per colour, so covers can be told apart by hash.
function solidPng([r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.from([0, r, g, b, r, g, b])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))
  ])
}

const RED = solidPng([220, 20, 20])
const BLUE = solidPng([20, 20, 220])
const GREEN = solidPng([20, 200, 20])
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

async function writeSong(file, tags, cover = null, { ageMs = 60_000 } = {}) {
  await writeTrack(file, tags, { cover: cover || false, fresh: true })
  age(file, ageMs)
  return file
}

async function startInstance(t, populate) {
  const root = tmpDir('art')
  const library = path.join(root, 'outputs')
  fs.mkdirSync(library, { recursive: true })
  await populate(library)
  const service = await startPlayerService({
    env: {},
    logger: silentLogger,
    dataDir: path.join(root, 'data'),
    cacheDir: path.join(root, 'cache'),
    defaultLibraryDir: library,
    initialScanDelayMs: -1
  })
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
  t.after(async () => {
    server.close()
    await service.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  let cookie = ''
  const call = async (method, url, body) => {
    const headers = { cookie }
    if (body) headers['content-type'] = 'application/json'
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined })
    const set = res.headers.get('set-cookie')?.match(/gharmonize_player_session=([^;]*)/)
    if (set) cookie = `gharmonize_player_session=${set[1]}`
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const r = await call('POST', '/setup', { username: 'owner', password: 'supersecret', adminPassword: 'GharmonizeAdmin1' })
  assert.equal(r.status, 201)
  const art = (ref, size = 64) => fetch(`${base}/artwork/${ref}?size=${size}`, { headers: { cookie } })
  const get = (url, headers = {}) => fetch(base + url, { headers: { cookie, ...headers } })
  // A browser-style conditional GET (fetch() would add Cache-Control: no-cache
  // to a manual If-None-Match, which makes every server answer in full).
  const revalidate = (url, etag) => new Promise((resolve, reject) => {
    http.get(base + url, { headers: { cookie, 'if-none-match': etag } }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode, etag: res.headers.etag }))
    }).on('error', reject)
  })
  return { service, call, art, get, revalidate, library, base }
}

async function tracksByTitle(call) {
  const r = await call('GET', '/tracks?sort=alpha&limit=100')
  return Object.fromEntries(r.body.items.map((tr) => [tr.title, tr]))
}

// The cover the server picked, identified by the hash of the embedded image.
async function pickedCover(service, kind, id) {
  const result = await service.context.artwork.getArtwork(kind, id, 64, 1)
  return result?.sourceKey || null
}

test('songs sharing album metadata but carrying different covers each show their own cover', async (t) => {
  const { service, call, art } = await startInstance(t, async (lib) => {
    // Same album title + album artist → one album row, different embedded covers.
    await writeSong(path.join(lib, 'Mix', '01 - Kırmızı.mp3'), { title: 'Kırmızı', artist: 'Ortak Sanatçı', album: 'Ortak Albüm', trackNumber: '1' }, RED)
    await writeSong(path.join(lib, 'Mix', '02 - Mavi.mp3'), { title: 'Mavi', artist: 'Ortak Sanatçı', album: 'Ortak Albüm', trackNumber: '2' }, BLUE)
    // No embedded cover: falls back to the album's cover.
    await writeSong(path.join(lib, 'Mix', '03 - Kapaksız.mp3'), { title: 'Kapaksız', artist: 'Ortak Sanatçı', album: 'Ortak Albüm', trackNumber: '3' })
    // Another artist/album without any cover must not borrow one.
    await writeSong(path.join(lib, 'Başka', 'Yalnız.mp3'), { title: 'Yalnız', artist: 'Başka Sanatçı', album: 'Başka Albüm' })
  })

  const albums = (await call('GET', '/albums')).body.items
  const shared = albums.find((a) => a.title === 'Ortak Albüm')
  assert.equal(shared.trackCount, 3, 'the shared metadata really merges into one album')

  const tracks = await tracksByTitle(call)
  const red = tracks['Kırmızı']
  const blue = tracks['Mavi']
  assert.notEqual(red.artwork, blue.artwork, 'two songs with different covers must not share one artwork URL')
  assert.match(red.artwork, /^track\/\d+\//, 'songs point at their own (versioned) artwork')

  assert.equal(await pickedCover(service, 'track', red.id), sha1(RED))
  assert.equal(await pickedCover(service, 'track', blue.id), sha1(BLUE))
  assert.equal(await pickedCover(service, 'track', tracks['Kapaksız'].id), sha1(RED), 'cover-less song falls back to its album cover')
  assert.equal(await pickedCover(service, 'album', shared.id), sha1(RED), 'album cover = first track')
  assert.equal((await art(tracks['Yalnız'].artwork)).status, 404, 'no cover is borrowed from another album or artist')

  for (const tr of [red, blue]) {
    const res = await art(tr.artwork)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /^image\//)
    await res.arrayBuffer()
  }
})

test('folder image is used when a song has no embedded cover and is revalidated, not pinned', async (t) => {
  const { service, call, art } = await startInstance(t, async (lib) => {
    await writeSong(path.join(lib, 'Klasör', 'Şarkı.mp3'), { title: 'Şarkı', artist: 'Klasörcü', album: 'Klasör Albümü' })
    fs.writeFileSync(path.join(lib, 'Klasör', 'cover.png'), GREEN)
  })
  const tracks = await tracksByTitle(call)
  const result = await service.context.artwork.getArtwork('track', tracks['Şarkı'].id, 64, 1)
  assert.ok(result, 'folder cover found')
  assert.equal(result.stable, false, 'a folder image can change without the song changing')
  const res = await art(tracks['Şarkı'].artwork)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('cache-control'), /no-cache/)
  await res.arrayBuffer()
})

test('artwork URLs differ between installs and change when the cover changes', async (t) => {
  // Two separate installs (e.g. Docker and the desktop package) on the same
  // address: both number their first album 1, but the albums differ.
  const docker = await startInstance(t, async (lib) => {
    await writeSong(path.join(lib, 'Gülşen - Bangır Bangır.mp3'), { title: 'Bangır Bangır', artist: 'Gülşen', album: 'Bangır Bangır' }, RED)
  })
  const desktop = await startInstance(t, async (lib) => {
    await writeSong(path.join(lib, '3 Hürel - Sana Değmez.mp3'), { title: 'Sana Değmez', artist: '3 Hürel', album: 'Efsane Yeniden' }, BLUE)
  })
  const dockerAlbum = (await docker.call('GET', '/albums')).body.items[0]
  const desktopAlbum = (await desktop.call('GET', '/albums')).body.items[0]
  assert.equal(dockerAlbum.id, desktopAlbum.id, 'precondition: same numeric album id in both databases')
  assert.notEqual(dockerAlbum.artwork, desktopAlbum.artwork, 'a browser cache shared by both installs must not mix their covers')
  const dockerTrack = Object.values(await tracksByTitle(docker.call))[0]
  const desktopTrack = Object.values(await tracksByTitle(desktop.call))[0]
  assert.notEqual(dockerTrack.artwork, desktopTrack.artwork)

  // Versioned URLs may be cached for long; bare (legacy) URLs must revalidate.
  let res = await docker.art(dockerTrack.artwork)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('cache-control'), /immutable/)
  await res.arrayBuffer()
  res = await docker.art(`track/${dockerTrack.id}`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('cache-control'), /no-cache/)
  assert.doesNotMatch(res.headers.get('cache-control'), /max-age=604800/)
  await res.arrayBuffer()

  // Re-tagging the file with a new cover changes the URL after a rescan.
  const file = path.join(docker.library, 'Gülşen - Bangır Bangır.mp3')
  await writeSong(file, { title: 'Bangır Bangır', artist: 'Gülşen', album: 'Bangır Bangır' }, GREEN, { ageMs: 30_000 })
  await docker.service.context.scanner.requestScan('all')
  const retagged = Object.values(await tracksByTitle(docker.call))[0]
  assert.equal(retagged.id, dockerTrack.id)
  assert.notEqual(retagged.artwork, dockerTrack.artwork, 'new cover → new URL')
  const retaggedAlbum = (await docker.call('GET', '/albums')).body.items[0]
  assert.notEqual(retaggedAlbum.artwork, dockerAlbum.artwork)
  assert.equal(await pickedCover(docker.service, 'track', retagged.id), sha1(GREEN))
})

test('a deleted song\'s id is never given to a new song, so its artwork URL cannot be inherited', async (t) => {
  const inst = await startInstance(t, async (lib) => {
    await writeSong(path.join(lib, 'A - Eski.mp3'), { title: 'Eski', artist: 'A', album: 'Eski Albüm' }, RED)
  })
  const before = Object.values(await tracksByTitle(inst.call))[0]
  fs.rmSync(path.join(inst.library, 'A - Eski.mp3'))
  await inst.service.context.scanner.requestScan('all')
  await writeSong(path.join(inst.library, 'B - Yeni.mp3'), { title: 'Yeni', artist: 'B', album: 'Yeni Albüm' }, BLUE)
  await inst.service.context.scanner.requestScan('all')
  const after = Object.values(await tracksByTitle(inst.call))[0]
  assert.equal(after.title, 'Yeni')
  assert.ok(after.id > before.id, 'the freed id stays retired')
  assert.equal((await inst.call('GET', `/tracks/${before.id}`)).status, 404, 'the old id points to nothing')
  assert.notEqual(after.artwork, before.artwork)
  assert.equal(await pickedCover(inst.service, 'track', after.id), sha1(BLUE))
})

test('every artwork ref in API answers is versioned (mixes, stats, playlists, artists)', async (t) => {
  const { call } = await startInstance(t, async (lib) => {
    await writeSong(path.join(lib, 'X', '01.mp3'), { title: 'Bir', artist: 'X', album: 'XA', trackNumber: '1' }, RED)
    await writeSong(path.join(lib, 'X', '02.mp3'), { title: 'İki', artist: 'X', album: 'XA', trackNumber: '2' }, BLUE)
  })
  const tracks = await tracksByTitle(call)
  const pl = await call('POST', '/playlists', { name: 'Liste' })
  assert.ok(pl.status < 300)
  await call('POST', `/playlists/${pl.body.id ?? pl.body.playlist?.id}/tracks`, { trackIds: [tracks['Bir'].id] })
  const refs = []
  const walk = (v, key) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
    else if (typeof v === 'string' && (key === 'artwork' || key === 'covers') && /^(track|album|artist|playlist)\//.test(v)) refs.push(v)
  }
  for (const url of ['/home', '/playlists', '/artists', '/albums', '/tracks', `/tracks/${tracks['Bir'].id}`]) walk((await call('GET', url)).body)
  assert.ok(refs.length >= 5, `collected ${refs.length} refs`)
  for (const ref of refs) assert.match(ref, /^(track|album|artist|playlist)\/\d+\/[0-9a-f]{16}$/, ref)
})

test('waveforms are revalidated by file identity, never cached by track id', { skip: !HAS_FFMPEG && 'ffmpeg not available' }, async (t) => {
  const docker = await startInstance(t, async (lib) => {
    await writeSong(path.join(lib, 'Gülşen - Bangır Bangır.mp3'), { title: 'Bangır Bangır', artist: 'Gülşen', album: 'Bangır Bangır' })
  })
  const desktop = await startInstance(t, async (lib) => {
    await writeSong(path.join(lib, '3 Hürel - Sana Değmez.mp3'), { title: 'Sana Değmez', artist: '3 Hürel', album: 'Efsane Yeniden' })
  })
  const dockerTrack = Object.values(await tracksByTitle(docker.call))[0]
  const desktopTrack = Object.values(await tracksByTitle(desktop.call))[0]
  assert.equal(dockerTrack.id, desktopTrack.id, 'precondition: same track id in both installs')

  let res = await docker.get(`/waveform/${dockerTrack.id}`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).bins.length, 240)
  const dockerTag = res.headers.get('etag')
  assert.match(res.headers.get('cache-control'), /no-cache/)
  assert.doesNotMatch(res.headers.get('cache-control'), /max-age=2592000/)
  res = await desktop.get(`/waveform/${desktopTrack.id}`)
  await res.arrayBuffer()
  assert.notEqual(res.headers.get('etag'), dockerTag, 'same URL on the same address, different songs → different ETag')

  // The browser revalidates: unchanged file → 304, the other install's tag → full answer.
  assert.equal((await docker.revalidate(`/waveform/${dockerTrack.id}`, dockerTag)).status, 304)
  assert.equal((await desktop.revalidate(`/waveform/${desktopTrack.id}`, dockerTag)).status, 200)

  // A song added after a deletion gets a new id and a new ETag.
  fs.rmSync(path.join(docker.library, 'Gülşen - Bangır Bangır.mp3'))
  await docker.service.context.scanner.requestScan('all')
  await writeSong(path.join(docker.library, 'Candan Erçetin - Gamsız Hayat.mp3'), { title: 'Gamsız Hayat', artist: 'Candan Erçetin', album: 'Neden' })
  await docker.service.context.scanner.requestScan('all')
  const added = Object.values(await tracksByTitle(docker.call))[0]
  assert.ok(added.id > dockerTrack.id, 'the freed id stays retired')
  assert.equal((await docker.revalidate(`/waveform/${dockerTrack.id}`, dockerTag)).status, 404, 'the old id has no waveform')
  const after = await docker.revalidate(`/waveform/${added.id}`, dockerTag)
  assert.equal(after.status, 200)
  assert.notEqual(after.etag, dockerTag)
})

test('an empty cover left in the cache by a crash is made again, not served', { skip: !HAS_FFMPEG && 'ffmpeg not available' }, async (t) => {
  const { service, call, art, library } = await startInstance(t, async (lib) => {
    await writeSong(path.join(lib, 'Single', 'Kapaklı.mp3'), { title: 'Kapaklı', artist: 'Sanatçı A, Sanatçı B', album: 'Tekli' }, RED)
  })
  const track = (await tracksByTitle(call))['Kapaklı']
  let res = await art(track.artwork, 256)
  assert.equal(res.status, 200)
  assert.ok(Buffer.from(await res.arrayBuffer()).length > 0)

  // A power cut after the rename, before the bytes reached the disk: every
  // cached copy (original and resized) is now an empty file.
  const cacheDir = path.join(path.dirname(library), 'cache')
  const cached = []
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else cached.push(p) } }
  walk(path.join(cacheDir, 'artwork'))
  assert.ok(cached.length >= 2, cached.join('\n'))
  for (const f of cached) fs.truncateSync(f, 0)

  // A fresh process (nothing remembered in memory) reads the cache again.
  const { createArtworkService } = await import('../modules/player/artwork.js')
  const fresh = createArtworkService({ cacheDir, db: service.context.db, libraries: service.context.libraries, logger: silentLogger })
  const result = await fresh.getArtwork('track', track.id, 256, 1)
  assert.ok(result, 'still has a cover')
  assert.ok(fs.statSync(result.file).size > 0, 'not the empty file')
  // The running server heals too.
  service.context.artwork.invalidate()
  res = await art(track.artwork, 128)
  assert.equal(res.status, 200)
  assert.ok(Buffer.from(await res.arrayBuffer()).length > 0)
})
