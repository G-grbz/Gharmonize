import { youtubeSourceKey } from './sourceKey.js'
import { normalizeKey } from './scanner.js'
import { buildFtsQuery } from './catalog.js'
import { visibleSql } from './access.js'

export { cleanTitleForMatch, primaryArtistKey } from './songKey.js'
import { cleanTitleForMatch, primaryArtistKey } from './songKey.js'

// YouTube uploads often put "Artist - Title" in the title field.
export function splitArtistFromTitle(title, artist) {
  const raw = String(title || '')
  const parts = raw.split(/\s[-–—]\s/)
  if (parts.length < 2) return { title: raw, artist }
  const left = primaryArtistKey(parts[0])
  const known = primaryArtistKey(artist)
  if (!known || left === known || known.includes(left) || left.includes(known)) {
    return { title: parts.slice(1).join(' - '), artist: parts[0] }
  }
  return { title: raw, artist }
}

// "Wake Up - Single", "Wake Up (EP)", "Wake Up [Deluxe Edition]" → "wake up".
// Stores label the same release differently; the base title is what counts.
const EDITION_RE = /\s*(?:[-–—:]\s*(?:single|ep|e\.p\.)|[([{]\s*(?:single|ep|e\.p\.|deluxe(?:\s+(?:edition|version))?|expanded(?:\s+edition)?|remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|bonus track version|special edition)\s*[)\]}])\s*$/i
export function albumBaseKey(title) {
  let text = String(title || '').trim()
  for (let i = 0; i < 3; i++) {
    const next = text.replace(EDITION_RE, '').trim()
    if (next === text) break
    text = next
  }
  return normalizeKey(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function artistsMatch(a, b) {
  const x = primaryArtistKey(a)
  const y = primaryArtistKey(b)
  if (!x || !y) return false
  return x === y || x.includes(y) || y.includes(x)
}

export function createLibraryMatcher(db) {
  // All lookups are scoped to what the given user ($uid) may see: a song that
  // only exists in someone else's private library is "not in your library".
  const VIS = visibleSql('t', '$uid')
  const bySource = db.prepare(`SELECT t.id FROM tracks t WHERE t.source_key = $key AND ${VIS} LIMIT 1`)
  const byIsrc = db.prepare(`SELECT t.id FROM tracks t WHERE t.isrc = $isrc AND ${VIS} LIMIT 1`)
  const ftsCandidates = db.prepare(`SELECT t.id, t.title, t.artist_name, t.album_artist, t.duration
    FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
    WHERE tracks_fts MATCH $match AND ${VIS} LIMIT 40`)
  const albumCandidates = db.prepare(`SELECT a.id, a.title, ar.name AS artist_name,
      (SELECT COUNT(*) FROM tracks t WHERE t.album_id = a.id AND ${VIS}) AS track_count
    FROM albums a JOIN artists ar ON ar.id = a.artist_id WHERE a.title_key = $key OR a.title_key LIKE $prefix ESCAPE '\\'`)
  // Two indexed EXISTS instead of one "artist_id OR album_id IN (...)": the OR
  // form scanned every track × every album for album-only artists.
  const artistByKey = db.prepare(`SELECT ar.id FROM artists ar WHERE ar.name_key = $key
    AND (EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = ar.id AND ${VIS})
      OR EXISTS (SELECT 1 FROM albums a JOIN tracks t ON t.album_id = a.id WHERE a.artist_id = ar.id AND ${VIS}))`)
  const uidOf = (userId) => Number(userId) || 0
  const albumOfTrackStmt = db.prepare('SELECT album_id FROM tracks WHERE id = ?')
  function albumOfTrack(trackId) { return albumOfTrackStmt.get(Number(trackId))?.album_id || null }

  // Returns the library track id for an online track, or null.
  function findTrack({ title, artist, isrc, duration, url } = {}, userId) {
    const $uid = uidOf(userId)
    const sourceKey = youtubeSourceKey(url)
    if (sourceKey) {
      const hit = bySource.get({ $key: sourceKey, $uid })
      if (hit) return hit.id
    }
    if (isrc) {
      const hit = byIsrc.get({ $isrc: String(isrc).trim().toUpperCase(), $uid })
      if (hit) return hit.id
    }
    const split = splitArtistFromTitle(title, artist)
    const wantTitle = cleanTitleForMatch(split.title)
    if (!wantTitle) return null
    const match = buildFtsQuery(wantTitle)
    if (!match) return null
    let rows
    try { rows = ftsCandidates.all({ $match: match, $uid }) } catch { return null }
    let best = null
    for (const row of rows) {
      if (cleanTitleForMatch(row.title) !== wantTitle) continue
      if (!artistsMatch(row.artist_name, split.artist) && !artistsMatch(row.album_artist, split.artist)) continue
      const wantDuration = Number(duration) || 0
      const haveDuration = Number(row.duration) || 0
      // Same song, very different length → probably another version.
      if (wantDuration > 0 && haveDuration > 0 && Math.abs(wantDuration - haveDuration) > Math.max(15, wantDuration * 0.12)) continue
      best = row.id
      break
    }
    return best
  }

  // Returns { id, trackCount } for an online album, or null.
  function findAlbum({ title, artist } = {}, userId) {
    const want = albumBaseKey(title)
    if (!want) return null
    // Candidates: same title, or the same title followed by an edition label.
    const base = normalizeKey(String(title || '').replace(EDITION_RE, '').trim())
    const prefix = `${base.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    let best = null
    for (const row of albumCandidates.all({ $key: normalizeKey(title), $prefix: prefix, $uid: uidOf(userId) })) {
      if (row.track_count <= 0 || albumBaseKey(row.title) !== want || !artistsMatch(row.artist_name, artist)) continue
      if (!best || row.track_count > best.trackCount) best = { id: row.id, trackCount: row.track_count }
    }
    return best
  }

  // Returns the library artist id for an artist name, or null.
  function findArtist(name, userId) {
    const full = normalizeKey(name)
    if (!full) return null
    const $uid = uidOf(userId)
    const hit = artistByKey.get({ $key: full, $uid })
    if (hit) return hit.id
    const primary = primaryArtistKey(name)
    if (primary && primary !== full) return artistByKey.get({ $key: primary, $uid })?.id || null
    return null
  }

  return { findTrack, findAlbum, findArtist, albumOfTrack }
}
