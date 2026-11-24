import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { writeTrack, tmpDir, silentLogger } from './fixtures/playerAudio.mjs'
import { startPlayerService } from '../modules/player/service.js'
import { artistCreditNames } from '../modules/player/songKey.js'
import { createArtistCredits } from '../modules/player/artistCredits.js'

test('credits split only where a name never has the separator', () => {
  assert.deepEqual(artistCreditNames('Oguz Aksaç, Atakan Dalkılıç'), ['Oguz Aksaç', 'Atakan Dalkılıç'])
  assert.deepEqual(artistCreditNames('Tarkan feat. Sezen Aksu'), ['Tarkan', 'Sezen Aksu'])
  assert.deepEqual(artistCreditNames('Ezhel x Ufo361'), ['Ezhel', 'Ufo361'])
  assert.deepEqual(artistCreditNames('A, B & C'), ['A', 'B', 'C'])
  for (const band of ['Mor ve Ötesi', 'Simon & Garfunkel', 'AC/DC', 'Malcolm X', 'Mazhar Ve Fuat']) assert.deepEqual(artistCreditNames(band), [band])
  const known = new Set(['dedublüman', 'cem adrian'])
  const isKnown = (n) => known.has(n.toLocaleLowerCase('tr'))
  assert.deepEqual(artistCreditNames('Dedublüman & Cem Adrian', { isKnown }), ['Dedublüman', 'Cem Adrian'], 'both are artists of their own')
  assert.deepEqual(artistCreditNames('Oya & Bora', { isKnown }), ['Oya & Bora'])
})

async function start(t, populate) {
  const root = tmpDir('credits')
  const library = path.join(root, 'outputs')
  fs.mkdirSync(library, { recursive: true })
  await populate(library)
  const service = await startPlayerService({ env: {}, logger: silentLogger, dataDir: path.join(root, 'data'), cacheDir: path.join(root, 'cache'), defaultLibraryDir: library, initialScanDelayMs: -1 })
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  await service.context.scanner.requestScan('all')
  service.context.db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES (1, 'admin', 'Admin', 'x', 'admin', 0, 0)").run()
  return { service, db: service.context.db, catalog: service.context.catalog, library }
}

const artistByName = (db, name) => db.prepare('SELECT id, name FROM artists WHERE name = ?').get(name)

test('a duet is listed under each of its artists, the credit stays as written', async (t) => {
  const { db, catalog } = await start(t, async (lib) => {
    await writeTrack(path.join(lib, 'Duet.mp3'), { title: 'Şu Yalan Dünyaya', artist: 'Oguz Aksaç, Atakan Dalkılıç', album: 'Şu Yalan Dünyaya - Single', albumartist: 'Oguz Aksaç, Atakan Dalkılıç' })
    await writeTrack(path.join(lib, 'Solo.mp3'), { title: 'Tek', artist: 'Atakan Dalkılıç', album: 'Tek Albüm' })
    await writeTrack(path.join(lib, 'Band.mp3'), { title: 'Bir Derdim Var', artist: 'Mor ve Ötesi', album: 'Dünya Yalan Söylüyor' })
  })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM artists WHERE name LIKE '%,%'").get().n, 0, 'no combined "A, B" artist')
  const oguz = artistByName(db, 'Oguz Aksaç')
  const atakan = artistByName(db, 'Atakan Dalkılıç')
  assert.ok(oguz && atakan && artistByName(db, 'Mor ve Ötesi'))

  const duet = catalog.search('yalan', { userId: 1 }).tracks.find((tr) => tr.title === 'Şu Yalan Dünyaya')
  assert.equal(duet.artist, 'Oguz Aksaç, Atakan Dalkılıç', 'shown as written')
  assert.equal(duet.artistId, oguz.id)
  assert.deepEqual(duet.artists, [{ id: oguz.id, name: 'Oguz Aksaç' }, { id: atakan.id, name: 'Atakan Dalkılıç' }])
  const album = catalog.getAlbum(duet.albumId, 1)
  assert.equal(album.artist, 'Oguz Aksaç, Atakan Dalkılıç')
  assert.deepEqual(album.artists.map((a) => a.name), ['Oguz Aksaç', 'Atakan Dalkılıç'])

  // The second artist's page has their own song and the duet.
  const page = catalog.getArtist(atakan.id, 1)
  assert.equal(page.trackCount, 2)
  assert.ok(page.appearsOn.some((a) => a.id === duet.albumId), 'duet album under "appears on"')
  assert.ok(page.topTracks.some((tr) => tr.id === duet.id))
  assert.ok(catalog.listTracks({ artistId: atakan.id, userId: 1 }).some((tr) => tr.id === duet.id))
  assert.equal(catalog.search('yalan', { userId: 1 }).tracks.find((tr) => tr.title === 'Bir Derdim Var')?.artists, undefined, 'one artist: no list')
})

test('songs scanned before the split move off combined artists once, follows kept', async (t) => {
  const { service, db, catalog } = await start(t, async (lib) => {
    await writeTrack(path.join(lib, 'Duet.mp3'), { title: 'Düet', artist: 'Dedublüman & Cem Adrian', album: 'Düet - Single', albumartist: 'Dedublüman & Cem Adrian' })
    await writeTrack(path.join(lib, 'Cem.mp3'), { title: 'Solo Cem', artist: 'Cem Adrian', album: 'Cem Albüm' })
    await writeTrack(path.join(lib, 'Dedu.mp3'), { title: 'Solo Dedu', artist: 'Dedublüman', album: 'Dedu Albüm' })
  })
  // Recreate how an older version stored the duet: one combined artist
  // row owning the song and its album, followed by the user.
  const duet = db.prepare("SELECT id, album_id FROM tracks WHERE title = 'Düet'").get()
  const combined = Number(db.prepare("INSERT INTO artists (name, name_key, created_at) VALUES ('Dedublüman & Cem Adrian', 'dedubluman & cem adrian', 0)").run().lastInsertRowid)
  db.prepare('UPDATE tracks SET artist_id = ? WHERE id = ?').run(combined, duet.id)
  db.prepare('UPDATE albums SET artist_id = ? WHERE id = ?').run(combined, duet.album_id)
  db.prepare('DELETE FROM track_artists').run()
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES (5, 'u', 'U', 'x', 'admin', 0, 0)").run()
  db.prepare("INSERT INTO favorites (user_id, item_type, item_id, created_at) VALUES (5, 'artist', ?, 0)").run(combined)
  db.prepare("DELETE FROM settings WHERE key = 'artist_credits_version'").run()

  assert.deepEqual(createArtistCredits(db).migrate(), { changed: true })
  assert.equal(db.prepare('SELECT id FROM artists WHERE id = ?').get(combined), undefined, 'combined row is gone')
  const dedu = artistByName(db, 'Dedublüman')
  const cem = artistByName(db, 'Cem Adrian')
  assert.equal(db.prepare('SELECT artist_id FROM tracks WHERE id = ?').get(duet.id).artist_id, dedu.id)
  assert.equal(db.prepare('SELECT artist_id FROM albums WHERE id = ?').get(duet.album_id).artist_id, dedu.id)
  assert.ok(catalog.getArtist(cem.id, 1).topTracks.some((tr) => tr.id === duet.id))
  assert.ok(db.prepare("SELECT 1 FROM favorites WHERE user_id = 5 AND item_type = 'artist' AND item_id = ?").get(dedu.id), 'follow moved to the first artist')
  assert.deepEqual(createArtistCredits(db).migrate(), { changed: false }, 'runs once')
  void service
})
