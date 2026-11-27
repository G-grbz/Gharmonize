// Library health (admin): the same song more than once, albums without a
// cover, files without tags, low-bitrate files — and safe fixes:
//  - a duplicate goes to a trash folder in the player data (not deleted),
//  - a missing cover is fetched from Deezer and saved as cover.jpg next to
//    the album's files (the audio files are not touched),
//  - a low-bitrate song is downloaded again in better quality; once the new
//    copy is verified, the old one goes to the trash and the new one takes
//    its file name,
//  - lyrics files are kept as "Song.lrc" next to the song (the format every
//    player reads): other formats are renamed, extra and orphaned lyrics go
//    to the trash, and missing lyrics are looked up on LRCLIB.
// The check reads files (covers), so it runs as a background job.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { artistCredits, songKey } from './songKey.js'
import { albumBaseKey, artistsMatch, sameRecordingLength } from './matching.js'
import { getSetting, setSetting, transaction } from './db.js'
import { encodeSidecarLyrics, hasLyricsTimestamps } from './lyrics.js'
import { AUDIO_EXTENSIONS } from './scanner.js'
import { youtubeSourceKey } from './sourceKey.js'

// Covers are saved as cover.jpg: only real JPEG data is written.
function isJpeg(bytes) {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

const LOW_BITRATE = 160_000
const DUPLICATE_SECONDS = 4
// A quality upgrade may come from another release of the same song: rips and
// album/radio versions often differ by a few seconds of fade or silence.
const UPGRADE_SECONDS = 10
const UPGRADE_RATIO = 0.07
// Lyrics files next to a song (same name). ".lyrics" is written by other
// taggers; the player reads .lrc and .txt.
const SIDECAR_EXTENSIONS = ['.lrc', '.LRC', '.txt', '.lyrics']
const LYRICS_EXTENSION = '.lrc'
const LYRICS_PAUSE_MS = 250

function stemOf(name) {
  return path.parse(name).name
}

function isAudioName(name) {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())
}

function isLyricsName(name) {
  return ['.lrc', '.txt', '.lyrics'].includes(path.extname(name).toLowerCase())
}

// "Song (2)" → "Song": the name a copy got because "Song" was taken.
function baseStem(stem) {
  return stem.replace(/ \(\d+\)$/, '')
}
const LIST_MAX = 500
// "download-better" is the older name of "replace-copies" (saved batches, API).
const BATCH_ACTIONS = new Set(['keep-best', 'trash-selected', 'download-better', 'replace-copies', 'add-covers', 'lyrics-fetch', 'lyrics-tidy'])
// "replace-with": one song replaced by a source the admin chose (replaceWith).
const DOWNLOAD_ACTIONS = new Set(['download-better', 'replace-copies', 'replace-with'])
const LYRICS_ACTIONS = new Set(['lyrics-fetch', 'lyrics-tidy'])
// Long batches: they can be paused and canceled, and resume after a restart.
const CONTROL_ACTIONS = new Set([...DOWNLOAD_ACTIONS, ...LYRICS_ACTIONS])
const CHECKPOINT = 'health_download_batch'
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

function upgradeTarget(row) {
  return { libraryId: row.library_id, folder: path.dirname(row.rel_path) }
}

function upgradeTolerance(original) {
  return Math.max(UPGRADE_SECONDS, original * UPGRADE_RATIO)
}

function matchesUpgradeDuration(duration, original, provider, force = false) {
  if (force) return true
  if (!(duration > 0 && original > 0)) return false
  const tolerance = upgradeTolerance(original)
  if (Math.abs(duration - original) <= tolerance) return true
  // A provider can list 291 seconds for a file measuring 291.744 seconds.
  return Math.floor(duration) === provider && Math.abs(provider - original) <= tolerance
}

function clock(seconds) {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// The new copy only has to be better than the old one: lossless over lossy,
// otherwise a higher bitrate. Without the old bitrate (older saved batches)
// the low-bitrate limit is the bar.
function betterThan(row, original) {
  if (row.lossless) return !original.lossless
  if (original.lossless) return false
  if (original.bitrate > 0) return row.bitrate > original.bitrate
  return row.bitrate >= LOW_BITRATE
}

function matchesUpgradePreset(row, { downloadFormat, downloadBitrate }) {
  if (path.extname(row.rel_path).toLowerCase() !== `.${downloadFormat}`) return false
  if (downloadBitrate === 'auto') return true
  if (downloadBitrate === 'lossless') return Boolean(row.lossless)
  return Math.abs(row.bitrate - Number.parseInt(downloadBitrate, 10) * 1000) <= 1000
}

// Are two files of the same song (same title + artist) copies of each other?
// The album is the album tag, never the folder: a song in "Karışık" and in
// "Başım Belada" tagged with the same album is one album song twice, while
// the same title on two albums can be another recording (a live take, a
// re-recording) even in one folder. Like the download side's library check:
//  - same album tag (edition names aside): about the same length;
//  - an album tag missing on one side: practically the same length (or the
//    same source video), and not two different ISRCs;
//  - two different album tags: not copies.
function sameCopy(a, b) {
  const da = Number(a.duration) || 0
  const db = Number(b.duration) || 0
  const albumA = albumBaseKey(a.album_title)
  const albumB = albumBaseKey(b.album_title)
  if (albumA && albumB) return albumA === albumB && Math.abs(da - db) <= DUPLICATE_SECONDS
  const isrcA = String(a.isrc || '').trim().toUpperCase()
  const isrcB = String(b.isrc || '').trim().toUpperCase()
  if (isrcA && isrcB && isrcA !== isrcB) return false
  return Boolean(a.source_key && a.source_key === b.source_key) || sameRecordingLength(da, db)
}

/** Groups of copies of the same song (see sameCopy), best copy first. */
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
    // Best files first, so each group is built around the copy it keeps; a
    // file joins a group only when it is a copy of every file in it (a file
    // without an album tag must not tie two albums together).
    const clusters = []
    for (const row of [...list].sort((a, b) => quality(b) - quality(a))) {
      const home = clusters.find((cluster) => cluster.every((other) => sameCopy(row, other)))
      if (home) home.push(row)
      else clusters.push([row])
    }
    for (const cluster of clusters) if (cluster.length > 1) groups.push(cluster)
  }
  return groups
}

export function createLibraryHealth({ db, libraries, artwork, scanner, sources, bridge, online, trashDir, getUser, getConfig, fetchLyrics = null, onLyricsChanged = () => {}, logger = console, now = () => Date.now(), fetchImpl = fetch }) {
  let job = null
  let report = null
  // Every lyrics finding of the last check (the report lists at most LIST_MAX).
  let lyricsFound = { missing: [], tidy: [] }
  let batch = null
  let batchPromise = null
  let batchWork = null
  let singleFixes = 0
  let emptyingTrash = false

  const rowsSql = `SELECT t.*, l.name AS library_name FROM tracks t JOIN libraries l ON l.id = t.library_id WHERE l.enabled = 1`

  function status() {
    return { running: Boolean(job), progress: job?.progress || null, report, batch: batch && { ...batch, current: currentItem() }, trashPath: path.resolve(trashDir) }
  }

  // The song a download batch is working on and how far its download is.
  function currentItem() {
    if (!batch?.running || !batch.canControl || !batch.currentTitle || !batchWork) return null
    const item = batchWork.items[batch.done]
    const track = item?.tracks?.[0] || { artist_name: item?.artist, rel_path: item?.path }
    let download = null
    if (batchWork.download) {
      try {
        const d = bridge.get(batchWork.download.id, batchWork.user)
        download = { status: d.status, phase: d.phase, progress: d.progress }
      } catch {}
    }
    return { title: batch.currentTitle, artist: track?.artist_name || null, path: track?.rel_path || null, download }
  }

  // Starts a check (one at a time). `userId`: the admin (cover visibility).
  function start(userId) {
    if (job || batchPromise || singleFixes || emptyingTrash) return status()
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
    lyricsFound = await scanLyrics(rows)
    return {
      checkedAt: now(),
      totals: { tracks: rows.length, albums: albums.length },
      duplicates: duplicates.map((group) => group.map(trackSummary)),
      missingCovers,
      untagged,
      lowBitrate,
      lyrics: lyricsReport()
    }
  }

  // ---- lyrics files ---------------------------------------------------------------------

  function lyricsReport() {
    return {
      missing: lyricsFound.missing.slice(0, LIST_MAX),
      missingCount: lyricsFound.missing.length,
      tidy: lyricsFound.tidy.slice(0, LIST_MAX).map(tidySummary),
      tidyCount: lyricsFound.tidy.length
    }
  }

  function tidySummary(item) {
    return { id: item.id, kind: item.kind, title: item.title, library: item.library, path: path.join(item.dir, item.files[0]), files: item.files, target: item.target }
  }

  // The best lyrics file first: synced, then already ".lrc", then the larger one.
  async function rankLyrics(dir, names) {
    const scored = await Promise.all(names.map(async (name) => {
      let text = ''
      try {
        const handle = await fs.promises.open(path.join(dir, name), 'r')
        try {
          const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(64 * 1024), position: 0 })
          text = buffer.toString('utf8', 0, bytesRead)
        } finally { await handle.close() }
      } catch {}
      return { name, score: (hasLyricsTimestamps(text) ? 4 : 0) + (path.extname(name) === LYRICS_EXTENSION ? 2 : 0), size: text.length }
    }))
    return scored.sort((a, b) => b.score - a.score || b.size - a.size).map((entry) => entry.name)
  }

  async function scanLyrics(rows) {
    const folders = new Map()
    for (const row of rows) {
      const file = libraries.resolveTrackFile(row)
      if (!file) continue
      const dir = path.dirname(file)
      if (!folders.has(dir)) folders.set(dir, [])
      folders.get(dir).push({ row, stem: stemOf(file) })
    }
    job.progress = { phase: 'lyrics', done: 0, total: folders.size }
    const missing = []
    const tidy = []
    let nextId = 1
    for (const [dir, songs] of folders) {
      job.progress.done += 1
      let entries
      try { entries = await fs.promises.readdir(dir) } catch { continue }
      const audio = new Set(entries.filter(isAudioName).map(stemOf))
      const lyricsByStem = new Map()
      for (const name of entries.filter(isLyricsName)) {
        const stem = stemOf(name)
        if (!lyricsByStem.has(stem)) lyricsByStem.set(stem, [])
        lyricsByStem.get(stem).push(name)
      }
      const { row: first } = songs[0]
      const relDir = path.dirname(first.rel_path)
      const songByStem = new Map(songs.map((song) => [song.stem, song.row]))
      const add = (kind, files, extra = {}) => tidy.push({
        id: nextId++, kind, files, libraryId: first.library_id, library: first.library_name, dir: relDir, target: null, title: files[0], ...extra
      })
      const adopted = new Set()

      // Lyrics without a song of the same name.
      for (const [stem, names] of lyricsByStem) {
        if (audio.has(stem)) continue
        const base = baseStem(stem)
        const ofCopy = base !== stem && audio.has(base)
        for (const name of names) {
          // A text file is lyrics only when it is named after a song.
          if (path.extname(name).toLowerCase() === '.txt' && !ofCopy) continue
          const song = songByStem.get(base)
          if (ofCopy && !lyricsByStem.has(base) && !song?.has_lyrics && !adopted.has(base)) {
            adopted.add(base)
            add('adopt', [name], { target: base + LYRICS_EXTENSION, title: song?.title || base })
          } else add(ofCopy ? 'copy' : 'orphan', [name])
        }
      }

      const seen = new Set()
      for (const { row, stem } of songs) {
        if (seen.has(stem)) continue
        seen.add(stem)
        const names = lyricsByStem.get(stem) || []
        if (!names.length) {
          if (!row.has_lyrics && !adopted.has(stem)) missing.push(trackSummary(row))
        } else if (names.length > 1) {
          add('duplicates', await rankLyrics(dir, names), { target: stem + LYRICS_EXTENSION, title: row.title })
        } else if (path.extname(names[0]) !== LYRICS_EXTENSION) {
          add('convert', names, { target: stem + LYRICS_EXTENSION, title: row.title })
        }
      }
    }
    return { missing, tidy }
  }

  function lyricsPath(item, name) {
    return libraries.resolveTrackFile({ library_id: item.libraryId, rel_path: path.join(item.dir, name) })
  }

  async function trashLyricsFile(item, name) {
    const file = lyricsPath(item, name)
    if (!file || !fs.existsSync(file)) return
    await moveFile(file, trashTarget({ library_id: item.libraryId, rel_path: path.join(item.dir, name) }))
  }

  // "Song.LRC" → "Song.lrc" also works where names ignore case.
  async function renameLyrics(from, to) {
    if (from === to) return
    if (from.toLowerCase() === to.toLowerCase()) {
      const temporary = `${to}.${randomUUID()}.tmp`
      await fs.promises.rename(from, temporary)
      await fs.promises.rename(temporary, to)
      return
    }
    if (fs.existsSync(to)) throw new HealthError('LYRICS_TARGET_EXISTS', 'A lyrics file with the new name already exists.', 409)
    await fs.promises.rename(from, to)
  }

  async function tidyLyrics(item) {
    const files = item.files.filter((name) => {
      const file = lyricsPath(item, name)
      return file && fs.existsSync(file)
    })
    if (!files.length) throw new HealthError('FILE_UNAVAILABLE', 'The lyrics file is no longer there.', 409)
    if (item.kind === 'orphan' || item.kind === 'copy') {
      for (const name of files) await trashLyricsFile(item, name)
    } else if (item.kind === 'adopt' || item.kind === 'convert') {
      const to = lyricsPath(item, item.target)
      if (item.kind === 'adopt' && fs.existsSync(to)) await trashLyricsFile(item, files[0])
      else await renameLyrics(lyricsPath(item, files[0]), to)
    } else if (item.kind === 'duplicates') {
      const [keep, ...extra] = item.files
      if (!files.includes(keep)) throw new HealthError('FILE_UNAVAILABLE', 'The lyrics file is no longer there.', 409)
      for (const name of extra) await trashLyricsFile(item, name)
      await renameLyrics(lyricsPath(item, keep), lyricsPath(item, item.target))
    }
    onLyricsChanged()
  }

  async function fetchMissingLyrics(item, signal) {
    const row = existingTrack.get(item.id)
    const file = row && libraries.resolveTrackFile(row)
    if (!file || !fs.existsSync(file)) throw new HealthError('FILE_UNAVAILABLE', 'The original file is no longer available.', 409)
    const { dir, name } = path.parse(file)
    if (row.has_lyrics || SIDECAR_EXTENSIONS.some((ext) => fs.existsSync(path.join(dir, name + ext)))) return
    const fetcher = fetchLyrics || (async (artist, title, duration) => {
      const { lyricsFetcher } = await import('../lyrics.js')
      return lyricsFetcher.searchLyrics(artist, title, duration)
    })
    let sidecar = null
    for (const artist of new Set([row.artist_name, artistCredits(row.artist_name)[0]].filter(Boolean))) {
      const found = await fetcher(artist, row.title, row.duration)
      signal.throwIfAborted()
      sidecar = encodeSidecarLyrics(found?.syncedLyrics, { synced: true }) || encodeSidecarLyrics(found?.plainLyrics)
      if (sidecar) break
    }
    // LRCLIB is a free service: one song at a time, with a short pause.
    await delay(LYRICS_PAUSE_MS, undefined, { signal, ref: false })
    if (!sidecar) throw new HealthError('LYRICS_NOT_FOUND', 'No lyrics were found online for this song.', 404)
    try {
      await fs.promises.writeFile(path.join(dir, name + LYRICS_EXTENSION), sidecar, { flag: 'wx', mode: 0o644 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    onLyricsChanged()
  }

  function forgetLyricsItem(action, id) {
    const key = action === 'lyrics-fetch' ? 'missing' : 'tidy'
    lyricsFound[key] = lyricsFound[key].filter((item) => item.id !== id)
    if (report?.lyrics) report.lyrics = lyricsReport()
  }

  // ---- fixes ----------------------------------------------------------------------------

  function trackRow(trackId) {
    const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(Number(trackId))
    if (!row) throw new HealthError('NOT_FOUND', 'Song not found.', 404)
    return row
  }

  async function moveFile(from, to, expected) {
    const destination = path.dirname(to)
    const created = await fs.promises.mkdir(destination, { recursive: true })
    const syncDestination = async () => {
      for (let dir = destination; ; dir = path.dirname(dir)) {
        await syncDirectory(dir)
        if (!created || dir === path.dirname(created)) break
      }
    }
    if (expected && !matchesFile(expected, from)) throw replacementChanged()
    try {
      await fs.promises.rename(from, to)
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
      const partial = `${to}.partial`
      try {
        await fs.promises.copyFile(from, partial)
        const file = await fs.promises.open(partial, 'r+')
        try { await file.sync() } finally { await file.close() }
        if (expected && !matchesFile(expected, from)) throw replacementChanged()
        await fs.promises.rename(partial, to)
        await syncDestination()
        await fs.promises.unlink(from)
      } finally {
        await fs.promises.unlink(partial).catch(() => {})
      }
      await syncDirectory(path.dirname(from))
      return
    }
    await syncDestination()
    await syncDirectory(path.dirname(from))
  }

  async function syncDirectory(dir) {
    if (process.platform === 'win32') return
    const folder = await fs.promises.open(dir, 'r')
    try { await folder.sync() } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error
    } finally { await folder.close() }
  }

  function trashTarget(row) {
    const day = new Date(now()).toISOString().slice(0, 10)
    const target = path.join(trashDir, day, String(row.library_id), row.rel_path)
    if (!fs.existsSync(target)) return target
    const { dir, name, ext } = path.parse(target)
    return path.join(dir, `${name} (${randomUUID()})${ext}`)
  }

  function forgetTrashed(row) {
    if (existingTrack.get(row.id)) scanner.forgetTracks([row.id])
    if (report && !report.error) {
      report.duplicates = report.duplicates.map((g) => g.filter((t) => t.id !== row.id)).filter((g) => g.length > 1)
      report.lowBitrate = report.lowBitrate.filter((t) => t.id !== row.id)
      report.untagged = report.untagged.filter((t) => t.id !== row.id)
    }
    logger.log?.(`🗑️ [player] moved ${row.rel_path} to the player trash`)
  }

  /** Moves a song's file into the trash folder and drops it from the library. */
  async function trash(trackId) {
    const row = trackRow(trackId)
    const abs = libraries.resolveTrackFile(row)
    if (!abs) throw new HealthError('FILE_UNAVAILABLE', 'The file is not inside an enabled library.', 409)
    const target = trashTarget(row)
    await moveFile(abs, target)
    await trashLyrics(abs, target)
    forgetTrashed(row)
    return { ok: true, trashedTo: path.relative(trashDir, target) }
  }

  // Lyrics files of a song moved to the trash ("Song.lrc", "Song.lyrics"…)
  // follow it, unless another audio file of the same name (Song.flac next to
  // Song.mp3) still uses them.
  async function trashLyrics(file, archived) {
    const { dir, name } = path.parse(file)
    const entries = await fs.promises.readdir(dir).catch(() => [])
    const shared = entries.some((entry) => {
      const parsed = path.parse(entry)
      return parsed.name === name && AUDIO_EXTENSIONS.has(parsed.ext.toLowerCase())
    })
    if (shared) return
    const into = path.parse(archived)
    for (const ext of SIDECAR_EXTENSIONS) {
      if (!entries.includes(name + ext)) continue
      await moveFile(path.join(dir, name + ext), path.join(into.dir, into.name + ext)).catch((error) => {
        logger.warn?.(`⚠️ [player] could not move ${name + ext} to the player trash: ${error?.message || error}`)
      })
    }
  }

  async function emptyTrash() {
    if (job || batchPromise || singleFixes || emptyingTrash) {
      throw new HealthError('HEALTH_BUSY', 'A library health operation is already running.', 409)
    }
    emptyingTrash = true
    try {
      const dir = await fs.promises.lstat(trashDir).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!dir) return { ok: true }
      if (!dir.isDirectory()) throw new HealthError('TRASH_UNAVAILABLE', 'The player trash folder is unavailable.', 409)
      for (const name of await fs.promises.readdir(trashDir)) {
        await fs.promises.rm(path.join(trashDir, name), { recursive: true, force: true })
      }
      return { ok: true }
    } finally {
      emptyingTrash = false
    }
  }

  /** Finds the album on Deezer and saves its cover as cover.jpg in the album folder. */
  async function fixCover(albumId, signal) {
    const album = db.prepare(`SELECT a.id, a.title, ar.name AS artist FROM albums a LEFT JOIN artists ar ON ar.id = a.artist_id WHERE a.id = ?`).get(Number(albumId))
    if (!album) throw new HealthError('NOT_FOUND', 'Album not found.', 404)
    const tracks = db.prepare('SELECT * FROM tracks WHERE album_id = ?').all(album.id)
    const dirs = [...new Set(tracks.map((t) => libraries.resolveTrackFile(t)).filter(Boolean).map((f) => path.dirname(f)))]
    if (dirs.length !== 1) throw new HealthError('ALBUM_FOLDERS', 'The album is spread over several folders; add a cover by hand.', 409)
    const want = albumBaseKey(album.title)
    const found = (await Promise.resolve().then(() => sources.deezer.searchAlbums(`${album.artist || ''} ${album.title}`.trim(), 10)).catch(() => []) || [])
      .find((a) => albumBaseKey(a.title) === want && (!album.artist || artistsMatch(a.artist, album.artist)))
    signal?.throwIfAborted()
    if (!found?.artworkUrl || !COVER_HOSTS.test(found.artworkUrl)) throw new HealthError('COVER_NOT_FOUND', 'No cover was found for this album.', 404)
    const timeout = AbortSignal.timeout(15_000)
    const res = await fetchImpl(found.artworkUrl, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout })
    if (!res.ok) throw new HealthError('COVER_DOWNLOAD_FAILED', `Cover download failed (HTTP ${res.status}).`, 502)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length < 1000 || bytes.length > 15 * 1024 * 1024) throw new HealthError('COVER_DOWNLOAD_FAILED', 'The cover file looks wrong.', 502)
    if (!isJpeg(bytes)) throw new HealthError('COVER_DOWNLOAD_FAILED', 'The cover file looks wrong.', 502)
    const target = path.join(dirs[0], 'cover.jpg')
    // "wx" fails when the file exists, so there is no check-then-write gap.
    try {
      await fs.promises.writeFile(target, bytes, { flag: 'wx' })
    } catch (error) {
      if (error?.code === 'EEXIST') throw new HealthError('COVER_EXISTS', 'cover.jpg already exists in the album folder.', 409)
      throw error
    }
    artwork.invalidate()
    if (report) report.missingCovers = report.missingCovers.filter((a) => a.id !== album.id)
    return { ok: true, source: found.url || null }
  }

  /** Replaces one song with a better copy (a batch of one, with its progress). */
  function redownload(user, trackId) {
    trackRow(trackId)
    return startBatch(user, { action: 'replace-copies', ids: [Number(trackId)] })
  }

  async function requestBetter(user, row, { signal, onRequested, force = false } = {}) {
    // Only the main artist: "A, Various Artists Song" finds nothing.
    const artist = artistCredits(row.artist_name)[0] || ''
    const res = await online.search(`${artist} ${row.title}`.trim(), { kinds: ['track'], limit: 10, only: ['deezer', 'spotify'] })
    signal?.throwIfAborted()
    const candidates = (res.tracks || []).filter((t) =>
      artistsMatch(t.artist, row.artist_name || '') && songKey(t.title, t.artist) === songKey(row.title, row.artist_name))
    const gap = (t) => t.duration > 0 && row.duration > 0 ? Math.abs(t.duration - row.duration) : Infinity
    candidates.sort((a, b) => gap(a) - gap(b))
    const match = force ? candidates[0] : candidates.find((t) => gap(t) <= upgradeTolerance(row.duration) || gap(t) === Infinity)
    if (!match && candidates.length) {
      const error = new HealthError('LENGTH_MISMATCH', `Found online, but its length differs too much (${clock(row.duration)} here, ${clock(candidates[0].duration)} online).`, 404)
      error.detail = `${clock(row.duration)} ↔ ${clock(candidates[0].duration)}`
      throw error
    }
    if (!match) throw new HealthError('NO_MATCH', 'This song was not found online.', 404)
    return requestInto(user, row, match, { signal, onRequested })
  }

  // Downloads `source` into the folder of `row` (it waits while the user's
  // download queue is full).
  async function requestInto(user, row, source, { signal, onRequested } = {}) {
    for (;;) {
      signal?.throwIfAborted()
      try {
        return await bridge.request(user, { ...source, kind: 'track' }, { force: true, signal, onRequested, upgrade: upgradeTarget(row) })
      } catch (error) {
        if (!signal || error.code !== 'TOO_MANY_DOWNLOADS') throw error
        await delay(750, undefined, { signal, ref: false })
      }
    }
  }

  // A link to one song: a YouTube (Music) video, or a Deezer, Spotify or
  // Apple Music track. A YouTube link is reduced to its video (no playlist).
  function replacementSource(source = {}) {
    let link
    try { link = new URL(String(source.url || '').trim()) } catch { link = null }
    const invalid = () => new HealthError('INVALID_REPLACEMENT_URL', 'Use a link to one song (YouTube, YouTube Music, Deezer, Spotify or Apple Music).')
    if (link?.protocol !== 'https:') throw invalid()
    const host = link.hostname.toLowerCase()
    const video = youtubeSourceKey(link.href)?.slice('youtube:'.length)
    const store = (/(^|\.)deezer\.com$/.test(host) && /\/track\/\d+/.test(link.pathname)) ||
      (host === 'open.spotify.com' && /\/track\/[A-Za-z0-9]+/.test(link.pathname)) ||
      (host === 'music.apple.com' && /^\d+$/.test(link.searchParams.get('i') || ''))
    if (!video && !store) throw invalid()
    const text = (value) => String(value ?? '').trim().slice(0, 300) || null
    return {
      url: video ? `https://music.youtube.com/watch?v=${video}` : link.href,
      title: text(source.title),
      artist: text(source.artist),
      duration: Number(source.duration) > 0 ? Number(source.duration) : null,
      artworkUrl: /^https:\/\//i.test(String(source.artworkUrl || '')) ? String(source.artworkUrl).slice(0, 1000) : null
    }
  }

  /** Replaces one song with a source the admin chose (a batch of one). */
  function replaceWith(user, trackId, source) {
    const row = trackRow(trackId)
    const chosen = replacementSource(source)
    const file = libraries.resolveTrackFile(row)
    if (!file || !fs.existsSync(file)) throw new HealthError('FILE_UNAVAILABLE', 'The original file is no longer available.', 409)
    const item = {
      id: row.id, title: row.title, source: chosen,
      tracks: [{
        id: row.id, library_id: row.library_id, rel_path: row.rel_path, file, title: row.title, artist_name: row.artist_name,
        duration: row.duration, size: row.size, mtime_ms: row.mtime_ms, bitrate: row.bitrate, lossless: row.lossless, added_at: row.added_at
      }]
    }
    return startBatch(user, { action: 'replace-with', ids: [row.id] }, [item])
  }

  const existingTrack = db.prepare('SELECT * FROM tracks WHERE id = ?')

  function batchItems(action, ids) {
    const wanted = ids == null ? null : new Set(ids.map(Number))
    if (action === 'keep-best') return report.duplicates.map((group) => ({ id: group[0].id, title: group[0].title, tracks: group }))
    if (action === 'trash-selected') return report.duplicates.flat().filter((track) => wanted.has(track.id))
    if (action === 'add-covers') return report.missingCovers.filter((album) => !wanted || wanted.has(album.id))
    if (action === 'lyrics-fetch') {
      return lyricsFound.missing.filter((track) => !wanted || wanted.has(track.id))
        .map((track) => ({ id: track.id, title: track.title, artist: track.artist, path: track.path }))
    }
    if (action === 'lyrics-tidy') {
      return lyricsFound.tidy.filter((item) => !wanted || wanted.has(item.id))
        .map((item) => ({ ...item, path: path.join(item.dir, item.files[0]) }))
    }
    const rows = report.lowBitrate.filter((track) => !wanted || wanted.has(track.id))
      .map((track) => existingTrack.get(track.id)).filter((row) => row && !row.lossless && row.bitrate > 0 && row.bitrate < LOW_BITRATE)
    const folders = new Map()
    for (const row of rows) {
      const key = JSON.stringify([row.library_id, path.dirname(row.rel_path)])
      if (!folders.has(key)) folders.set(key, [])
      folders.get(key).push(row)
    }
    const groups = [...folders.values()].flatMap((folder) => {
      const duplicates = findDuplicates(folder)
      const used = new Set(duplicates.flat().map((row) => row.id))
      return [...duplicates, ...folder.filter((row) => !used.has(row.id)).map((row) => [row])]
    })
    return groups
      .map((group) => ({ id: group[0].id, title: group[0].title, tracks: group.map((row) => ({
        id: row.id, library_id: row.library_id, rel_path: row.rel_path, file: libraries.resolveTrackFile(row),
        title: row.title, artist_name: row.artist_name, duration: row.duration, size: row.size, mtime_ms: row.mtime_ms,
        bitrate: row.bitrate, lossless: row.lossless, added_at: row.added_at
      })) }))
  }

  // `force` (download batches, chosen songs only): take the closest online
  // match even when its length differs, e.g. after a LENGTH_MISMATCH.
  function startBatch(user, { action, ids, force = false } = {}, prepared = null) {
    if (!(prepared ? DOWNLOAD_ACTIONS : BATCH_ACTIONS).has(action) || (ids != null && (!Array.isArray(ids) || ids.length > LIST_MAX * 20 ||
      ids.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0))) ||
      (action === 'trash-selected' && !ids?.length) || (action === 'keep-best' && ids != null) ||
      (force && (!DOWNLOAD_ACTIONS.has(action) || !ids?.length))) {
      throw new HealthError('INVALID_HEALTH_BATCH', 'Select a valid library health action and items.')
    }
    if (job || batchPromise || singleFixes || emptyingTrash) throw new HealthError('HEALTH_BUSY', 'A library health operation is already running.', 409)
    if (!prepared && (!report || report.error)) throw new HealthError('NO_HEALTH_REPORT', 'Run a library health check first.', 409)
    const canControl = CONTROL_ACTIONS.has(action)
    if (DOWNLOAD_ACTIONS.has(action) && !bridge.canDownload(user)) {
      throw new HealthError('DOWNLOADS_NOT_ALLOWED', 'Downloading into the library is disabled.', 403)
    }
    const items = prepared || batchItems(action, ids)
    if (!items.length) throw new HealthError('NO_HEALTH_ITEMS', 'There are no items for this operation.', 409)
    // Retrying some failures keeps the other failures of the last download batch on screen.
    const retried = new Set(items.flatMap((item) => item.tracks?.map((track) => track.id) || [item.id]))
    const earlierErrors = force && batch?.canControl
      ? [...(batch.earlierErrors || []), ...batch.errors].filter((entry) => !(entry.trackIds || [entry.id]).some((id) => retried.has(id)))
      : []
    batch = { id: randomUUID(), action, canControl, force: Boolean(force), running: true, paused: false, canceled: false, done: 0, total: items.length, succeeded: 0, errors: [], earlierErrors }
    launchBatch(user, items)
    return status()
  }

  function writeCheckpoint(work) {
    setSetting(db, CHECKPOINT, {
      batch, userId: work.userId, items: batch.running ? work.items : [],
      download: work.download, moves: work.moves
    })
  }

  function saveBatch(work) {
    if (batch.canControl) transaction(db, () => writeCheckpoint(work), { durable: true })
  }

  function launchBatch(user, items, saved = {}) {
    const work = {
      userId: user.id, user, items, controller: new AbortController(),
      pause: batch.paused ? Promise.withResolvers() : null,
      download: saved.download ?? null, moves: saved.moves ?? {}
    }
    saveBatch(work)
    batchWork = work
    batchPromise = Promise.resolve().then(async () => {
      try {
        if (!batch.canceled) await runBatch(user, work)
        if (batch.canceled && work.download?.owned) await bridge.cancel(work.download.id, user)
        if (work.controller.signal.aborted && !batch.canceled && batch.canControl) return
        batch.running = false
        batch.paused = false
        batch.currentTitle = null
        work.download = null
        work.moves = {}
        saveBatch(work)
      } catch (error) {
        logger.warn?.(`⚠️ [player] library health batch stopped: ${error?.message || error}`)
        batch.running = false
        batch.paused = false
        batch.errors.push({ title: batch.currentTitle, code: error.code || null, message: error.message })
      } finally {
        batchWork = null
        batchPromise = null
      }
    })
  }

  function restoreBatch() {
    const saved = getSetting(db, CHECKPOINT)
    if (!saved) return
    batch = saved.batch
    batch.currentTitle = null
    if (!batch.running) return
    const user = getUser(saved.userId)
    if (!user || user.disabled || user.role !== 'admin') {
      batch.running = false
      batch.paused = false
      batch.canceled = true
      saveBatch({ userId: saved.userId, download: null, moves: {} })
      return
    }
    launchBatch(user, saved.items, saved)
  }

  function pauseBatch() {
    batchWork.pause ??= Promise.withResolvers()
    batch.paused = true
  }

  function releasePause() {
    batchWork.pause?.resolve()
    batchWork.pause = null
  }

  function controlBatch(id, command) {
    if (batch?.id !== id || !batch.canControl) throw new HealthError('NOT_FOUND', 'Download batch not found.', 404)
    if (!batch.running || batch.canceled) return status()
    if (command === 'pause') pauseBatch()
    else if (command === 'resume' || command === 'cancel') {
      batch.paused = false
      batch.blocked = null
      batch.canceled = command === 'cancel'
    } else throw new HealthError('INVALID_HEALTH_BATCH', 'Select a valid library health action.')
    saveBatch(batchWork)
    if (batch.canceled) batchWork.controller.abort()
    if (!batch.paused) releasePause()
    return status()
  }

  async function runBatch(user, work) {
    const { action } = batch
    const signal = work.controller.signal
    while (batch.done < work.items.length) {
      while (work.pause) await work.pause.promise
      if (signal.aborted) return
      const item = work.items[batch.done]
      batch.currentTitle = item.title
      try {
        if (action === 'keep-best') await keepBest(item.tracks, signal)
        else if (action === 'trash-selected') await trash(item.id)
        else if (action === 'add-covers') await fixCover(item.id, signal)
        else if (action === 'lyrics-fetch') await fetchMissingLyrics(item, signal)
        else if (action === 'lyrics-tidy') await tidyLyrics(item)
        else await upgradeCopies(user, item.tracks, work, item.source || null)
        if (LYRICS_ACTIONS.has(action)) forgetLyricsItem(action, item.id)
        batch.succeeded += 1
      } catch (error) {
        if (signal.aborted) return
        if (error.code === 'SOURCE_FOLDER_UNAVAILABLE' && batch.canControl) {
          pauseBatch()
          batch.blocked = error.code
          saveBatch(work)
          continue
        }
        batch.errors.push({
          id: item.id, title: item.title, message: error.message, code: error.code || null, detail: error.detail || null,
          trackIds: item.tracks?.map((track) => track.id) || null
        })
      } finally {
        batch.currentTitle = null
      }
      batch.done += 1
      work.download = null
      work.moves = {}
      saveBatch(work)
    }
  }

  function available(row) {
    const file = row && libraries.resolveTrackFile(row)
    return Boolean(file && fs.existsSync(file))
  }

  async function keepBest(tracks, signal) {
    const current = tracks.map((track) => existingTrack.get(track.id)).filter(available)
    for (const group of findDuplicates(current)) {
      const [best, ...copies] = group
      for (const copy of copies) {
        signal.throwIfAborted()
        if (!available(existingTrack.get(best.id))) throw new HealthError('FILE_UNAVAILABLE', 'The best copy is no longer available.', 409)
        await trash(copy.id)
      }
    }
  }

  async function waitForUpgrade(user, row, work, source = null) {
    const signal = work.controller.signal
    const onRequested = (id, owned) => {
      work.download = { id, owned }
      writeCheckpoint(work)
    }
    let download = work.download ? bridge.get(work.download.id, user)
      : source ? await requestInto(user, row, source, { signal, onRequested })
        : await requestBetter(user, row, { signal, force: batch.force, onRequested })
    while (download.active) {
      await delay(750, undefined, { signal, ref: false })
      download = bridge.get(download.id, user)
    }
    signal.throwIfAborted()
    return download
  }

  function matchesFile(row, file) {
    const stat = file && fs.statSync(file, { throwIfNoEntry: false })
    return stat?.isFile() && stat.size === row.size && Math.floor(stat.mtimeMs) === row.mtime_ms
  }

  function replacementChanged() {
    return new HealthError('REPLACEMENT_CHANGED', 'A file changed during the quality upgrade.', 409)
  }

  function checkOriginalFolder(row) {
    if (libraries.resolveTrackFile(row) !== row.file) throw replacementChanged()
    const folder = row.file && fs.statSync(path.dirname(row.file), { throwIfNoEntry: false })
    if (!folder?.isDirectory()) throw new HealthError('SOURCE_FOLDER_UNAVAILABLE', 'The original folder is unavailable.', 409)
  }

  // `chosen`: the admin picked the source, so any song it brought into the
  // folder replaces the old one (no quality, title or length check).
  function verifiedUpgrade(download, originals, preset = null, force = false, chosen = false) {
    const target = upgradeTarget(originals[0])
    return download.trackIds.map((id) => existingTrack.get(id)).find((row) => {
      if (!row || row.library_id !== target.libraryId || path.dirname(row.rel_path) !== target.folder ||
        (preset && !matchesUpgradePreset(row, preset)) || !matchesFile(row, libraries.resolveTrackFile(row))) return false
      if (chosen) return originals.every((original) => row.id !== original.id)
      return originals.every((original) => row.id !== original.id && betterThan(row, original) &&
        songKey(row.title, row.artist_name) === songKey(original.title, original.artist_name) &&
        matchesUpgradeDuration(row.duration, original.duration, download.duration, force))
    })
  }

  async function upgradeCopies(user, originals, work, source = null) {
    const signal = work.controller.signal
    for (const original of originals) checkOriginalFolder(original)
    const present = originals.find((row) => matchesFile(row, row.file))
    if (!work.download && !present) throw new HealthError('FILE_UNAVAILABLE', 'The original copies are no longer available.', 409)
    if (!work.download && !source) {
      const preset = getConfig()
      const previous = bridge.completedUpgrades(user, upgradeTarget(present))
        .find((download) => verifiedUpgrade(download, originals, preset, batch.force))
      if (previous) {
        work.download = { id: previous.id, owned: false }
        saveBatch(work)
      }
    }
    // The new copy replaces songs the library already had: it keeps their date
    // instead of showing up under "recently added".
    const addedAt = Math.min(...originals.map((o) => o.added_at ?? existingTrack.get(o.id)?.added_at).filter((n) => n > 0))
    const download = await waitForUpgrade(user, present || originals[0], work, source)
    signal.throwIfAborted()
    if (download.status !== 'completed') {
      throw new HealthError(download.error?.code || 'DOWNLOAD_FAILED', download.error?.message || 'The quality upgrade did not complete.', 409)
    }
    const better = verifiedUpgrade(download, originals, null, batch.force, Boolean(source))
    if (!better && source) throw new HealthError('REPLACEMENT_MISSING', 'The chosen download did not bring a song into the original folder.', 409)
    if (!better) throw new HealthError('NO_BETTER_COPY', 'A new, higher-quality copy of the same recording could not be verified.', 409)
    for (const original of originals) {
      signal.throwIfAborted()
      checkOriginalFolder(original)
      const current = existingTrack.get(original.id)
      const betterFile = libraries.resolveTrackFile(better)
      const originalChanged = current && (current.mtime_ms !== original.mtime_ms || current.size !== original.size ||
        current.library_id !== original.library_id || current.rel_path !== original.rel_path)
      if (!matchesFile(better, betterFile) || betterFile === original.file || originalChanged) throw replacementChanged()

      let target = work.moves[original.id]
      if (!fs.statSync(original.file, { throwIfNoEntry: false })) {
        // The file can already be in the trash if we stopped before updating the index.
        const archived = target && fs.statSync(target, { throwIfNoEntry: false })
        if (!archived?.isFile() || archived.size !== original.size) throw replacementChanged()
      } else {
        if (!target) {
          target = trashTarget(original)
          work.moves[original.id] = target
          saveBatch(work)
        }
        await moveFile(original.file, target, original)
      }
      await trashSidecars(original, better, target)
      // The new song takes the old one's places (playlists, favorites, history).
      scanner.transferTrack?.(original.id, better.id)
      forgetTrashed(original)
    }
    if (Number.isFinite(addedAt)) db.prepare('UPDATE tracks SET added_at = MIN(added_at, ?) WHERE id = ?').run(addedAt, better.id)
    await takeOriginalName(better, originals)
  }

  // The old song's lyrics files go to the trash with it when the new copy has
  // lyrics of its own (a file of any kind, or lyrics in its tags). Without
  // them the old lyrics stay: the new copy takes the old name and uses them.
  async function trashSidecars(original, better, archived) {
    const { dir, name } = path.parse(libraries.resolveTrackFile(better))
    const hasOwn = Boolean(existingTrack.get(better.id)?.has_lyrics) || SIDECAR_EXTENSIONS.some((ext) => fs.existsSync(path.join(dir, name + ext)))
    if (hasOwn) await trashLyrics(original.file, archived)
  }

  // "Song (2).mp3" was named so only because the old "Song.mp3" was still
  // there. Once the old copy is in the trash, the new one takes its name.
  async function takeOriginalName(better, originals) {
    const row = existingTrack.get(better.id)
    const file = row && libraries.resolveTrackFile(row)
    if (!file) return
    const stem = (o) => path.parse(o.file).name
    const original = originals.find((o) => !/ \(\d+\)$/.test(stem(o))) || originals[0]
    const current = path.parse(file)
    const wanted = path.join(current.dir, stem(original) + current.ext)
    const rel = path.join(path.dirname(row.rel_path), path.basename(wanted))
    if (wanted === file || path.dirname(original.file) !== current.dir || fs.existsSync(wanted) || !scanner.renameTrack) return
    if (db.prepare('SELECT 1 FROM tracks WHERE library_id = ? AND rel_path = ?').get(row.library_id, rel)) return
    try {
      await fs.promises.rename(file, wanted)
    } catch (error) {
      logger.warn?.(`⚠️ [player] could not rename ${path.basename(file)}: ${error?.message || error}`)
      return
    }
    scanner.renameTrack(row.id, rel)
    for (const ext of SIDECAR_EXTENSIONS) {
      const side = path.join(current.dir, current.name + ext)
      const target = path.join(current.dir, stem(original) + ext)
      if (!fs.existsSync(side) || fs.existsSync(target)) continue
      await fs.promises.rename(side, target).catch(() => {})
    }
    logger.log?.(`✏️ [player] renamed ${path.basename(file)} to ${path.basename(wanted)}`)
  }

  async function stop() {
    if (batchWork) {
      batchWork.controller.abort()
      releasePause()
    }
    await batchPromise
  }

  function singleFix(fix) {
    return async (...args) => {
      if (batchPromise || emptyingTrash) throw new HealthError('HEALTH_BUSY', 'A library health operation is already running.', 409)
      singleFixes += 1
      try { return await fix(...args) } finally { singleFixes -= 1 }
    }
  }

  return { status, start, startBatch, restoreBatch, controlBatch, stop, emptyTrash, trash: singleFix(trash), fixCover: singleFix(fixCover), redownload, replaceWith }
}
