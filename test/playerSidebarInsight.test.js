import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { writeTrack, tmpDir, silentLogger } from './fixtures/playerAudio.mjs'
import { startPlayerService } from '../modules/player/service.js'

async function start(t) {
  const root = tmpDir('sidebar')
  const library = path.join(root, 'outputs')
  fs.mkdirSync(library, { recursive: true })
  await writeTrack(path.join(library, 'a1.mp3'), { title: 'Bir', artist: 'Sanatçı', album: 'Eski', year: '2015', genre: 'Rock' })
  await writeTrack(path.join(library, 'a2.mp3'), { title: 'İki', artist: 'Sanatçı', album: 'Yeni', year: '2023', genre: 'Rock' })
  await writeTrack(path.join(library, 'a3.mp3'), { title: 'Üç', artist: 'Sanatçı', album: 'Yeni', year: '2023', genre: 'Pop' })
  await writeTrack(path.join(library, 'b1.mp3'), { title: 'Başka', artist: 'Diğer', album: 'Diğer Albüm' })
  const service = await startPlayerService({ env: {}, logger: silentLogger, dataDir: path.join(root, 'data'), cacheDir: path.join(root, 'cache'), defaultLibraryDir: library, initialScanDelayMs: -1 })
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  await service.context.scanner.requestScan('all')
  const db = service.context.db
  for (const id of [1, 2]) db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES (?, 'u${id}', 'U', 'x', 'admin', 0, 0)`).run(id)
  const track = (title) => db.prepare('SELECT id, album_id, artist_id FROM tracks WHERE title = ?').get(title)
  return { db, catalog: service.context.catalog, track }
}

test('sidebar library lists follows and saved albums newest first, with the liked count', async (t) => {
  const { db, catalog, track } = await start(t)
  const fav = db.prepare('INSERT INTO favorites (user_id, item_type, item_id, created_at) VALUES (?, ?, ?, ?)')
  fav.run(1, 'artist', track('Bir').artist_id, 10)
  fav.run(1, 'artist', track('Başka').artist_id, 20)
  fav.run(1, 'album', track('Bir').album_id, 30)
  fav.run(1, 'album', track('İki').album_id, 5)
  fav.run(1, 'track', track('Bir').id, 1)
  fav.run(1, 'track', track('Üç').id, 2)
  fav.run(2, 'track', track('Başka').id, 1)

  const saved = catalog.savedItems(1)
  assert.equal(saved.likedCount, 2)
  assert.deepEqual(saved.artists.map((a) => a.name), ['Diğer', 'Sanatçı'])
  assert.equal(saved.artists[1].trackCount, 3)
  assert.deepEqual(saved.albums.map((a) => a.title), ['Eski', 'Yeni'])
  assert.deepEqual(catalog.savedItems(2), { likedCount: 1, artists: [], albums: [] })
})

test('insight is the user\'s own listening of an artist, album or song', async (t) => {
  const { catalog, track } = await start(t)
  const artistId = track('Bir').artist_id
  assert.deepEqual(catalog.insight('artist', artistId, 1).plays, 0)
  assert.equal(catalog.insight('artist', artistId, 1).topTrack, undefined)

  for (let i = 0; i < 3; i++) catalog.recordPlay(1, { trackId: track('Üç').id, completed: true })
  catalog.recordPlay(1, { trackId: track('Bir').id, completed: true })
  catalog.recordPlay(2, { trackId: track('Bir').id, completed: true })

  const artist = catalog.insight('artist', artistId, 1)
  assert.equal(artist.plays, 4)
  assert.ok(artist.lastPlayedAt > 0)
  assert.equal(artist.topTrack.title, 'Üç')
  assert.deepEqual(artist.genres, ['Rock', 'Pop'])
  assert.equal(artist.latestAlbum.title, 'Yeni')

  const album = catalog.insight('album', track('Üç').album_id, 1)
  assert.equal(album.plays, 3)
  assert.equal(album.topTrack.title, 'Üç')
  assert.equal(album.genres, undefined)

  assert.equal(catalog.insight('track', track('Bir').id, 1).plays, 1)
  assert.equal(catalog.insight('track', track('Bir').id, 2).plays, 1, 'per user')
  assert.throws(() => catalog.insight('genre', 1, 1), /Invalid kind/)
})
