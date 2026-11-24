// Personal mixes built from the user's own library and listening history.
// Mixes are deterministic for a given user and day (weekly for the discovery
// mix): reopening a mix shows the same songs until it refreshes.

import { visibleSql, uidLiteral } from './access.js'
import { uniqueSongs, artistCredits } from './songKey.js'

const DAY = 24 * 60 * 60 * 1000
const MIX_SIZE = 40
const DAILY_MIXES = 8
const GENRE_MIXES = 10
// A genre mix needs this much to choose from to sound like a mix.
const GENRE_MIN_TRACKS = 20
const GENRE_MIN_ARTISTS = 3
// Songs per artist in a genre mix, so the genre's biggest artist does not
// fill it.
const GENRE_PER_ARTIST = 4
// Placeholder "genres" (e.g. YouTube's "Music") say nothing about the style.
const GENERIC_GENRES = new Set(['music', 'muzik', 'müzik', 'other', 'others', 'unknown', 'misc', 'genre', 'various', 'default', 'none', 'n/a'])
export const isRealGenre = (g) => Boolean(g) && !GENERIC_GENRES.has(String(g).trim().toLowerCase())
const GENRE_OK = `t.genre IS NOT NULL AND TRIM(t.genre) != '' AND LOWER(TRIM(t.genre)) NOT IN (${[...GENERIC_GENRES].map((g) => `'${g}'`).join(',')})`

// ---- deterministic randomness ------------------------------------------------------

function hashString(text) {
  let h = 1779033703 ^ text.length
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return h >>> 0
}

export function seededRandom(seed) {
  let a = hashString(String(seed))
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seededShuffle(list, rnd) {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function localDayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function weekKey(ts) {
  const d = new Date(ts)
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  return localDayKey(monday.getTime())
}

// Spellings of one genre share a key: "Rap/Hip Hop" and "Hip-Hop/Rap" →
// "hip hop rap"; "Turkish Pop" stays apart from "Pop".
export function genreFamilyKey(genre) {
  const words = String(genre || '').toLocaleLowerCase('tr').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return [...new Set(words)].sort().join(' ')
}

// URL-safe, stable id part: "Rap/Hip Hop" → "rap-hip-hop", "Özgün" → "özgün".
function genreSlug(genre) {
  return String(genre || '').toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/** Reorders so the same artist does not play twice in a row when avoidable. */
export function spreadArtists(rows) {
  const pending = rows.slice()
  const out = []
  while (pending.length) {
    const last = out.at(-1)?.artist_id
    const idx = pending.findIndex((r) => r.artist_id == null || r.artist_id !== last)
    out.push(pending.splice(idx === -1 ? 0 : idx, 1)[0])
  }
  return out
}

// ---- mixes ----------------------------------------------------------------------------

export function createMixes(db, { now = () => Date.now() } = {}) {
  const cache = new Map()

  function q(sql, ...params) { return db.prepare(sql).all(...params) }

  function vis(uid) { return visibleSql('t', uidLiteral(uid)) }

  // Base selection: visible track + this user's play count.
  // Deterministic order; randomness only through the seeded shuffle below.
  function tracks(uid, where, params, { order = 't.id', limit = 400 } = {}) {
    const u = uidLiteral(uid)
    return q(`SELECT t.id, t.title, t.artist_name, t.artist_id, t.album_id, t.genre, t.year, t.duration, COALESCE(ps.play_count, 0) AS plays
      FROM tracks t LEFT JOIN play_stats ps ON ps.track_id = t.id AND ps.user_id = ${u}
      WHERE ${vis(uid)} ${where ? `AND ${where}` : ''}
      ORDER BY ${order} LIMIT ${Number(limit)}`, ...params)
  }

  function seedArtists(uid, rnd) {
    const u = uidLiteral(uid)
    let rows = q(`SELECT t.artist_id AS id, ar.name, COUNT(*) AS plays FROM play_history h
      JOIN tracks t ON t.id = h.track_id JOIN artists ar ON ar.id = t.artist_id
      WHERE h.user_id = ${u} AND h.played_at >= ? AND ${vis(uid)}
      GROUP BY t.artist_id ORDER BY plays DESC LIMIT 40`, now() - 90 * DAY)
    if (rows.length < 3) {
      const fav = q(`SELECT ar.id, ar.name, 1 AS plays FROM favorites f JOIN tracks t ON t.id = f.item_id AND f.item_type = 'track'
        JOIN artists ar ON ar.id = t.artist_id WHERE f.user_id = ${u} AND ${vis(uid)} GROUP BY ar.id LIMIT 25`)
      rows = rows.concat(fav.filter((f) => !rows.some((r) => r.id === f.id)))
    }
    if (rows.length < 3) {
      // New listener: start from the biggest artists in the library.
      const big = q(`SELECT t.artist_id AS id, ar.name, 0 AS plays FROM tracks t JOIN artists ar ON ar.id = t.artist_id
        WHERE ${vis(uid)} GROUP BY t.artist_id HAVING COUNT(*) >= 3 ORDER BY COUNT(*) DESC, t.artist_id LIMIT 30`)
      rows = rows.concat(seededShuffle(big, rnd).filter((b) => !rows.some((r) => r.id === b.id)).slice(0, 12))
    }
    return rows
  }

  function pick(rows, rnd, n) { return seededShuffle(rows, rnd).slice(0, n) }

  function mainGenre(uid, artistId) {
    const row = db.prepare(`SELECT t.genre, COUNT(*) AS n FROM tracks t
      WHERE t.artist_id = ? AND ${GENRE_OK} AND ${vis(uid)}
      GROUP BY t.genre COLLATE NOCASE ORDER BY n DESC LIMIT 1`).get(artistId)
    return row?.genre || null
  }

  function finalize(rows, rnd, size = MIX_SIZE) {
    // One entry per song, even when it exists as several files.
    return spreadArtists(uniqueSongs(seededShuffle(rows, rnd))).slice(0, size)
  }

  function dailyMixes(uid, rnd) {
    const clusters = new Map()
    for (const artist of seedArtists(uid, rnd)) {
      const genre = mainGenre(uid, artist.id)
      const key = genre ? `g:${genre.toLowerCase()}` : `a:${artist.id}`
      const c = clusters.get(key) || { genre, artists: [], plays: 0 }
      c.artists.push(artist)
      c.plays += artist.plays
      clusters.set(key, c)
    }
    const out = []
    // Small artist-only groups (no usable genre) are pooled into one mix
    // instead of being dropped.
    const leftover = { genre: null, artists: [], plays: 0, pooled: true }
    const ordered = [...clusters.values()].sort((a, b) => b.plays - a.plays)
    for (const c of [...ordered, leftover]) {
      if (out.length >= DAILY_MIXES) break
      if (c === leftover && !c.artists.length) break
      const ids = c.artists.map((a) => a.id)
      const marks = ids.map(() => '?').join(',')
      const loved = tracks(uid, `t.artist_id IN (${marks})`, ids, { order: 'plays DESC, t.id', limit: 15 })
      const fresh = pick(tracks(uid, `t.artist_id IN (${marks}) AND COALESCE(ps.play_count, 0) <= 1`, ids), rnd, 12)
      const sameGenre = c.genre ? pick(tracks(uid, `t.genre = ? COLLATE NOCASE AND (t.artist_id IS NULL OR t.artist_id NOT IN (${marks}))`, [c.genre, ...ids]), rnd, 25) : []
      const rows = finalize([...loved, ...fresh, ...sameGenre], rnd)
      if (rows.length < 8) {
        if (!c.pooled) { leftover.artists.push(...c.artists); leftover.plays += c.plays }
        continue
      }
      out.push({
        id: `daily-${out.length + 1}`,
        kind: 'daily',
        titleKey: 'daily',
        titleVars: { n: out.length + 1 },
        genre: c.genre,
        // Each name once, also inside collaborations ("A, B" + "A" → A, B).
        artists: [...new Map(c.artists.flatMap((a) => artistCredits(a.name)).map((name) => [name.toLocaleLowerCase('tr'), name])).values()].slice(0, 4),
        trackIds: rows.map((r) => r.id),
      })
    }
    return out
  }

  // One mix per genre the user listens to (then the library's biggest
  // genres): their favourites in it and songs to discover, a few per artist.
  function genreMixes(uid, rnd) {
    const u = uidLiteral(uid)
    const rows = q(`SELECT t.genre, COUNT(*) AS n, COUNT(DISTINCT COALESCE(t.artist_id, t.artist_name)) AS artists,
        SUM(COALESCE((SELECT ps.play_count FROM play_stats ps WHERE ps.user_id = ${u} AND ps.track_id = t.id), 0)) AS plays
      FROM tracks t WHERE ${GENRE_OK} AND ${vis(uid)}
      GROUP BY t.genre`)
    const families = new Map()
    for (const row of rows) {
      const key = genreFamilyKey(row.genre)
      if (!key) continue
      const f = families.get(key) || { genres: [], name: row.genre, top: 0, n: 0, artists: 0, plays: 0 }
      f.genres.push(row.genre)
      if (row.n > f.top) { f.top = row.n; f.name = row.genre }
      f.n += row.n
      f.artists += row.artists
      f.plays += row.plays
      families.set(key, f)
    }
    const chosen = [...families.values()]
      .filter((f) => f.n >= GENRE_MIN_TRACKS && f.artists >= GENRE_MIN_ARTISTS)
      .sort((a, b) => b.plays - a.plays || b.n - a.n || a.name.localeCompare(b.name))
      .slice(0, GENRE_MIXES)
    const out = []
    const seen = new Set()
    for (const f of chosen) {
      const slug = genreSlug(f.name)
      if (!slug || seen.has(slug)) continue
      const marks = f.genres.map(() => '?').join(',')
      const where = `t.genre COLLATE NOCASE IN (${marks})`
      const perArtist = new Map()
      const capped = finalize([
        ...tracks(uid, where, f.genres, { order: 'plays DESC, t.id', limit: 12 }),
        ...pick(tracks(uid, where, f.genres, { limit: 2000 }), rnd, 120),
      ], rnd, 400).filter((r) => {
        const key = r.artist_id ?? r.artist_name
        perArtist.set(key, (perArtist.get(key) || 0) + 1)
        return perArtist.get(key) <= GENRE_PER_ARTIST
      })
      const trackIds = spreadArtists(capped).slice(0, MIX_SIZE).map((r) => r.id)
      if (trackIds.length < 8) continue
      seen.add(slug)
      out.push({ id: `genre-${slug}`, kind: 'genre', titleKey: 'genre', titleVars: { genre: f.name }, genre: f.name, artists: [], trackIds })
    }
    return out
  }

  function discoverMix(uid) {
    const rnd = seededRandom(`${uid}:discover:${weekKey(now())}`)
    const u = uidLiteral(uid)
    const genres = q(`SELECT t.genre FROM play_history h JOIN tracks t ON t.id = h.track_id
      WHERE h.user_id = ${u} AND ${GENRE_OK} AND ${vis(uid)}
      GROUP BY t.genre COLLATE NOCASE ORDER BY COUNT(*) DESC LIMIT 5`).map((r) => r.genre)
    let rows = []
    if (genres.length) {
      rows = pick(tracks(uid, `COALESCE(ps.play_count, 0) = 0 AND t.genre COLLATE NOCASE IN (${genres.map(() => '?').join(',')})`, genres, { limit: 2000 }), rnd, 60)
    }
    if (rows.length < 30) rows = rows.concat(pick(tracks(uid, 'COALESCE(ps.play_count, 0) = 0', [], { limit: 2000 }), rnd, 60))
    rows = finalize(rows, rnd, 30)
    if (rows.length < 8) return null
    return { id: 'discover', kind: 'discover', titleKey: 'discover', titleVars: {}, genre: null, artists: [], trackIds: rows.map((r) => r.id) }
  }

  function likedMix(uid, rnd) {
    const u = uidLiteral(uid)
    const rows = q(`SELECT t.id, t.title, t.artist_name, t.artist_id FROM favorites f JOIN tracks t ON t.id = f.item_id
      WHERE f.user_id = ${u} AND f.item_type = 'track' AND ${vis(uid)} ORDER BY t.id`)
    if (rows.length < 8) return null
    return { id: 'liked', kind: 'liked', titleKey: 'liked', titleVars: {}, genre: null, artists: [], trackIds: finalize(rows, rnd, 50).map((r) => r.id) }
  }

  function decadeMixes(uid, rnd) {
    const u = uidLiteral(uid)
    const decades = q(`SELECT (t.year / 10) * 10 AS decade, COUNT(*) AS n,
        SUM(COALESCE((SELECT ps.play_count FROM play_stats ps WHERE ps.user_id = ${u} AND ps.track_id = t.id), 0)) AS plays
      FROM tracks t WHERE t.year BETWEEN 1940 AND 2100 AND ${vis(uid)}
      GROUP BY decade HAVING n >= 15 ORDER BY plays DESC, n DESC LIMIT 3`)
    return decades.map((d) => {
      const rows = finalize([
        ...tracks(uid, 't.year BETWEEN ? AND ?', [d.decade, d.decade + 9], { order: 'plays DESC, t.id', limit: 12 }),
        ...pick(tracks(uid, 't.year BETWEEN ? AND ?', [d.decade, d.decade + 9], { limit: 2000 }), rnd, 40),
      ], rnd)
      return { id: `decade-${d.decade}`, kind: 'decade', titleKey: 'decade', titleVars: { decade: d.decade }, genre: null, artists: [], trackIds: rows.map((r) => r.id) }
    }).filter((m) => m.trackIds.length >= 8)
  }

  function build(uid) {
    const key = `${uid}:${localDayKey(now())}`
    const hit = cache.get(key)
    if (hit) return hit
    const rnd = seededRandom(key)
    const mixes = [...dailyMixes(uid, rnd), discoverMix(uid), likedMix(uid, rnd), ...decadeMixes(uid, rnd), ...genreMixes(uid, rnd)].filter(Boolean)
    for (const k of cache.keys()) if (k.startsWith(`${uid}:`)) cache.delete(k)
    cache.set(key, mixes)
    return mixes
  }

  /** Summaries with up to four distinct album covers for the mosaic. */
  function summarize(uid, mix) {
    const ids = mix.trackIds
    const rows = ids.length
      ? db.prepare(`SELECT t.id, t.album_id, t.duration FROM tracks t WHERE t.id IN (${ids.map(() => '?').join(',')}) AND ${vis(uid)}`).all(...ids)
      : []
    const byId = new Map(rows.map((r) => [r.id, r]))
    const covers = []
    for (const id of ids) {
      const r = byId.get(id)
      if (!r) continue
      const ref = r.album_id ? `album/${r.album_id}` : `track/${r.id}`
      if (!covers.includes(ref)) covers.push(ref)
      if (covers.length >= 4) break
    }
    const { trackIds, ...rest } = mix
    return { ...rest, trackCount: rows.length, duration: rows.reduce((s, r) => s + (Number(r.duration) || 0), 0), covers }
  }

  function list(uid) {
    return build(uid).map((m) => summarize(uid, m))
  }

  function get(uid, id) {
    const mix = build(uid).find((m) => m.id === String(id))
    return mix ? { ...summarize(uid, mix), trackIds: mix.trackIds } : null
  }

  return { list, get, invalidate: () => cache.clear() }
}
