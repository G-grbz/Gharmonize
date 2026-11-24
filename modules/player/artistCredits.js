// Songs by several artists ("Oguz Aksaç, Atakan Dalkılıç"): each artist gets
// their own row (page, photo, online data) and track_artists links the song
// to all of them. tracks.artist_id / albums.artist_id point at the first
// artist; the full credit stays in tracks.artist_name / album_artist for
// display.

import { normalizeKey } from './scanner.js'
import { artistCreditNames } from './songKey.js'
import { transaction } from './db.js'

const UNKNOWN_ARTIST = 'Unknown Artist'
// Bumped when the way credits are split changes: existing songs are then
// linked again once, at start.
const CREDITS_VERSION = '1'
const SETTING_KEY = 'artist_credits_version'

export const NOT_LINKED_ARTIST_SQL = (alias = 'artists') =>
  `NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.artist_id = ${alias}.id)
      AND NOT EXISTS (SELECT 1 FROM albums WHERE albums.artist_id = ${alias}.id)
      AND NOT EXISTS (SELECT 1 FROM track_artists WHERE track_artists.artist_id = ${alias}.id)
      AND NOT EXISTS (SELECT 1 FROM favorites WHERE favorites.item_type = 'artist' AND favorites.item_id = ${alias}.id)`

export function createArtistCredits(db, { now = () => Date.now() } = {}) {
  const stmt = {
    artistByKey: db.prepare('SELECT id FROM artists WHERE name_key = ?'),
    insertArtist: db.prepare('INSERT INTO artists (name, name_key, created_at) VALUES (?, ?, ?)'),
    unlink: db.prepare('DELETE FROM track_artists WHERE track_id = ?'),
    link: db.prepare('INSERT OR IGNORE INTO track_artists (track_id, role, artist_id, position) VALUES (?, ?, ?, ?)')
  }

  function ensureArtist(name) {
    const clean = String(name || '').trim() || UNKNOWN_ARTIST
    const key = normalizeKey(clean) || normalizeKey(UNKNOWN_ARTIST)
    const row = stmt.artistByKey.get(key)
    if (row) return row.id
    return Number(stmt.insertArtist.run(clean, key, now()).lastInsertRowid)
  }

  // "A & B" splits when both are artists here already.
  const knownInDb = (name) => Boolean(stmt.artistByKey.get(normalizeKey(name)))

  function namesOf(credit, isKnown = knownInDb) {
    return artistCreditNames(credit, { isKnown })
  }

  /** Artist ids of a song: { artistId, albumArtistId, ids: { song: [...], album: [...] } }. */
  function resolve(artistName, albumArtist, isKnown = knownInDb) {
    const song = [...new Set(namesOf(artistName || UNKNOWN_ARTIST, isKnown).map(ensureArtist))]
    const album = albumArtist ? [...new Set(namesOf(albumArtist, isKnown).map(ensureArtist))] : []
    return { artistId: song[0], albumArtistId: album[0] ?? song[0], ids: { song, album } }
  }

  function link(trackId, ids) {
    stmt.unlink.run(trackId)
    ids.song.forEach((artistId, i) => stmt.link.run(trackId, 0, artistId, i))
    ids.album.forEach((artistId, i) => stmt.link.run(trackId, 1, artistId, i))
  }

  // Links songs to each of their artists again, moves songs, albums and
  // follows off combined rows ("A, B") and drops those. `onlyAmpersand`:
  // just the songs credited "A & B", whose split depends on which artists
  // the library knows (a duet scanned before the solo songs of its artists
  // could not be split yet).
  function relink({ onlyAmpersand = false } = {}) {
    let changed = false
    transaction(db, () => {
      // Names that are artists of their own somewhere in the library.
      const known = new Set()
      const credits = db.prepare(`SELECT artist_name AS c FROM tracks UNION SELECT album_artist FROM tracks WHERE album_artist IS NOT NULL`).all()
      for (const { c } of credits) for (const name of artistCreditNames(c)) if (!/\s&\s/.test(name)) known.add(normalizeKey(name))
      const isKnown = (name) => known.has(normalizeKey(name))

      const setArtist = db.prepare('UPDATE tracks SET artist_id = ? WHERE id = ?')
      const songs = db.prepare(`SELECT id, artist_id, artist_name, album_artist FROM tracks
        ${onlyAmpersand ? "WHERE artist_name LIKE '% & %' OR album_artist LIKE '% & %'" : ''}`).all()
      if (onlyAmpersand && !songs.length) return
      const linked = db.prepare('SELECT role, artist_id FROM track_artists WHERE track_id = ? ORDER BY role, position')
      for (const tr of songs) {
        const r = resolve(tr.artist_name, tr.album_artist, isKnown)
        if (r.artistId !== tr.artist_id) { setArtist.run(r.artistId, tr.id); changed = true }
        const before = linked.all(tr.id).map((l) => `${l.role}:${l.artist_id}`).join(',')
        const after = [...r.ids.song.map((id) => `0:${id}`), ...r.ids.album.map((id) => `1:${id}`)].join(',')
        if (before !== after) { link(tr.id, r.ids); changed = true }
      }

      // Albums belong to the first album artist; one already there is merged.
      const albums = db.prepare(`SELECT a.id, a.title_key, a.artist_id, ar.name,
          (SELECT t.album_artist FROM tracks t WHERE t.album_id = a.id AND t.album_artist IS NOT NULL LIMIT 1) AS credit
        FROM albums a JOIN artists ar ON ar.id = a.artist_id`).all()
      const sameAlbum = db.prepare('SELECT id FROM albums WHERE title_key = ? AND artist_id = ? AND id != ?')
      for (const al of albums) {
        const target = ensureArtist(namesOf(al.credit || al.name, isKnown)[0])
        if (target === al.artist_id) continue
        changed = true
        const into = sameAlbum.get(al.title_key, target, al.id)
        if (into) {
          db.prepare('UPDATE tracks SET album_id = ? WHERE album_id = ?').run(into.id, al.id)
          db.prepare(`INSERT OR IGNORE INTO favorites (user_id, item_type, item_id, created_at)
            SELECT user_id, 'album', ?, created_at FROM favorites WHERE item_type = 'album' AND item_id = ?`).run(into.id, al.id)
          db.prepare(`DELETE FROM favorites WHERE item_type = 'album' AND item_id = ?`).run(al.id)
          db.prepare('DELETE FROM albums WHERE id = ?').run(al.id)
        } else {
          db.prepare('UPDATE albums SET artist_id = ? WHERE id = ?').run(target, al.id)
        }
      }

      // Combined rows nothing points at any more: their followers follow
      // the first artist instead, then the rows go.
      const leftovers = db.prepare(`SELECT id, name FROM artists WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.artist_id = artists.id)
        AND NOT EXISTS (SELECT 1 FROM albums WHERE albums.artist_id = artists.id)
        AND NOT EXISTS (SELECT 1 FROM track_artists WHERE track_artists.artist_id = artists.id)`).all()
      for (const old of leftovers) {
        const names = namesOf(old.name, isKnown)
        if (names.length < 2) continue
        const first = ensureArtist(names[0])
        db.prepare(`INSERT OR IGNORE INTO favorites (user_id, item_type, item_id, created_at)
          SELECT user_id, 'artist', ?, created_at FROM favorites WHERE item_type = 'artist' AND item_id = ?`).run(first, old.id)
        db.prepare(`DELETE FROM favorites WHERE item_type = 'artist' AND item_id = ?`).run(old.id)
        try { db.prepare('UPDATE OR IGNORE artist_watch SET artist_id = ? WHERE artist_id = ?').run(first, old.id) } catch {}
        try { db.prepare('DELETE FROM artist_watch WHERE artist_id = ?').run(old.id) } catch {}
      }
      db.prepare(`DELETE FROM artists WHERE ${NOT_LINKED_ARTIST_SQL()}`).run()
      db.prepare(`DELETE FROM favorites WHERE item_type = 'album' AND NOT EXISTS (SELECT 1 FROM albums WHERE id = favorites.item_id)`).run()
    })
    return { changed }
  }

  // Once per CREDITS_VERSION: every song, at start.
  function migrate() {
    const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY)?.value
    if (done === CREDITS_VERSION) return { changed: false }
    const result = relink()
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(SETTING_KEY, CREDITS_VERSION)
    return result
  }

  return { resolve, link, migrate, relink, ensureArtist }
}
