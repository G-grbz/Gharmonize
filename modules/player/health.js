// Library health (admin): the same song more than once, albums without a
// cover, files without tags, low-bitrate files — and safe fixes:
//  - a duplicate goes to a trash folder in the player data (not deleted),
//  - a missing cover is fetched from Deezer and saved as cover.jpg next to
//    the album's files (the audio files are not touched),
//  - a low-bitrate song is downloaded again in better quality.
// The check reads files (covers), so it runs as a background job.

import fs from 'node:fs'
import path from 'node:path'
import { songKey } from './songKey.js'
import { albumBaseKey, artistsMatch } from './matching.js'

const LOW_BITRATE = 160_000
const DUPLICATE_SECONDS = 4
const LIST_MAX = 500
const COVER_HOSTS = /^https:\/\/[a-z0-9.-]+\.(dzcdn\.net|deezer\.com)\//i

export class HealthError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function trackSummary(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist_name,
    album: row.album_title,
    albumId: row.album_id,
    duration: row.duration,
    bitrate: row.bitrate,
    codec: row.codec,
    lossless: Boolean(row.lossless),
    size: row.size,
    path: row.rel_path,
    library: row.library_name
  }
}

// Best copy first: lossless, then bitrate, then size.
function quality(row) {
  return (row.lossless ? 1e12 : 0) + (Number(row.bitrate) || 0) * 1000 + (Number(row.size) || 0) / 1e6
}

/** Groups of the same song (same title + artist, about the same length). */
export function findDuplicates(rows) {
  const byKey = new Map()
  for (const row of rows) {
    const key = songKey(row.title, row.artist_name)
    if (!key) continue
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(row)
  }
  const groups = []
  for (const list of byKey.values()) {
    if (list.length < 2) continue
    const sorted = [...list].sort((a, b) => (Number(a.duration) || 0) - (Number(b.duration) || 0))
    let cluster = [sorted[0]]
    const flush = () => { if (cluster.length > 1) groups.push(cluster.sort((a, b) => quality(b) - quality(a))) }
    for (const row of sorted.slice(1)) {
      const prev = cluster[cluster.length - 1]
      if (Math.abs((Number(row.duration) || 0) - (Number(prev.duration) || 0)) <= DUPLICATE_SECONDS) cluster.push(row)
      else { flush(); cluster = [row] }
    }
    flush()
  }
  return groups
}

export function createLibraryHealth({ db, libraries, artwork, scanner, sources, bridge, online, trashDir, logger = console, now = () => Date.now(), fetchImpl = fetch }) {
  let job = null
  let report = null

  const rowsSql = `SELECT t.*, l.name AS library_name FROM tracks t JOIN libraries l ON l.id = t.library_id WHERE l.enabled = 1`

  function status() {
    return { running: Boolean(job), progress: job?.progress || null, report }
  }

  // Starts a check (one at a time). `userId`: the admin (cover visibility).
  function start(userId) {
    if (job) return status()
    job = { progress: { phase: 'tracks', done: 0, total: 0 } }
    run(userId).then((r) => { report = r }).catch((error) => {
      logger.warn?.(`⚠️ [player] library health check failed: ${error?.message || error}`)
      report = { error: String(error?.message || error), checkedAt: now() }
    }).finally(() => { job = null })
    return status()
  }

  async function run(userId) {
    const rows = db.prepare(rowsSql).all()
    const duplicates = findDuplicates(rows).slice(0, LIST_MAX)
    const lowBitrate = rows.filter((r) => !r.lossless && r.bitrate > 0 && r.bitrate < LOW_BITRATE)
      .sort((a, b) => a.bitrate - b.bitrate).slice(0, LIST_MAX).map(trackSummary)
    const untagged = rows.filter((r) => {
      const artist = String(r.artist_name || '').trim()
      return !artist || /^unknown artist$/i.test(artist) || !String(r.album_title || '').trim()
    }).slice(0, LIST_MAX).map(trackSummary)

    const albums = db.prepare(`SELECT a.id, a.title, ar.name AS artist, COUNT(t.id) AS track_count FROM albums a
      JOIN tracks t ON t.album_id = a.id JOIN libraries l ON l.id = t.library_id AND l.enabled = 1
      LEFT JOIN artists ar ON ar.id = a.artist_id GROUP BY a.id ORDER BY a.title COLLATE NOCASE`).all()
    job.progress = { phase: 'covers', done: 0, total: albums.length }
    const missingCovers = []
    for (const album of albums) {
      let has = true
      try { has = await artwork.albumHasCover(album.id, userId) } catch {}
      if (!has && missingCovers.length < LIST_MAX) missingCovers.push({ id: album.id, title: album.title, artist: album.artist, trackCount: album.track_count })
      job.progress.done += 1
    }
    return {
      checkedAt: now(),
      totals: { tracks: rows.length, albums: albums.length },
      duplicates: duplicates.map((group) => group.map(trackSummary)),
      missingCovers,
      untagged,
      lowBitrate
    }
  }

  // ---- fixes ----------------------------------------------------------------------------

  function trackRow(trackId) {
    const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(Number(trackId))
    if (!row) throw new HealthError('NOT_FOUND', 'Song not found.', 404)
    return row
  }

  async function moveFile(from, to) {
    await fs.promises.mkdir(path.dirname(to), { recursive: true })
    try {
      await fs.promises.rename(from, to)
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
      await fs.promises.copyFile(from, to)
      await fs.promises.unlink(from)
    }
  }

  /** Moves a song's file into the trash folder and drops it from the library. */
  async function trash(trackId) {
    const row = trackRow(trackId)
    const abs = libraries.resolveTrackFile(row)
    if (!abs) throw new HealthError('FILE_UNAVAILABLE', 'The file is not inside an enabled library.', 409)
    const day = new Date(now()).toISOString().slice(0, 10)
    let target = path.join(trashDir, day, String(row.library_id), row.rel_path)
    for (let i = 2; fs.existsSync(target) && i < 100; i += 1) {
      const ext = path.extname(row.rel_path)
      target = path.join(trashDir, day, String(row.library_id), `${row.rel_path.slice(0, -ext.length || undefined)} (${i})${ext}`)
    }
    await moveFile(abs, target)
    scanner.forgetTracks([row.id])
    if (report) {
      report.duplicates = report.duplicates.map((g) => g.filter((t) => t.id !== row.id)).filter((g) => g.length > 1)
      report.lowBitrate = report.lowBitrate.filter((t) => t.id !== row.id)
      report.untagged = report.untagged.filter((t) => t.id !== row.id)
    }
    logger.log?.(`🗑️ [player] moved ${row.rel_path} to the player trash`)
    return { ok: true, trashedTo: path.relative(trashDir, target) }
  }

  /** Finds the album on Deezer and saves its cover as cover.jpg in the album folder. */
  async function fixCover(albumId) {
    const album = db.prepare(`SELECT a.id, a.title, ar.name AS artist FROM albums a LEFT JOIN artists ar ON ar.id = a.artist_id WHERE a.id = ?`).get(Number(albumId))
    if (!album) throw new HealthError('NOT_FOUND', 'Album not found.', 404)
    const tracks = db.prepare('SELECT * FROM tracks WHERE album_id = ?').all(album.id)
    const dirs = [...new Set(tracks.map((t) => libraries.resolveTrackFile(t)).filter(Boolean).map((f) => path.dirname(f)))]
    if (dirs.length !== 1) throw new HealthError('ALBUM_FOLDERS', 'The album is spread over several folders; add a cover by hand.', 409)
    const want = albumBaseKey(album.title)
    const found = (await Promise.resolve().then(() => sources.deezer.searchAlbums(`${album.artist || ''} ${album.title}`.trim(), 10)).catch(() => []) || [])
      .find((a) => albumBaseKey(a.title) === want && (!album.artist || artistsMatch(a.artist, album.artist)))
    if (!found?.artworkUrl || !COVER_HOSTS.test(found.artworkUrl)) throw new HealthError('COVER_NOT_FOUND', 'No cover was found for this album.', 404)
    const res = await fetchImpl(found.artworkUrl, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new HealthError('COVER_DOWNLOAD_FAILED', `Cover download failed (HTTP ${res.status}).`, 502)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length < 1000 || bytes.length > 15 * 1024 * 1024) throw new HealthError('COVER_DOWNLOAD_FAILED', 'The cover file looks wrong.', 502)
    const target = path.join(dirs[0], 'cover.jpg')
    if (fs.existsSync(target)) throw new HealthError('COVER_EXISTS', 'cover.jpg already exists in the album folder.', 409)
    await fs.promises.writeFile(target, bytes, { flag: 'wx' })
    artwork.invalidate()
    if (report) report.missingCovers = report.missingCovers.filter((a) => a.id !== album.id)
    return { ok: true, source: found.url || null }
  }

  /** Downloads a better copy of a song (the old one then shows up as a duplicate). */
  async function redownload(user, trackId) {
    const row = trackRow(trackId)
    const res = await online.search(`${row.artist_name || ''} ${row.title}`.trim(), { kinds: ['track'], limit: 5, only: ['deezer', 'spotify'] })
    const match = (res.tracks || []).find((t) => artistsMatch(t.artist, row.artist_name || '') && songKey(t.title, t.artist) === songKey(row.title, row.artist_name))
    if (!match) throw new HealthError('NO_MATCH', 'This song was not found online.', 404)
    return bridge.request(user, { ...match, kind: 'track' }, { force: true })
  }

  return { status, start, trash, fixCover, redownload }
}
