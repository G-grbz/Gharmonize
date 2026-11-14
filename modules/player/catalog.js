import { normalizeKey } from './scanner.js'
import { transaction } from './db.js'
import { visibleSql, uidLiteral } from './access.js'
import { uniqueSongs } from './songKey.js'

export class CatalogError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

// Every catalog query is scoped to the libraries the user ($uid) may see.
const VISIBLE = visibleSql('t', '$uid')
const MAX_LIMIT = 500
const HISTORY_CAP_PER_USER = 20000
const MAX_PLAYLIST_TRACKS = 10000

export function clampLimit(value, fallback = 50, max = MAX_LIMIT) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, max)
}

export function clampOffset(value) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

export const TRACK_COLUMNS = `
  t.id, t.title, t.artist_id, t.artist_name, t.album_id, t.album_title, t.album_artist, t.track_no, t.disc_no,
  t.year, t.genre, t.duration, t.bitrate, t.sample_rate, t.bit_depth, t.channels, t.codec, t.container,
  t.lossless, t.has_lyrics, t.rg_track_gain, t.rg_album_gain, t.library_id, t.added_at, t.size`

const favoriteExpr = (type, idExpr) =>
  `EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = $uid AND f.item_type = '${type}' AND f.item_id = ${idExpr})`

export function serializeTrack(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    artist: row.artist_name,
    artistId: row.artist_id,
    album: row.album_title,
    albumId: row.album_id,
    albumArtist: row.album_artist,
    trackNo: row.track_no,
    discNo: row.disc_no,
    year: row.year,
    genre: row.genre,
    duration: row.duration,
    bitrate: row.bitrate,
    sampleRate: row.sample_rate,
    bitDepth: row.bit_depth,
    channels: row.channels,
    codec: row.codec,
    container: row.container,
    lossless: Boolean(row.lossless),
    hasLyrics: Boolean(row.has_lyrics),
    replayGain: { track: row.rg_track_gain, album: row.rg_album_gain },
    libraryId: row.library_id,
    addedAt: row.added_at,
    size: row.size,
    favorite: Boolean(row.favorite),
    artwork: row.album_id ? `album/${row.album_id}` : `track/${row.id}`,
    ...(row.play_count != null ? { playCount: row.play_count } : {}),
    ...(row.last_played_at != null ? { lastPlayedAt: row.last_played_at } : {})
  }
}

function serializeAlbum(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    artist: row.artist_name,
    artistId: row.artist_id,
    year: row.year,
    genre: row.genre,
    trackCount: row.track_count,
    duration: row.duration,
    lossless: Boolean(row.lossless),
    addedAt: row.added_at,
    favorite: Boolean(row.favorite),
    artwork: `album/${row.id}`
  }
}

function serializeArtist(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    trackCount: row.track_count,
    albumCount: row.album_count,
    favorite: Boolean(row.favorite),
    artwork: `artist/${row.id}`
  }
}

const ALBUM_SELECT = `
  SELECT a.id, a.title, a.year, a.genre, ar.id AS artist_id, ar.name AS artist_name,
    COUNT(t.id) AS track_count, SUM(t.duration) AS duration, MAX(t.added_at) AS added_at, MIN(t.lossless) AS lossless,
    ${favoriteExpr('album', 'a.id')} AS favorite
  FROM albums a
  JOIN artists ar ON ar.id = a.artist_id
  JOIN tracks t ON t.album_id = a.id AND ${VISIBLE}`

const ALBUM_SORTS = {
  recent: 'added_at DESC, a.id DESC',
  alpha: 'a.title COLLATE NOCASE, a.id',
  artist: 'ar.name COLLATE NOCASE, a.year, a.title COLLATE NOCASE',
  year: 'a.year DESC NULLS LAST, a.title COLLATE NOCASE',
  random: 'RANDOM()'
}

const TRACK_SORTS = {
  recent: 't.added_at DESC, t.id DESC',
  alpha: 't.title COLLATE NOCASE, t.id',
  artist: 't.artist_name COLLATE NOCASE, t.album_title COLLATE NOCASE, t.disc_no, t.track_no',
  random: 'RANDOM()'
}

// Builds a safe FTS5 MATCH expression: every token must prefix-match.
export function buildFtsQuery(input) {
  const tokens = normalizeKey(input)
    .replace(/["*^:(){}[\]\\]/g, ' ')
    .split(/\s+/)
    .map((tok) => tok.replace(/[^\p{L}\p{N}'-]/gu, ''))
    .filter(Boolean)
    .slice(0, 8)
  if (!tokens.length) return null
  return tokens.map((tok) => `"${tok.replace(/"/g, '')}"*`).join(' AND ')
}

function likePattern(input) {
  return `%${normalizeKey(input).replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

export function createCatalog(db, { now = () => Date.now() } = {}) {
  const q = (sql) => db.prepare(sql)

  // Raw row of a track the user may access (null otherwise).
  function getTrackRow(id, userId) {
    return q(`SELECT t.* FROM tracks t WHERE t.id = $id AND ${VISIBLE}`).get({ $id: Number(id) || 0, $uid: Number(userId) || 0 }) || null
  }

  function getTrack(id, userId) {
    const row = q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite FROM tracks t WHERE t.id = $id AND ${VISIBLE}`)
      .get({ $id: Number(id), $uid: Number(userId) || 0 })
    return serializeTrack(row)
  }

  function getTracksByIds(ids, userId) {
    const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_LIMIT)
    if (!list.length) return []
    // Positional parameters only; the numeric user id is inlined after coercion.
    const uid = uidLiteral(userId)
    const stmt = q(`SELECT ${TRACK_COLUMNS}, EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = ${uid} AND f.item_type = 'track' AND f.item_id = t.id) AS favorite
      FROM tracks t WHERE t.id IN (${list.map(() => '?').join(',')}) AND ${visibleSql('t', uid)}`)
    const byId = new Map(stmt.all(...list).map((row) => [row.id, serializeTrack(row)]))
    return list.map((id) => byId.get(id)).filter(Boolean)
  }

  function listTracks({ sort = 'recent', limit, offset, genre, artistId, favorites = false, userId } = {}) {
    const where = [VISIBLE]
    const params = { $uid: Number(userId) || 0, $limit: clampLimit(limit), $offset: clampOffset(offset) }
    if (genre) { where.push('t.genre = $genre COLLATE NOCASE'); params.$genre = String(genre) }
    if (artistId) { where.push('t.artist_id = $artist'); params.$artist = Number(artistId) }
    if (favorites) where.push(favoriteExpr('track', 't.id'))
    const order = favorites && sort === 'recent'
      ? '(SELECT f.created_at FROM favorites f WHERE f.user_id = $uid AND f.item_type = \'track\' AND f.item_id = t.id) DESC'
      : (TRACK_SORTS[sort] || TRACK_SORTS.recent)
    const rows = q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite FROM tracks t
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $limit OFFSET $offset`).all(params)
    return rows.map(serializeTrack)
  }

  function listAlbums({ sort = 'recent', limit, offset, artistId, genre, favorites = false, userId } = {}) {
    const where = []
    const params = { $uid: Number(userId) || 0, $limit: clampLimit(limit), $offset: clampOffset(offset) }
    if (artistId) { where.push('a.artist_id = $artist'); params.$artist = Number(artistId) }
    if (genre) { where.push('a.genre = $genre COLLATE NOCASE'); params.$genre = String(genre) }
    if (favorites) where.push(favoriteExpr('album', 'a.id'))
    const rows = q(`${ALBUM_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY a.id ORDER BY ${ALBUM_SORTS[sort] || ALBUM_SORTS.recent} LIMIT $limit OFFSET $offset`).all(params)
    return rows.map(serializeAlbum)
  }

  function getAlbum(id, userId) {
    const params = { $id: Number(id), $uid: Number(userId) || 0 }
    const album = q(`${ALBUM_SELECT} WHERE a.id = $id GROUP BY a.id`).get(params)
    if (!album) return null
    const tracks = q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite FROM tracks t
      WHERE t.album_id = $id AND ${VISIBLE}
      ORDER BY COALESCE(t.disc_no, 1), COALESCE(t.track_no, 9999), t.title COLLATE NOCASE`).all(params)
    return { ...serializeAlbum(album), tracks: tracks.map(serializeTrack) }
  }

  const ARTIST_BASE = `
    WITH vis AS (SELECT t.id, t.artist_id, t.album_id FROM tracks t WHERE ${VISIBLE}),
    ta AS (
      SELECT artist_id AS aid, id AS tid, album_id FROM vis WHERE artist_id IS NOT NULL
      UNION
      SELECT al.artist_id AS aid, vis.id AS tid, vis.album_id FROM vis JOIN albums al ON al.id = vis.album_id
    )
    SELECT ar.id, ar.name, COUNT(DISTINCT ta.tid) AS track_count, COUNT(DISTINCT ta.album_id) AS album_count,
      ${favoriteExpr('artist', 'ar.id')} AS favorite
    FROM artists ar JOIN ta ON ta.aid = ar.id`

  function listArtists({ sort = 'alpha', limit, offset, favorites = false, userId } = {}) {
    const params = { $uid: Number(userId) || 0, $limit: clampLimit(limit, 100), $offset: clampOffset(offset) }
    const order = sort === 'tracks' ? 'track_count DESC, ar.name COLLATE NOCASE' : sort === 'random' ? 'RANDOM()' : 'ar.name COLLATE NOCASE'
    const rows = q(`${ARTIST_BASE} ${favorites ? `WHERE ${favoriteExpr('artist', 'ar.id')}` : ''}
      GROUP BY ar.id ORDER BY ${order} LIMIT $limit OFFSET $offset`).all(params)
    return rows.map(serializeArtist)
  }

  function getArtist(id, userId) {
    const params = { $id: Number(id), $uid: Number(userId) || 0 }
    const artist = q(`${ARTIST_BASE} WHERE ar.id = $id GROUP BY ar.id`).get(params)
    if (!artist) return null
    const albums = q(`${ALBUM_SELECT} WHERE a.artist_id = $id GROUP BY a.id ORDER BY a.year DESC NULLS LAST, a.title COLLATE NOCASE`).all(params)
    const appearsOn = q(`${ALBUM_SELECT} WHERE a.artist_id != $id AND a.id IN (SELECT album_id FROM tracks WHERE artist_id = $id AND album_id IS NOT NULL)
      GROUP BY a.id ORDER BY a.year DESC NULLS LAST LIMIT 50`).all(params)
    const topTracks = q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite,
        COALESCE((SELECT SUM(ps.play_count) FROM play_stats ps WHERE ps.track_id = t.id), 0) AS play_count
      FROM tracks t WHERE (t.artist_id = $id OR t.album_id IN (SELECT id FROM albums WHERE artist_id = $id)) AND ${VISIBLE}
      ORDER BY play_count DESC, t.added_at DESC LIMIT 10`).all(params)
    const singles = q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite FROM tracks t
      WHERE t.artist_id = $id AND t.album_id IS NULL AND ${VISIBLE} ORDER BY t.year DESC NULLS LAST, t.added_at DESC LIMIT 200`).all(params)
    return {
      ...serializeArtist(artist),
      albums: albums.map(serializeAlbum),
      appearsOn: appearsOn.map(serializeAlbum),
      topTracks: topTracks.map(serializeTrack),
      singles: singles.map(serializeTrack)
    }
  }

  function search(input, { limit, userId } = {}) {
    const text = String(input || '').trim().slice(0, 200)
    const empty = { tracks: [], albums: [], artists: [] }
    if (!text) return empty
    const max = clampLimit(limit, 20, 100)
    const uid = Number(userId) || 0
    const match = buildFtsQuery(text)
    const tracks = match
      ? q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite
          FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
          WHERE tracks_fts MATCH $match AND ${VISIBLE}
          ORDER BY bm25(tracks_fts, 10.0, 5.0, 3.0, 2.0, 1.0) LIMIT $limit`).all({ $match: match, $limit: max, $uid: uid })
      : []
    const pattern = likePattern(text)
    const albums = q(`${ALBUM_SELECT} WHERE a.title_key LIKE $p ESCAPE '\\' GROUP BY a.id ORDER BY added_at DESC LIMIT $limit`)
      .all({ $p: pattern, $limit: max, $uid: uid })
    const artists = q(`${ARTIST_BASE} WHERE ar.name_key LIKE $p ESCAPE '\\' GROUP BY ar.id ORDER BY track_count DESC LIMIT $limit`)
      .all({ $p: pattern, $limit: max, $uid: uid })
    return { tracks: tracks.map(serializeTrack), albums: albums.map(serializeAlbum), artists: artists.map(serializeArtist) }
  }

  function listGenres({ limit, userId } = {}) {
    return q(`SELECT t.genre AS name, COUNT(*) AS track_count, COUNT(DISTINCT t.album_id) AS album_count
      FROM tracks t WHERE t.genre IS NOT NULL AND t.genre != '' AND ${VISIBLE}
      GROUP BY t.genre COLLATE NOCASE ORDER BY track_count DESC LIMIT $limit`).all({ $limit: clampLimit(limit, 100), $uid: Number(userId) || 0 })
      .map((row) => ({ name: row.name, trackCount: row.track_count, albumCount: row.album_count }))
  }

  function getStats(userId) {
    const row = q(`SELECT COUNT(*) AS tracks, COALESCE(SUM(t.duration), 0) AS duration, COALESCE(SUM(t.size), 0) AS size,
      COUNT(DISTINCT t.album_id) AS albums, COUNT(DISTINCT t.artist_id) AS artists, SUM(t.lossless) AS lossless
      FROM tracks t WHERE ${VISIBLE}`).get({ $uid: Number(userId) || 0 })
    return {
      tracks: row.tracks,
      albums: row.albums,
      artists: row.artists,
      lossless: row.lossless || 0,
      durationSeconds: Math.round(row.duration),
      sizeBytes: row.size
    }
  }

  // ---- personal data -------------------------------------------------------

  const ITEM_TABLE = { track: 'tracks', album: 'albums', artist: 'artists' }

  function setFavorite(userId, type, itemId, value) {
    if (!ITEM_TABLE[type]) throw new CatalogError('INVALID_FAVORITE_TYPE', 'Invalid favorite type.')
    const id = Number(itemId)
    if (!q(`SELECT 1 FROM ${ITEM_TABLE[type]} WHERE id = ?`).get(id)) throw new CatalogError('NOT_FOUND', 'Item not found.', 404)
    if (value) {
      q('INSERT OR IGNORE INTO favorites (user_id, item_type, item_id, created_at) VALUES (?, ?, ?, ?)').run(Number(userId), type, id, now())
    } else {
      q('DELETE FROM favorites WHERE user_id = ? AND item_type = ? AND item_id = ?').run(Number(userId), type, id)
    }
    return { type, id, favorite: Boolean(value) }
  }

  function recordPlay(userId, { trackId, playedMs = 0, completed = false, context = '', deviceId = '' } = {}) {
    const track = getTrackRow(trackId, userId)
    if (!track) throw new CatalogError('NOT_FOUND', 'Track not found.', 404)
    const played = Math.max(0, Math.min(Math.floor(Number(playedMs) || 0), 24 * 60 * 60 * 1000))
    const durationMs = (Number(track.duration) || 0) * 1000
    const counted = Boolean(completed) || played >= 30_000 || (durationMs > 0 && played >= durationMs * 0.5)
    const skipped = !counted && played < 30_000
    const ts = now()
    transaction(db, () => {
      q('INSERT INTO play_history (user_id, track_id, played_at, played_ms, completed, context, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(Number(userId), track.id, ts, played, completed ? 1 : 0, String(context || '').slice(0, 120), String(deviceId || '').slice(0, 64))
      q(`INSERT INTO play_stats (user_id, track_id, play_count, skip_count, last_played_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, track_id) DO UPDATE SET
           play_count = play_count + excluded.play_count,
           skip_count = skip_count + excluded.skip_count,
           last_played_at = excluded.last_played_at`)
        .run(Number(userId), track.id, counted ? 1 : 0, skipped ? 1 : 0, ts)
      q(`DELETE FROM play_history WHERE user_id = $uid AND id <= (
           SELECT id FROM play_history WHERE user_id = $uid ORDER BY id DESC LIMIT 1 OFFSET ${HISTORY_CAP_PER_USER})`)
        .run({ $uid: Number(userId) })
    })
    return { counted, skipped }
  }

  function recentlyPlayed(userId, { limit } = {}) {
    const rows = q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite, MAX(h.played_at) AS last_played_at
      FROM play_history h JOIN tracks t ON t.id = h.track_id
      WHERE h.user_id = $uid AND ${VISIBLE}
      GROUP BY t.id ORDER BY last_played_at DESC LIMIT $limit`).all({ $uid: Number(userId), $limit: clampLimit(limit, 30) * 3 })
    // Copies of the same song (one per downloaded playlist) show once.
    return uniqueSongs(rows).slice(0, clampLimit(limit, 30)).map(serializeTrack)
  }

  function mostPlayed(userId, opts = {}) {
    const want = clampLimit(opts.limit, 30)
    return uniqueSongs(mostPlayedRows(userId, { ...opts, limit: want * 3 })).slice(0, want)
  }

  function mostPlayedRows(userId, { limit, sinceMs = null } = {}) {
    const params = { $uid: Number(userId), $limit: clampLimit(limit, 30, 600) }
    if (sinceMs) {
      params.$since = Number(sinceMs)
      return q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite, COUNT(*) AS play_count
        FROM play_history h JOIN tracks t ON t.id = h.track_id
        WHERE h.user_id = $uid AND h.played_at >= $since AND ${VISIBLE}
        GROUP BY t.id ORDER BY play_count DESC LIMIT $limit`).all(params).map(serializeTrack)
    }
    return q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite, ps.play_count, ps.last_played_at
      FROM play_stats ps JOIN tracks t ON t.id = ps.track_id
      WHERE ps.user_id = $uid AND ps.play_count > 0 AND ${VISIBLE}
      ORDER BY ps.play_count DESC, ps.last_played_at DESC LIMIT $limit`).all(params).map(serializeTrack)
  }

  function recentAlbumsPlayed(userId, { limit } = {}) {
    const ids = q(`SELECT t.album_id AS id, MAX(h.played_at) AS last FROM play_history h JOIN tracks t ON t.id = h.track_id
      WHERE h.user_id = ? AND t.album_id IS NOT NULL GROUP BY t.album_id ORDER BY last DESC LIMIT ?`).all(Number(userId), clampLimit(limit, 12))
    return ids.map((row) => {
      const album = q(`${ALBUM_SELECT} WHERE a.id = $id GROUP BY a.id`).get({ $id: row.id, $uid: Number(userId) })
      return serializeAlbum(album)
    }).filter(Boolean)
  }

  // Tracks the user loved once but has not played for a long time.
  function forgottenFavorites(userId, { limit, olderThanMs = 60 * 24 * 60 * 60 * 1000 } = {}) {
    return q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite, ps.play_count, ps.last_played_at
      FROM play_stats ps JOIN tracks t ON t.id = ps.track_id
      WHERE ps.user_id = $uid AND ps.play_count >= 3 AND ps.last_played_at < $cutoff AND ${VISIBLE}
      ORDER BY ps.play_count DESC LIMIT $limit`)
      .all({ $uid: Number(userId), $cutoff: now() - olderThanMs, $limit: clampLimit(limit, 20) }).map(serializeTrack)
  }

  function neverPlayed(userId, { limit } = {}) {
    return q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite FROM tracks t
      WHERE ${VISIBLE} AND NOT EXISTS (SELECT 1 FROM play_stats ps WHERE ps.user_id = $uid AND ps.track_id = t.id)
      ORDER BY RANDOM() LIMIT $limit`).all({ $uid: Number(userId), $limit: clampLimit(limit, 20) }).map(serializeTrack)
  }

  // "Because you listened to X": songs that sit next to X's songs in the
  // same folders (downloaded playlists group similar music) or share X's
  // genre, preferring ones the user has not played much.
  function becauseYouListened(userId, { shelves = 2, limit = 20 } = {}) {
    const uid = Number(userId)
    const recentArtists = q(`SELECT t.artist_id AS id, ar.name, MAX(h.played_at) AS last FROM play_history h
      JOIN tracks t ON t.id = h.track_id JOIN artists ar ON ar.id = t.artist_id
      WHERE h.user_id = $uid AND ${VISIBLE} GROUP BY t.artist_id ORDER BY last DESC LIMIT 6`).all({ $uid: uid })
    const out = []
    const used = new Set()
    for (const artist of recentArtists) {
      if (out.length >= shelves) break
      const dir = "rtrim(x.rel_path, replace(x.rel_path, '/', ''))"
      const rows = q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite, COALESCE(ps.play_count, 0) AS plays
        FROM tracks t LEFT JOIN play_stats ps ON ps.track_id = t.id AND ps.user_id = $uid
        WHERE ${VISIBLE} AND (t.artist_id IS NULL OR t.artist_id != $artist) AND (
          (t.library_id || ':' || rtrim(t.rel_path, replace(t.rel_path, '/', ''))) IN (
            SELECT x.library_id || ':' || ${dir} FROM tracks x WHERE x.artist_id = $artist AND instr(x.rel_path, '/') > 0)
          OR (t.genre IS NOT NULL AND TRIM(t.genre) != '' AND LOWER(t.genre) NOT IN ('music', 'other', 'unknown') AND t.genre IN (
            SELECT x.genre FROM tracks x WHERE x.artist_id = $artist AND x.genre IS NOT NULL GROUP BY x.genre ORDER BY COUNT(*) DESC LIMIT 1)))
        ORDER BY plays ASC, RANDOM() LIMIT $limit`).all({ $uid: uid, $artist: artist.id, $limit: limit * 3 })
      const items = uniqueSongs(rows.filter((r) => !used.has(r.id))).slice(0, limit)
      if (items.length < 6) continue
      items.forEach((r) => used.add(r.id))
      out.push({ id: `because-${artist.id}`, kind: 'tracks', title: 'becauseYouListened', titleVars: { artist: artist.name }, items: items.map(serializeTrack) })
    }
    return out
  }

  function topArtistsForUser(userId, { limit, sinceMs = null } = {}) {
    const params = { $uid: Number(userId), $limit: clampLimit(limit, 12), $since: Number(sinceMs) || 0 }
    return q(`SELECT ar.id, ar.name, COUNT(*) AS plays FROM play_history h JOIN tracks t ON t.id = h.track_id
      JOIN artists ar ON ar.id = t.artist_id WHERE h.user_id = $uid AND h.played_at >= $since AND ${VISIBLE}
      GROUP BY ar.id ORDER BY plays DESC LIMIT $limit`).all(params)
      .map((row) => ({ id: row.id, name: row.name, plays: row.plays, artwork: `artist/${row.id}` }))
  }

  // ---- playlists -----------------------------------------------------------

  function serializePlaylist(row, userId) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      isPublic: Boolean(row.is_public),
      owner: { id: row.user_id, displayName: row.owner_name },
      editable: Number(row.user_id) === Number(userId),
      trackCount: row.track_count,
      duration: row.duration,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      artwork: `playlist/${row.id}`
    }
  }

  const PLAYLIST_SELECT = `
    SELECT p.*, u.display_name AS owner_name,
      (SELECT COUNT(*) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = p.id AND ${VISIBLE}) AS track_count,
      (SELECT SUM(t.duration) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = p.id AND ${VISIBLE}) AS duration
    FROM playlists p JOIN users u ON u.id = p.user_id`

  function listPlaylists(userId) {
    return q(`${PLAYLIST_SELECT} WHERE p.user_id = $uid OR p.is_public = 1 ORDER BY p.user_id = $uid DESC, p.updated_at DESC`)
      .all({ $uid: Number(userId) }).map((row) => serializePlaylist(row, userId))
  }

  function loadPlaylistRow(id, userId, { write = false } = {}) {
    const row = q(`${PLAYLIST_SELECT} WHERE p.id = $id`).get({ $id: Number(id), $uid: Number(userId) || 0 })
    if (!row || (Number(row.user_id) !== Number(userId) && !row.is_public)) throw new CatalogError('NOT_FOUND', 'Playlist not found.', 404)
    if (write && Number(row.user_id) !== Number(userId)) throw new CatalogError('FORBIDDEN', 'Only the owner can change this playlist.', 403)
    return row
  }

  function getPlaylist(id, userId) {
    const row = loadPlaylistRow(id, userId)
    const tracks = q(`SELECT ${TRACK_COLUMNS}, ${favoriteExpr('track', 't.id')} AS favorite, pt.id AS entry_id
      FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = $id AND ${VISIBLE} ORDER BY pt.position, pt.id`).all({ $id: row.id, $uid: Number(userId) })
    return { ...serializePlaylist(row, userId), tracks: tracks.map((t) => ({ ...serializeTrack(t), entryId: t.entry_id })) }
  }

  function createPlaylist(userId, { name, description = '', isPublic = false, trackIds = [] } = {}) {
    const finalName = String(name || '').trim().slice(0, 120)
    if (!finalName) throw new CatalogError('PLAYLIST_NAME_REQUIRED', 'Playlist name is required.')
    const ts = now()
    const id = Number(q('INSERT INTO playlists (user_id, name, description, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Number(userId), finalName, String(description || '').slice(0, 1000), isPublic ? 1 : 0, ts, ts).lastInsertRowid)
    if (trackIds?.length) addPlaylistTracks(id, userId, trackIds)
    return getPlaylist(id, userId)
  }

  function updatePlaylist(id, userId, { name, description, isPublic } = {}) {
    const row = loadPlaylistRow(id, userId, { write: true })
    const nextName = name !== undefined ? String(name).trim().slice(0, 120) : row.name
    if (!nextName) throw new CatalogError('PLAYLIST_NAME_REQUIRED', 'Playlist name is required.')
    q('UPDATE playlists SET name = ?, description = ?, is_public = ?, updated_at = ? WHERE id = ?').run(
      nextName,
      description !== undefined ? String(description).slice(0, 1000) : row.description,
      isPublic !== undefined ? (isPublic ? 1 : 0) : row.is_public,
      now(),
      row.id
    )
    return getPlaylist(row.id, userId)
  }

  function deletePlaylist(id, userId) {
    const row = loadPlaylistRow(id, userId, { write: true })
    q('DELETE FROM playlists WHERE id = ?').run(row.id)
  }

  function addPlaylistTracks(id, userId, trackIds) {
    const row = loadPlaylistRow(id, userId, { write: true })
    const ids = (Array.isArray(trackIds) ? trackIds : [trackIds]).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 1000)
    transaction(db, () => {
      const count = q('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS maxpos FROM playlist_tracks WHERE playlist_id = ?').get(row.id)
      if (count.n + ids.length > MAX_PLAYLIST_TRACKS) throw new CatalogError('PLAYLIST_FULL', `A playlist can hold at most ${MAX_PLAYLIST_TRACKS} tracks.`, 409)
      let pos = count.maxpos + 1
      const ins = q('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)')
      const exists = q(`SELECT 1 FROM tracks t WHERE t.id = ? AND ${visibleSql('t', uidLiteral(userId))}`)
      const ts = now()
      for (const trackId of ids) {
        if (!exists.get(trackId)) continue
        ins.run(row.id, trackId, pos++, ts)
      }
      q('UPDATE playlists SET updated_at = ? WHERE id = ?').run(ts, row.id)
    })
    return getPlaylist(row.id, userId)
  }

  function removePlaylistEntry(id, userId, entryId) {
    const row = loadPlaylistRow(id, userId, { write: true })
    q('DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?').run(Number(entryId), row.id)
    q('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now(), row.id)
    return getPlaylist(row.id, userId)
  }

  // Moves one entry to a new index (0-based) and renumbers positions.
  function movePlaylistEntry(id, userId, entryId, toIndex) {
    const row = loadPlaylistRow(id, userId, { write: true })
    transaction(db, () => {
      const entries = q('SELECT id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position, id').all(row.id).map((e) => e.id)
      const from = entries.indexOf(Number(entryId))
      if (from === -1) throw new CatalogError('NOT_FOUND', 'Playlist entry not found.', 404)
      const [moved] = entries.splice(from, 1)
      const target = Math.max(0, Math.min(Math.floor(Number(toIndex) || 0), entries.length))
      entries.splice(target, 0, moved)
      const upd = q('UPDATE playlist_tracks SET position = ? WHERE id = ?')
      entries.forEach((entry, index) => upd.run(index, entry))
      q('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now(), row.id)
    })
    return getPlaylist(row.id, userId)
  }

  // ---- home ----------------------------------------------------------------

  // Library-based shelves. Online recommendation shelves are merged in by the
  // recommendation layer; empty shelves are dropped by the client.
  function home(userId) {
    const day = 24 * 60 * 60 * 1000
    const recentlyAddedAlbums = listAlbums({ sort: 'recent', limit: 20, userId })
    const shelves = [
      { id: 'recently-played', kind: 'tracks', title: 'recentlyPlayed', items: recentlyPlayed(userId, { limit: 20 }) },
      { id: 'jump-back-in', kind: 'albums', title: 'jumpBackIn', items: recentAlbumsPlayed(userId, { limit: 12 }) },
      { id: 'recently-added', kind: 'albums', title: 'recentlyAdded', items: recentlyAddedAlbums },
      { id: 'new-tracks', kind: 'tracks', title: 'newTracks', items: listTracks({ sort: 'recent', limit: 20, userId }) },
      { id: 'on-repeat', kind: 'tracks', title: 'onRepeat', items: mostPlayed(userId, { limit: 20, sinceMs: now() - 30 * day }) },
      { id: 'all-time-top', kind: 'tracks', title: 'allTimeTop', items: mostPlayed(userId, { limit: 20 }) },
      { id: 'top-artists', kind: 'artists', title: 'topArtists', items: topArtistsForUser(userId, { limit: 12, sinceMs: now() - 90 * day }) },
      { id: 'liked', kind: 'tracks', title: 'likedTracks', items: listTracks({ favorites: true, limit: 20, userId }) },
      { id: 'forgotten', kind: 'tracks', title: 'forgottenFavorites', items: forgottenFavorites(userId, { limit: 20 }) },
      ...becauseYouListened(userId),
      { id: 'never-played', kind: 'tracks', title: 'neverPlayed', items: neverPlayed(userId, { limit: 20 }) },
      { id: 'discover-albums', kind: 'albums', title: 'randomAlbums', items: listAlbums({ sort: 'random', limit: 16, userId }) },
      { id: 'artists', kind: 'artists', title: 'yourArtists', items: listArtists({ sort: 'random', limit: 16, userId }) },
      { id: 'genres', kind: 'genres', title: 'genres', items: listGenres({ limit: 24, userId }) }
    ]
    return { stats: getStats(userId), shelves: shelves.filter((shelf) => shelf.items.length) }
  }

  return {
    getTrackRow,
    getTrack,
    getTracksByIds,
    listTracks,
    listAlbums,
    getAlbum,
    listArtists,
    getArtist,
    search,
    listGenres,
    getStats,
    setFavorite,
    recordPlay,
    recentlyPlayed,
    mostPlayed,
    listPlaylists,
    getPlaylist,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    addPlaylistTracks,
    removePlaylistEntry,
    movePlaylistEntry,
    home
  }
}
