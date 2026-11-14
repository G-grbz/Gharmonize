import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as binaries from '../binaries.js'
import { spawnSafe } from '../safeProcess.js'
import { terminateProcess } from '../processTermination.js'
import { visibleSql, uidLiteral } from './access.js'

export const ARTWORK_SIZES = [64, 128, 256, 512, 1024]
const FOLDER_IMAGE_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall', 'artwork']
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp']
const NEGATIVE_TTL_MS = 10 * 60 * 1000
const FFMPEG_TIMEOUT_MS = 20_000
const MAX_EMBEDDED_BYTES = 20 * 1024 * 1024

export function pickArtworkSize(requested) {
  const n = Number(requested) || 512
  return ARTWORK_SIZES.find((size) => size >= n) || ARTWORK_SIZES[ARTWORK_SIZES.length - 1]
}

function mimeForExt(ext) {
  switch (ext) {
    case '.png': return 'image/png'
    case '.webp': return 'image/webp'
    default: return 'image/jpeg'
  }
}

function extForMime(mime) {
  const value = String(mime || '').toLowerCase()
  if (value.includes('png')) return '.png'
  if (value.includes('webp')) return '.webp'
  if (value.includes('jpeg') || value.includes('jpg')) return '.jpg'
  return null
}

export function selectCover(pictures) {
  if (!Array.isArray(pictures) || !pictures.length) return null
  const front = pictures.find((p) => /front/i.test(String(p?.type || '')))
  return front || pictures[0]
}

function runFfmpeg(args, { timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnSafe(binaries.FFMPEG_BIN || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let stderr = ''
    child.stderr?.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk })
    const timer = setTimeout(() => terminateProcess(child), timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').pop() || ''}`))
    })
  })
}

export function createArtworkService({ cacheDir, db, libraries, parseFile = null, logger = console }) {
  const srcDir = path.join(cacheDir, 'artwork', 'src')
  const outDir = path.join(cacheDir, 'artwork', 'sized')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.mkdirSync(outDir, { recursive: true })
  const negative = new Map()
  const inflight = new Map()

  async function loadParser() {
    if (parseFile) return parseFile
    const mod = await import('music-metadata')
    return (file) => mod.parseFile(file, { skipCovers: false, duration: false, skipPostHeaders: true })
  }

  // Returns { file, contentType, key } for the original cover of a track.
  async function extractTrackCover(track) {
    const abs = libraries.resolveTrackFile(track)
    if (!abs) return null
    let st
    try { st = await fs.promises.stat(abs) } catch { return null }
    const key = crypto.createHash('sha1').update(`${abs}\0${st.size}\0${Math.floor(st.mtimeMs)}`).digest('hex')
    for (const ext of IMAGE_EXTS) {
      const cached = path.join(srcDir, key + ext)
      if (fs.existsSync(cached)) return { file: cached, contentType: mimeForExt(ext), key }
    }
    try {
      const parse = await loadParser()
      const meta = await parse(abs)
      const cover = selectCover(meta?.common?.picture)
      const ext = extForMime(cover?.format)
      if (cover?.data?.length && ext && cover.data.length <= MAX_EMBEDDED_BYTES) {
        const file = path.join(srcDir, key + ext)
        const tmp = `${file}.${process.pid}.tmp`
        await fs.promises.writeFile(tmp, cover.data)
        await fs.promises.rename(tmp, file)
        return { file, contentType: mimeForExt(ext), key }
      }
    } catch (error) {
      logger.debug?.(`[player] cover read failed: ${error?.message || error}`)
    }
    // Folder image fallback (cover.jpg, folder.png ...).
    try {
      const dir = path.dirname(abs)
      const entries = await fs.promises.readdir(dir)
      const candidates = entries.filter((name) => IMAGE_EXTS.includes(path.extname(name).toLowerCase()))
      const ranked = candidates
        .map((name) => ({ name, rank: FOLDER_IMAGE_NAMES.indexOf(path.basename(name, path.extname(name)).toLowerCase()) }))
        .filter((c) => c.rank !== -1)
        .sort((a, b) => a.rank - b.rank)
      if (ranked.length) {
        const file = path.join(dir, ranked[0].name)
        const fst = await fs.promises.stat(file)
        const folderKey = crypto.createHash('sha1').update(`${file}\0${fst.size}\0${Math.floor(fst.mtimeMs)}`).digest('hex')
        return { file, contentType: mimeForExt(path.extname(file).toLowerCase()), key: folderKey }
      }
    } catch {}
    return null
  }

  // Only tracks the requesting user may see can provide artwork.
  function candidateTracks(kind, id, userId) {
    const n = Number(id)
    const vis = visibleSql('t', uidLiteral(userId))
    switch (kind) {
      case 'track': return db.prepare(`SELECT t.* FROM tracks t WHERE t.id = ? AND ${vis}`).all(n)
      case 'album': return db.prepare(`SELECT t.* FROM tracks t WHERE t.album_id = ? AND ${vis} ORDER BY COALESCE(t.disc_no,1), COALESCE(t.track_no,9999) LIMIT 4`).all(n)
      case 'artist': return db.prepare(`SELECT t.* FROM tracks t LEFT JOIN albums a ON a.id = t.album_id
        WHERE (t.artist_id = ? OR a.artist_id = ?) AND ${vis}
        ORDER BY (t.album_id IS NULL), a.year DESC, t.added_at DESC LIMIT 6`).all(n, n)
      default: return []
    }
  }

  async function sourceFor(kind, id, userId) {
    for (const track of candidateTracks(kind, id, userId)) {
      const src = await extractTrackCover(track)
      if (src) return src
    }
    return null
  }

  async function resize(src, size) {
    const out = path.join(outDir, `${src.key}-${size}.jpg`)
    if (fs.existsSync(out)) return { file: out, contentType: 'image/jpeg' }
    const tmp = path.join(outDir, `${src.key}-${size}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp.jpg`)
    try {
      await runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', src.file,
        '-vf', `scale=${size}:${size}:force_original_aspect_ratio=increase:flags=lanczos,crop=${size}:${size}`,
        '-frames:v', '1', '-q:v', '3', tmp
      ])
      await fs.promises.rename(tmp, out)
      return { file: out, contentType: 'image/jpeg' }
    } catch (error) {
      try { await fs.promises.rm(tmp, { force: true }) } catch {}
      logger.debug?.(`[player] artwork resize failed: ${error?.message || error}`)
      return { file: src.file, contentType: src.contentType }
    }
  }

  // Playlist covers are a 2x2 mosaic of the first four distinct album covers.
  async function playlistArtwork(id, size, userId) {
    const rows = db.prepare(`SELECT t.* FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
      JOIN playlists p ON p.id = pt.playlist_id
      WHERE pt.playlist_id = ? AND (p.user_id = ${uidLiteral(userId)} OR p.is_public = 1) AND ${visibleSql('t', uidLiteral(userId))}
      ORDER BY pt.position LIMIT 60`).all(Number(id))
    const seenAlbums = new Set()
    const sources = []
    for (const row of rows) {
      const albumKey = row.album_id || `t${row.id}`
      if (seenAlbums.has(albumKey)) continue
      seenAlbums.add(albumKey)
      const src = await extractTrackCover(row)
      if (src) sources.push(src)
      if (sources.length === 4) break
    }
    if (!sources.length) return null
    if (sources.length < 4) return resize(sources[0], size)
    const key = crypto.createHash('sha1').update(sources.map((s) => s.key).join('|')).digest('hex')
    const out = path.join(outDir, `mosaic-${key}-${size}.jpg`)
    if (fs.existsSync(out)) return { file: out, contentType: 'image/jpeg' }
    const half = Math.max(32, Math.floor(size / 2))
    const tmp = `${out}.${process.pid}.tmp.jpg`
    try {
      const inputs = sources.flatMap((s) => ['-i', s.file])
      const scale = sources.map((_, i) => `[${i}:v]scale=${half}:${half}:force_original_aspect_ratio=increase,crop=${half}:${half}[v${i}]`).join(';')
      await runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...inputs,
        '-filter_complex', `${scale};[v0][v1][v2][v3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[out]`,
        '-map', '[out]', '-frames:v', '1', '-q:v', '3', tmp
      ])
      await fs.promises.rename(tmp, out)
      return { file: out, contentType: 'image/jpeg' }
    } catch (error) {
      try { await fs.promises.rm(tmp, { force: true }) } catch {}
      logger.debug?.(`[player] mosaic failed: ${error?.message || error}`)
      return resize(sources[0], size)
    }
  }

  async function getArtwork(kind, id, requestedSize, userId = 0) {
    if (!['track', 'album', 'artist', 'playlist'].includes(kind)) return null
    const size = pickArtworkSize(requestedSize)
    const cacheKey = `${uidLiteral(userId)}:${kind}:${id}:${size}`
    const neg = negative.get(cacheKey)
    if (neg && Date.now() - neg < NEGATIVE_TTL_MS) return null
    if (inflight.has(cacheKey)) return inflight.get(cacheKey)
    const job = (async () => {
      const result = kind === 'playlist'
        ? await playlistArtwork(id, size, userId)
        : await (async () => {
          const src = await sourceFor(kind, id, userId)
          return src ? resize(src, size) : null
        })()
      if (!result) negative.set(cacheKey, Date.now())
      return result
    })().finally(() => inflight.delete(cacheKey))
    inflight.set(cacheKey, job)
    return job
  }

  function invalidate() {
    negative.clear()
  }

  return { getArtwork, invalidate }
}
