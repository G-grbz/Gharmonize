import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir, silentLogger, waitFor } from './fixtures/playerAudio.mjs'
import { openPlayerDatabase } from '../modules/player/db.js'
import { createArtistPhotos, smallerDeezerPicture, isUsablePhotoUrl } from '../modules/player/artistPhotos.js'
import { createCatalog } from '../modules/player/catalog.js'

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)])
const PHOTO = 'https://e-cdns-images.dzcdn.net/images/artist/abc123/1000x1000-000000-80-0-0.jpg'

function fakeFetch(calls) {
  return async (url) => {
    calls.push(url)
    return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => JPEG }
  }
}

async function setup(t) {
  const root = tmpDir('artist-photos')
  const db = await openPlayerDatabase(path.join(root, 'data'))
  const insert = db.prepare('INSERT INTO artists (name, name_key, created_at) VALUES (?, ?, ?)')
  const ali = Number(insert.run('Ali Baran', 'ali baran', 1).lastInsertRowid)
  const other = Number(insert.run('Nobody', 'nobody', 1).lastInsertRowid)
  t.after(() => { try { db.close() } catch {} fs.rmSync(root, { recursive: true, force: true }) })
  return { root, db, ali, other, cacheDir: path.join(root, 'cache') }
}

test('Deezer photo URLs: smaller rendition, placeholders and foreign hosts refused', () => {
  assert.equal(smallerDeezerPicture(PHOTO), 'https://e-cdns-images.dzcdn.net/images/artist/abc123/500x500-000000-80-0-0.jpg')
  assert.equal(smallerDeezerPicture('https://x.dzcdn.net/images/artist/a/250x250-0.jpg'), 'https://x.dzcdn.net/images/artist/a/250x250-0.jpg')
  assert.equal(isUsablePhotoUrl(PHOTO), true)
  assert.equal(isUsablePhotoUrl('https://e-cdns-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg'), false)
  assert.equal(isUsablePhotoUrl('https://evil.example/images/artist/a/1.jpg'), false)
})

test('a photo seen online is kept once, changes the token and survives a restart', async (t) => {
  const { db, ali, cacheDir } = await setup(t)
  const calls = []
  const photos = createArtistPhotos({ cacheDir, db, logger: silentLogger, fetchImpl: fakeFetch(calls), gapMs: 0 })
  const changed = []
  photos.onChange((id) => changed.push(id))
  assert.equal(photos.token(ali), '')
  photos.remember(ali, 'Someone Else', PHOTO) // namesake check
  photos.remember(ali, 'Ali Baran', 'https://e-cdns-images.dzcdn.net/images/artist//1000x1000-0.jpg') // placeholder
  await waitFor(() => photos.idle())
  assert.equal(calls.length, 0)
  photos.remember(ali, 'ALİ BARAN', PHOTO)
  await waitFor(() => photos.idle() && changed.length === 1)
  assert.deepEqual(calls, [smallerDeezerPicture(PHOTO)])
  assert.deepEqual(changed, [ali])
  const photo = photos.photo(ali)
  assert.ok(photo && fs.existsSync(photo.file))
  assert.equal(fs.readFileSync(photo.file).length, JPEG.length)
  assert.match(photos.token(ali), /^artist-[0-9a-f]{16}$/)
  // Already stored: no second download.
  photos.remember(ali, 'Ali Baran', PHOTO)
  await waitFor(() => photos.idle())
  assert.equal(calls.length, 1)
  // A new instance reads the state from disk without any network.
  const again = createArtistPhotos({ cacheDir, db, logger: silentLogger, fetchImpl: fakeFetch(calls), gapMs: 0 })
  assert.equal(again.token(ali), photos.token(ali))
})

test('lookups run only when artwork is shown, never while the provider is off, and "none" is remembered', async (t) => {
  const { db, ali, other, cacheDir } = await setup(t)
  const calls = []
  const asked = []
  let answer = undefined
  const photos = createArtistPhotos({ cacheDir, db, logger: silentLogger, fetchImpl: fakeFetch(calls), gapMs: 0 })
  photos.want(ali) // no resolver yet
  photos.setResolver(async (name) => { asked.push(name); return answer })
  photos.want(ali)
  await waitFor(() => photos.idle())
  assert.deepEqual(asked, ['Ali Baran'])
  assert.equal(calls.length, 0)
  photos.want(ali) // undefined (provider off) leaves no marker: asked again later
  await waitFor(() => photos.idle())
  assert.equal(asked.length, 2)
  answer = null
  photos.want(other)
  await waitFor(() => photos.idle())
  assert.ok(fs.existsSync(path.join(cacheDir, 'artwork', 'artist')))
  photos.want(other) // known "none": not asked again
  await waitFor(() => photos.idle())
  assert.deepEqual(asked, ['Ali Baran', 'Ali Baran', 'Nobody'])
  answer = PHOTO
  photos.want(ali)
  await waitFor(() => photos.idle() && Boolean(photos.photo(ali)))
  assert.equal(calls.length, 1)
})

test('artists followed by name stay while followed and show up in the followed list', async (t) => {
  const { db } = await setup(t)
  const catalog = createCatalog(db)
  const uid = 1
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES (1, 'u', 'U', 'x', 'user', 1, 1)").run()
  const followed = catalog.followArtistByName(uid, 'Sezen Aksu', true)
  assert.equal(followed.favorite, true)
  const row = db.prepare('SELECT id, name_key FROM artists WHERE id = ?').get(followed.id)
  assert.equal(row.name_key, 'sezen aksu')
  const list = catalog.listArtists({ favorites: true, userId: uid })
  assert.deepEqual(list.map((a) => [a.name, a.trackCount, a.favorite]), [['Sezen Aksu', 0, true]])
  // Not in the normal library list (no songs).
  assert.equal(catalog.listArtists({ userId: uid }).some((a) => a.id === followed.id), false)
  // Following again reuses the row.
  assert.equal(catalog.followArtistByName(uid, 'SEZEN AKSU', true).id, followed.id)
  // Unfollow drops the placeholder row.
  catalog.followArtistByName(uid, 'Sezen Aksu', false)
  assert.equal(db.prepare('SELECT 1 FROM artists WHERE id = ?').get(followed.id), undefined)
  assert.equal(catalog.listArtists({ favorites: true, userId: uid }).length, 0)
})
