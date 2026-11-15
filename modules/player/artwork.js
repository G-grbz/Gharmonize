import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as binaries from '../binaries.js'
import { spawnSafe } from '../safeProcess.js'
import { terminateProcess } from '../processTermination.js'
import { visibleSql, uidLiteral } from './access.js'
import { getInstallId } from './db.js'

export const ARTWORK_SIZES = [64, 128, 256, 512, 1024]
const FOLDER_IMAGE_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall', 'artwork']
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp']
const NEGATIVE_TTL_MS = 10 * 60 * 1000
const FFMPEG_TIMEOUT_MS = 20_000
const MAX_EMBEDDED_BYTES = 20 * 1024 * 1024
const MEMO_LIMIT = 50_000
const ARTWORK_KINDS = ['track', 'album', 'artist', 'playlist']
const VERSION_COLS = 't.id, t.library_id, t.rel_path, t.size, t.mtime_ms'
const BARE_REF = /^(track|album|artist|playlist)\/(\d+)$/

const sha1 = (value) => crypto.createHash('sha1').update(value).digest('hex')

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
  const versions = new Map()
  const contentKeys = new Map()
  const installId = getInstallId(db)
  let libraryPaths = null
  // The visibility clause embeds the user id, so statements are per user.
  const statements = new Map()
  const prepare = (sql) => {
    let stmt = statements.get(sql)
    if (!stmt) {
      if (statements.size >= 200) statements.clear()
      stmt = db.prepare(sql)
      statements.set(sql, stmt)
    }
    return stmt
  }

  function libraryPath(id) {
    if (!libraryPaths) {
      libraryPaths = new Map()
      try { for (const row of db.prepare('SELECT id, path FROM libraries').all()) libraryPaths.set(row.id, row.path) } catch {}
    }
    return libraryPaths.get(id) || ''
  }

  // Resized files are keyed by the image bytes, so the same cover embedded in
  // twelve songs of an album is resized once.
  async function contentKeyOf(file, fileKey) {
    const known = contentKeys.get(fileKey)
    if (known) return known
    const key = sha1(await fs.promises.readFile(file))
    if (contentKeys.size >= MEMO_LIMIT) contentKeys.clear()
    contentKeys.set(fileKey, key)
    return key
  }

  async function loadParser() {
    if (parseFile) return parseFile
    const mod = await import('music-metadata')
    return (file) => mod.parseFile(file, { skipCovers: false, duration: false, skipPostHeaders: true })
  }

  // Returns { file, contentType, key, stable } for the original cover of a
  // track: its embedded picture, else a cover/folder image next to it.
  // `stable` is false for folder images, which can change while the song
  // file (and so the artwork URL) stays the same.
  async function extractTrackCover(track) {
    const abs = libraries.resolveTrackFile(track)
    if (!abs) return null
    let st
    try { st = await fs.promises.stat(abs) } catch { return null }
    const fileKey = sha1(`${abs}\0${st.size}\0${Math.floor(st.mtimeMs)}`)
    for (const ext of IMAGE_EXTS) {
      const cached = path.join(srcDir, fileKey + ext)
      if (!fs.existsSync(cached)) continue
      try {
        return { file: cached, contentType: mimeForExt(ext), key: await contentKeyOf(cached, fileKey), stable: true }
      } catch {}
    }
    try {
      const parse = await loadParser()
      const meta = await parse(abs)
      const cover = selectCover(meta?.common?.picture)
      const ext = extForMime(cover?.format)
      if (cover?.data?.length && ext && cover.data.length <= MAX_EMBEDDED_BYTES) {
        const file = path.join(srcDir, fileKey + ext)
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
        const data = Buffer.from(cover.data)
        await fs.promises.writeFile(tmp, data)
        await fs.promises.rename(tmp, file)
        const key = sha1(data)
        contentKeys.set(fileKey, key)
        return { file, contentType: mimeForExt(ext), key, stable: true }
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
        const folderKey = sha1(`${file}\0${fst.size}\0${Math.floor(fst.mtimeMs)}`)
        return { file, contentType: mimeForExt(path.extname(file).toLowerCase()), key: folderKey, stable: false }
      }
    } catch {}
    return null
  }

  // Only tracks the requesting user may see can provide artwork. A song uses
  // its own cover first and only then the cover of its album (never one of
  // another album or artist).
  function candidateTracks(kind, id, userId, cols = 't.*') {
    const n = Number(id)
    const vis = visibleSql('t', uidLiteral(userId))
    const albumTracks = (albumId, exceptId = 0) => prepare(`SELECT ${cols} FROM tracks t WHERE t.album_id = ? AND t.id != ? AND ${vis}
      ORDER BY COALESCE(t.disc_no,1), COALESCE(t.track_no,9999), t.id LIMIT 4`).all(albumId, exceptId)
    switch (kind) {
      case 'track': {
        const own = prepare(`SELECT ${cols}, t.album_id AS own_album_id FROM tracks t WHERE t.id = ? AND ${vis}`).get(n)
        if (!own) return []
        return own.own_album_id ? [own, ...albumTracks(own.own_album_id, own.id)] : [own]
      }
      case 'album': return albumTracks(n)
      // Indexed id lookup: an OR across the join would walk the whole library.
      case 'artist': return prepare(`SELECT ${cols} FROM tracks t LEFT JOIN albums a ON a.id = t.album_id
        WHERE t.id IN (SELECT id FROM tracks WHERE artist_id = ? UNION SELECT t2.id FROM albums a2 JOIN tracks t2 ON t2.album_id = a2.id WHERE a2.artist_id = ?) AND ${vis}
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

  function playlistRows(id, userId, cols = 't.*') {
    return prepare(`SELECT ${cols} FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
      JOIN playlists p ON p.id = pt.playlist_id
      WHERE pt.playlist_id = ? AND (p.user_id = ${uidLiteral(userId)} OR p.is_public = 1) AND ${visibleSql('t', uidLiteral(userId))}
      ORDER BY pt.position LIMIT 60`).all(Number(id))
  }

  // Short token describing everything the artwork of an item can come from:
  // this install plus the candidate song files (path, size, mtime). A changed,
  // re-tagged, moved or replaced file, or an id reused for another song,
  // gives a new token and so a new URL.
  function versionFor(kind, id, userId = 0) {
    if (!ARTWORK_KINDS.includes(kind)) return null
    const memoKey = `${uidLiteral(userId)}:${kind}:${id}`
    if (kind !== 'playlist' && versions.has(memoKey)) return versions.get(memoKey)
    let rows = []
    try { rows = kind === 'playlist' ? playlistRows(id, userId, VERSION_COLS) : candidateTracks(kind, id, userId, VERSION_COLS) } catch {}
    const hash = crypto.createHash('sha1').update(`${installId}\0${kind}\0${id}`)
    for (const r of rows) hash.update(`\0${r.id}\0${libraryPath(r.library_id)}\0${r.rel_path}\0${r.size}\0${r.mtime_ms}`)
    const token = hash.digest('hex').slice(0, 16)
    if (kind !== 'playlist') {
      if (versions.size >= MEMO_LIMIT) versions.clear()
      versions.set(memoKey, token)
    }
    return token
  }

  function versionRef(ref, userId) {
    const m = BARE_REF.exec(ref)
    return m ? `${m[1]}/${m[2]}/${versionFor(m[1], Number(m[2]), userId)}` : ref
  }

  // Rewrites every bare "kind/id" artwork ref of an API answer (`artwork`
  // fields and `covers` lists) into its versioned "kind/id/token" form.
  function versionRefs(value, userId = 0, key = null) {
    if (Array.isArray(value)) {
      return value.map((item) => (key === 'covers' && typeof item === 'string' ? versionRef(item, userId) : versionRefs(item, userId)))
    }
    if (!value || typeof value !== 'object') return value
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = k === 'artwork' && typeof v === 'string' ? versionRef(v, userId) : versionRefs(v, userId, k)
    return out
  }

  async function resize(src, size) {
    const meta = { stable: src.stable !== false, sourceKey: src.key }
    const out = path.join(outDir, `${src.key}-${size}.jpg`)
    if (fs.existsSync(out)) return { file: out, contentType: 'image/jpeg', ...meta }
    const tmp = path.join(outDir, `${src.key}-${size}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp.jpg`)
    try {
      await runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', src.file,
        '-vf', `scale=${size}:${size}:force_original_aspect_ratio=increase:flags=lanczos,crop=${size}:${size}`,
        '-frames:v', '1', '-q:v', '3', tmp
      ])
      await fs.promises.rename(tmp, out)
      return { file: out, contentType: 'image/jpeg', ...meta }
    } catch (error) {
      try { await fs.promises.rm(tmp, { force: true }) } catch {}
      logger.debug?.(`[player] artwork resize failed: ${error?.message || error}`)
      return { file: src.file, contentType: src.contentType, ...meta }
    }
  }

  // Playlist covers are a 2x2 mosaic of the first four distinct album covers.
  async function playlistArtwork(id, size, userId) {
    const rows = playlistRows(id, userId)
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
    const key = sha1(sources.map((s) => s.key).join('|'))
    const meta = { stable: sources.every((s) => s.stable !== false), sourceKey: key }
    const out = path.join(outDir, `mosaic-${key}-${size}.jpg`)
    if (fs.existsSync(out)) return { file: out, contentType: 'image/jpeg', ...meta }
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
      return { file: out, contentType: 'image/jpeg', ...meta }
    } catch (error) {
      try { await fs.promises.rm(tmp, { force: true }) } catch {}
      logger.debug?.(`[player] mosaic failed: ${error?.message || error}`)
      return resize(sources[0], size)
    }
  }

  async function getArtwork(kind, id, requestedSize, userId = 0) {
    if (!ARTWORK_KINDS.includes(kind)) return null
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

  // Called when songs, libraries or visibility change.
  function invalidate() {
    negative.clear()
    versions.clear()
    libraryPaths = null
  }

  return { getArtwork, versionFor, versionRefs, invalidate }
}
