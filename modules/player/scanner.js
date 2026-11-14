import { metadataSourceKey } from './sourceKey.js'
import fs from 'node:fs'
import path from 'node:path'
import { transaction } from './db.js'

export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.wav', '.wave',
  '.aif', '.aiff', '.aifc', '.wma', '.ape', '.wv', '.mka', '.alac', '.dsf', '.dff', '.mpc', '.tta'
])
// Files still being written (e.g. an active Gharmonize download) are skipped
// and picked up by the next scan.
const STABILITY_WINDOW_MS = 10_000
const PARSE_CONCURRENCY = 4
const BATCH_SIZE = 200
const UNKNOWN_ARTIST = 'Unknown Artist'

export function normalizeKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .trim()
}

function cleanText(value, max = 512) {
  if (Array.isArray(value)) value = value.filter(Boolean).join(', ')
  const text = String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : null
}

function toInt(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

function toReal(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// "01 - Artist - Title", "01. Title", "Artist - Title" → best-effort fields.
export function parseFileNameFallback(fileName) {
  let base = path.basename(fileName, path.extname(fileName)).replace(/_/g, ' ').trim()
  let trackNo = null
  const numbered = base.match(/^(\d{1,3})\s*[-._)\s]\s*(.+)$/)
  if (numbered) {
    trackNo = Number(numbered[1])
    base = numbered[2].trim()
  }
  const parts = base.split(/\s+-\s+/)
  if (parts.length >= 2) {
    return { artist: parts[0].trim() || null, title: parts.slice(1).join(' - ').trim() || base, trackNo }
  }
  return { artist: null, title: base || fileName, trackNo }
}

export function metadataToRecord(meta, relPath) {
  const common = meta?.common || {}
  const format = meta?.format || {}
  const fallback = parseFileNameFallback(relPath)
  const artists = Array.isArray(common.artists) ? common.artists.map((a) => cleanText(a, 256)).filter(Boolean) : []
  const artistName = cleanText(common.artist, 512) || (artists.length ? artists.join(', ') : null) || fallback.artist || UNKNOWN_ARTIST
  const primaryArtist = artists[0] || artistName
  const albumTitle = cleanText(common.album, 512)
  const albumArtist = cleanText(common.albumartist, 512) || (albumTitle ? primaryArtist : null)
  const genre = cleanText(Array.isArray(common.genre) ? common.genre[0] : common.genre, 128)
  return {
    sourceKey: metadataSourceKey(meta),
    title: cleanText(common.title, 512) || fallback.title,
    artistName,
    primaryArtist,
    albumTitle,
    albumArtist,
    trackNo: toInt(common.track?.no) ?? fallback.trackNo,
    discNo: toInt(common.disk?.no),
    year: toInt(common.year) || toInt(String(common.date || '').slice(0, 4)),
    genre,
    duration: toReal(format.duration),
    bitrate: toInt(format.bitrate),
    sampleRate: toInt(format.sampleRate),
    bitDepth: toInt(format.bitsPerSample),
    channels: toInt(format.numberOfChannels),
    codec: cleanText(format.codec, 64),
    container: cleanText(format.container, 64),
    lossless: format.lossless ? 1 : 0,
    hasLyrics: Array.isArray(common.lyrics) && common.lyrics.length > 0 ? 1 : 0,
    isrc: cleanText(Array.isArray(common.isrc) ? common.isrc[0] : common.isrc, 32),
    rgTrackGain: toReal(common.replaygain_track_gain?.dB),
    rgAlbumGain: toReal(common.replaygain_album_gain?.dB),
    bpm: toReal(common.bpm)
  }
}

async function* walkAudioFiles(root, { signal } = {}) {
  const stack = ['']
  const visited = new Set()
  while (stack.length) {
    if (signal?.aborted) return
    const rel = stack.pop()
    const abs = path.join(root, rel)
    let real
    try { real = await fs.promises.realpath(abs) } catch { continue }
    if (visited.has(real)) continue
    visited.add(real)
    let dir
    try { dir = await fs.promises.opendir(abs) } catch { continue }
    for await (const entry of dir) {
      if (entry.name.startsWith('.')) continue
      const childRel = rel ? path.join(rel, entry.name) : entry.name
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const st = await fs.promises.stat(path.join(root, childRel))
          isDir = st.isDirectory()
          isFile = st.isFile()
        } catch { continue }
      }
      if (isDir) stack.push(childRel)
      else if (isFile && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) yield childRel
    }
  }
}

async function defaultParseFile(filePath) {
  const { parseFile } = await import('music-metadata')
  const meta = await parseFile(filePath, { skipCovers: true, duration: false })
  if (!meta?.format?.duration) {
    try { return await parseFile(filePath, { skipCovers: true, duration: true }) } catch { return meta }
  }
  return meta
}

export function createScanner(db, { parseFile = defaultParseFile, now = () => Date.now(), logger = console, onTrackChanges = null } = {}) {
  let status = idleStatus()
  let running = null
  let abort = null
  const pending = new Set()

  function idleStatus() {
    return { running: false, libraryId: null, libraryName: null, phase: 'idle', scanned: 0, added: 0, updated: 0, removed: 0, unchanged: 0, errors: 0, startedAt: null, finishedAt: null, queue: [] }
  }

  const stmt = {
    libraries: db.prepare('SELECT * FROM libraries WHERE enabled = 1 ORDER BY id'),
    library: db.prepare('SELECT * FROM libraries WHERE id = ?'),
    existing: db.prepare('SELECT id, rel_path, size, mtime_ms FROM tracks WHERE library_id = ?'),
    byPath: db.prepare('SELECT id, size, mtime_ms FROM tracks WHERE library_id = ? AND rel_path = ?'),
    artistByKey: db.prepare('SELECT id FROM artists WHERE name_key = ?'),
    insertArtist: db.prepare('INSERT INTO artists (name, name_key, created_at) VALUES (?, ?, ?)'),
    albumByKey: db.prepare('SELECT id, year, genre FROM albums WHERE title_key = ? AND artist_id = ?'),
    insertAlbum: db.prepare('INSERT INTO albums (title, title_key, artist_id, year, genre, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    fillAlbum: db.prepare('UPDATE albums SET year = COALESCE(year, ?), genre = COALESCE(genre, ?) WHERE id = ?'),
    insertTrack: db.prepare(`
      INSERT INTO tracks (library_id, rel_path, size, mtime_ms, title, artist_id, artist_name, album_id, album_title, album_artist,
        track_no, disc_no, year, genre, duration, bitrate, sample_rate, bit_depth, channels, codec, container, lossless,
        has_lyrics, isrc, rg_track_gain, rg_album_gain, bpm, added_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateTrack: db.prepare(`
      UPDATE tracks SET size = ?, mtime_ms = ?, title = ?, artist_id = ?, artist_name = ?, album_id = ?, album_title = ?, album_artist = ?,
        track_no = ?, disc_no = ?, year = ?, genre = ?, duration = ?, bitrate = ?, sample_rate = ?, bit_depth = ?, channels = ?,
        codec = ?, container = ?, lossless = ?, has_lyrics = ?, isrc = ?, rg_track_gain = ?, rg_album_gain = ?, bpm = ?, updated_at = ?
      WHERE id = ?`),
    updateSource: db.prepare('UPDATE tracks SET source_key = ? WHERE id = ?'),
    deleteTrack: db.prepare('DELETE FROM tracks WHERE id = ?'),
    deleteFts: db.prepare('DELETE FROM tracks_fts WHERE rowid = ?'),
    insertFts: db.prepare('INSERT INTO tracks_fts (rowid, title, artist, album, album_artist, genre) VALUES (?, ?, ?, ?, ?, ?)'),
    orphanAlbums: db.prepare('DELETE FROM albums WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = albums.id)'),
    orphanArtists: db.prepare(`DELETE FROM artists WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.artist_id = artists.id)
      AND NOT EXISTS (SELECT 1 FROM albums WHERE albums.artist_id = artists.id)`),
    orphanFavorites: db.prepare(`DELETE FROM favorites WHERE
      (item_type = 'track' AND NOT EXISTS (SELECT 1 FROM tracks WHERE id = favorites.item_id)) OR
      (item_type = 'album' AND NOT EXISTS (SELECT 1 FROM albums WHERE id = favorites.item_id)) OR
      (item_type = 'artist' AND NOT EXISTS (SELECT 1 FROM artists WHERE id = favorites.item_id))`),
    libraryResult: db.prepare('UPDATE libraries SET last_scan_at = ?, last_scan_status = ?, last_scan_error = ?, track_count = (SELECT COUNT(*) FROM tracks WHERE library_id = ?) WHERE id = ?')
  }

  function ensureArtist(name) {
    const key = normalizeKey(name) || normalizeKey(UNKNOWN_ARTIST)
    const row = stmt.artistByKey.get(key)
    if (row) return row.id
    return Number(stmt.insertArtist.run(name, key, now()).lastInsertRowid)
  }

  function ensureAlbum(record, artistId) {
    if (!record.albumTitle) return null
    const key = normalizeKey(record.albumTitle)
    const row = stmt.albumByKey.get(key, artistId)
    if (row) {
      if ((row.year == null && record.year) || (row.genre == null && record.genre)) stmt.fillAlbum.run(record.year, record.genre, row.id)
      return row.id
    }
    return Number(stmt.insertAlbum.run(record.albumTitle, key, artistId, record.year, record.genre, now()).lastInsertRowid)
  }

  function writeTrack(libraryId, item, existingId) {
    const r = item.record
    const artistId = ensureArtist(r.primaryArtist)
    const albumArtistId = r.albumArtist ? ensureArtist(r.albumArtist) : artistId
    const albumId = ensureAlbum(r, albumArtistId)
    const ts = now()
    const values = [
      r.title, artistId, r.artistName, albumId, r.albumTitle, r.albumArtist, r.trackNo, r.discNo, r.year, r.genre,
      r.duration, r.bitrate, r.sampleRate, r.bitDepth, r.channels, r.codec, r.container, r.lossless, r.hasLyrics,
      r.isrc, r.rgTrackGain, r.rgAlbumGain, r.bpm
    ]
    // A file may have been indexed meanwhile by indexFiles() (download bridge)
    // while a full scan was reading tags: never insert a duplicate row.
    if (!existingId) existingId = stmt.byPath.get(libraryId, item.rel)?.id || null
    let id = existingId
    if (existingId) {
      stmt.updateTrack.run(item.size, item.mtimeMs, ...values, ts, existingId)
      stmt.deleteFts.run(existingId)
    } else {
      id = Number(stmt.insertTrack.run(libraryId, item.rel, item.size, item.mtimeMs, ...values, ts, ts).lastInsertRowid)
    }
    stmt.updateSource.run(r.sourceKey, id)
    // Index folded text (diacritics removed, Turkish dotless ı → i) so that
    // "kirmizi" finds "Kırmızı"; queries are folded the same way.
    stmt.insertFts.run(id, normalizeKey(r.title), normalizeKey(r.artistName), normalizeKey(r.albumTitle), normalizeKey(r.albumArtist), normalizeKey(r.genre))
    return id
  }

  async function scanLibrary(library, signal) {
    const root = library.path
    status.libraryId = library.id
    status.libraryName = library.name
    status.phase = 'walking'
    let rootStat
    try {
      rootStat = await fs.promises.stat(root)
      if (!rootStat.isDirectory()) throw new Error('Not a directory')
      await fs.promises.access(root, fs.constants.R_OK)
    } catch (error) {
      // Unmounted/missing drive: keep the existing index untouched.
      stmt.libraryResult.run(now(), 'offline', String(error?.message || error), library.id, library.id)
      logger.warn?.(`⚠️ [player] Library "${library.name}" is not reachable, index kept: ${root}`)
      return { offline: true }
    }

    const existing = new Map(stmt.existing.all(library.id).map((row) => [row.rel_path, row]))
    const seen = new Set()
    const toParse = []
    const cutoff = now() - STABILITY_WINDOW_MS

    for await (const rel of walkAudioFiles(root, { signal })) {
      if (signal.aborted) break
      let st
      try { st = await fs.promises.stat(path.join(root, rel)) } catch { continue }
      const prev = existing.get(rel)
      if (prev) seen.add(rel)
      if (st.mtimeMs > cutoff) continue
      const mtimeMs = Math.floor(st.mtimeMs)
      if (prev && prev.size === st.size && prev.mtime_ms === mtimeMs) {
        status.unchanged += 1
        continue
      }
      toParse.push({ rel, size: st.size, mtimeMs, existingId: prev?.id || null })
    }
    if (signal.aborted) return { aborted: true }

    status.phase = 'reading'
    status.total = toParse.length
    let batch = []
    const changedIds = []
    const flush = () => {
      if (!batch.length) return
      const items = batch
      batch = []
      transaction(db, () => {
        for (const item of items) {
          changedIds.push(writeTrack(library.id, item, item.existingId))
          if (item.existingId) status.updated += 1
          else status.added += 1
        }
      })
    }

    let cursor = 0
    const worker = async () => {
      while (cursor < toParse.length && !signal.aborted) {
        const item = toParse[cursor++]
        try {
          const meta = await parseFile(path.join(root, item.rel))
          item.record = metadataToRecord(meta, item.rel)
        } catch (error) {
          status.errors += 1
          // Unreadable tags still produce a playable entry from the file name.
          item.record = metadataToRecord(null, item.rel)
          logger.debug?.(`[player] metadata read failed for ${item.rel}: ${error?.message || error}`)
        }
        status.scanned += 1
        batch.push(item)
        if (batch.length >= BATCH_SIZE) flush()
      }
    }
    await Promise.all(Array.from({ length: PARSE_CONCURRENCY }, worker))
    flush()
    if (signal.aborted) return { aborted: true }

    status.phase = 'cleanup'
    const removedIds = []
    transaction(db, () => {
      for (const [rel, row] of existing) {
        if (seen.has(rel)) continue
        stmt.deleteFts.run(row.id)
        stmt.deleteTrack.run(row.id)
        removedIds.push(row.id)
        status.removed += 1
      }
      stmt.orphanAlbums.run()
      stmt.orphanArtists.run()
      stmt.orphanFavorites.run()
      stmt.libraryResult.run(now(), 'ok', null, library.id, library.id)
    })
    if ((changedIds.length || removedIds.length) && onTrackChanges) {
      try { onTrackChanges({ libraryId: library.id, changedIds, removedIds }) } catch {}
    }
    return { ok: true }
  }

  async function runQueue() {
    const controller = new AbortController()
    abort = controller
    status = { ...idleStatus(), running: true, phase: 'starting', startedAt: now() }
    try {
      while (pending.size && !controller.signal.aborted) {
        const ids = [...pending]
        pending.clear()
        const libraries = ids.includes('all')
          ? stmt.libraries.all()
          : ids.map((id) => stmt.library.get(id)).filter((lib) => lib && lib.enabled)
        for (const library of libraries) {
          if (controller.signal.aborted) break
          status.queue = [...pending]
          try {
            await scanLibrary(library, controller.signal)
          } catch (error) {
            status.errors += 1
            stmt.libraryResult.run(now(), 'error', String(error?.message || error), library.id, library.id)
            logger.error?.(`❌ [player] Scan failed for "${library.name}":`, error?.message || error)
          }
        }
      }
    } finally {
      status = { ...status, running: false, phase: controller.signal.aborted ? 'aborted' : 'done', finishedAt: now(), queue: [] }
      abort = null
      running = null
    }
  }

  // Indexes specific files right away (no stability window), e.g. files a
  // finished Gharmonize download just produced. Returns Map(absPath → trackId).
  async function indexFiles(absPaths = []) {
    const result = new Map()
    const libs = stmt.libraries.all()
    const items = []
    for (const raw of absPaths) {
      const abs = path.resolve(String(raw || ''))
      if (!AUDIO_EXTENSIONS.has(path.extname(abs).toLowerCase())) continue
      let real
      try { real = await fs.promises.realpath(abs) } catch { continue }
      const lib = libs.find((l) => {
        const rel = path.relative(l.path, real)
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
      })
      if (!lib) continue
      let st
      try { st = await fs.promises.stat(real) } catch { continue }
      if (!st.isFile()) continue
      const rel = path.relative(lib.path, real)
      const prev = stmt.byPath.get(lib.id, rel)
      const mtimeMs = Math.floor(st.mtimeMs)
      if (prev && prev.size === st.size && prev.mtime_ms === mtimeMs) {
        result.set(abs, prev.id)
        continue
      }
      let record
      try { record = metadataToRecord(await parseFile(real), rel) } catch { record = metadataToRecord(null, rel) }
      items.push({ abs, libraryId: lib.id, rel, size: st.size, mtimeMs, existingId: prev?.id || null, record })
    }
    if (items.length) {
      const changedIds = []
      transaction(db, () => {
        for (const item of items) {
          const id = writeTrack(item.libraryId, item, item.existingId)
          result.set(item.abs, id)
          changedIds.push(id)
        }
        for (const libId of new Set(items.map((i) => i.libraryId))) {
          db.prepare('UPDATE libraries SET track_count = (SELECT COUNT(*) FROM tracks WHERE library_id = ?) WHERE id = ?').run(libId, libId)
        }
      })
      if (onTrackChanges) {
        try { onTrackChanges({ libraryId: null, changedIds, removedIds: [] }) } catch {}
      }
    }
    return result
  }

  function requestScan(libraryId = 'all') {
    pending.add(libraryId === 'all' ? 'all' : Number(libraryId))
    if (!running) running = runQueue()
    return running
  }

  async function stop() {
    pending.clear()
    abort?.abort()
    if (running) await running.catch(() => {})
  }

  return {
    requestScan,
    indexFiles,
    stop,
    getStatus: () => ({ ...status, queue: [...pending] }),
    isRunning: () => Boolean(running)
  }
}
