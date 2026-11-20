// Artist photos for library artists. The online (Deezer) photo is preferred;
// an artist without one keeps the cover-based artwork from its own songs.
//
// Cheap by design:
//  - a photo is fetched once per artist and kept on disk for good
//    (<cache>/artwork/artist/<name hash>.<content hash>.jpg); "no photo" is
//    remembered too (<name hash>.none) and only re-asked after 30 days;
//  - the online artist page already loads the Deezer artist, so its photo is
//    taken from there without any extra lookup (remember());
//  - other artists are looked up only when their artwork is actually shown,
//    one at a time, never while Deezer is off;
//  - the 500 px picture is downloaded (artist avatars are round and small).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { normalizeKey } from './scanner.js'

const PHOTO_HOSTS = /^https:\/\/[a-z0-9.-]+\.(dzcdn\.net|deezer\.com)\//i
// Deezer answers artists without a photo with an empty-hash default picture.
const PLACEHOLDER = /\/images\/artist\/\//i
const MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000
const ERROR_RETRY_MS = 60 * 60 * 1000
const MAX_BYTES = 8 * 1024 * 1024
const MAX_QUEUE = 500
const GAP_MS = 300
const FILE_RE = /^([0-9a-f]{40})\.([0-9a-f]{16})\.jpg$/
const MISS_RE = /^([0-9a-f]{40})\.none$/

const sha1 = (value) => crypto.createHash('sha1').update(value).digest('hex')

// Smaller Deezer rendition: ".../1000x1000-000000-80-0-0.jpg" → 500x500.
export function smallerDeezerPicture(url) {
  return String(url || '').replace(/\/(\d{3,4})x\1-/, (m, n) => (Number(n) > 500 ? '/500x500-' : m))
}

export function isUsablePhotoUrl(url) {
  return PHOTO_HOSTS.test(String(url || '')) && !PLACEHOLDER.test(String(url))
}

export function createArtistPhotos({ cacheDir, db, logger = console, fetchImpl = fetch, now = () => Date.now(), gapMs = GAP_MS }) {
  const dir = path.join(cacheDir, 'artwork', 'artist')
  fs.mkdirSync(dir, { recursive: true })
  const nameKeyStmt = db.prepare('SELECT name, name_key FROM artists WHERE id = ?')
  // name hash → { file, key } | { missAt } ; filled from one directory read.
  let states = null
  const errors = new Map()
  const queue = []
  const queued = new Set()
  const listeners = new Set()
  let resolver = null
  let running = false
  let stopped = false

  function load() {
    if (states) return states
    states = new Map()
    let names = []
    try { names = fs.readdirSync(dir) } catch {}
    for (const name of names) {
      let m = FILE_RE.exec(name)
      if (m) { states.set(m[1], { file: path.join(dir, name), key: `artist-${m[2]}` }); continue }
      m = MISS_RE.exec(name)
      if (m && !states.has(m[1])) {
        let missAt = 0
        try { missAt = fs.statSync(path.join(dir, name)).mtimeMs } catch {}
        states.set(m[1], { missAt })
      }
    }
    return states
  }

  function artistRow(artistId) {
    try { return nameKeyStmt.get(Number(artistId)) || null } catch { return null }
  }

  function stateOf(nameKey) {
    return nameKey ? load().get(sha1(nameKey)) || null : null
  }

  /** The stored photo of a library artist: { file, key, contentType, stable } or null. */
  function photo(artistId) {
    const st = stateOf(artistRow(artistId)?.name_key)
    return st?.file ? { file: st.file, key: st.key, contentType: 'image/jpeg', stable: true } : null
  }

  /** Short token for artwork URLs: changes when a photo arrives. */
  function token(artistId) {
    const st = stateOf(artistRow(artistId)?.name_key)
    return st?.file ? st.key : ''
  }

  function enqueue(job) {
    if (stopped || queued.has(job.hash)) return
    if (queue.length >= MAX_QUEUE) return
    queued.add(job.hash)
    queue.push(job)
    pump()
  }

  // Asks for a photo of an artist whose artwork is being shown. Nothing
  // happens when one is stored, a recent "none" is known or Deezer is off.
  function want(artistId) {
    if (!resolver) return
    const row = artistRow(artistId)
    if (!row?.name_key) return
    const hash = sha1(row.name_key)
    const st = load().get(hash)
    if (st?.file || (st && now() - st.missAt < MISS_TTL_MS)) return
    if (now() - (errors.get(hash) || 0) < ERROR_RETRY_MS) return
    enqueue({ hash, artistId: Number(artistId), name: row.name, url: null })
  }

  // A photo URL seen on an online page for an artist that is in the library
  // (same normalized name only, so a namesake never lends its face).
  function remember(artistId, onlineName, url) {
    const row = artistRow(artistId)
    if (!row?.name_key || normalizeKey(onlineName) !== row.name_key) return
    const hash = sha1(row.name_key)
    if (load().get(hash)?.file) return
    if (!isUsablePhotoUrl(url)) return
    enqueue({ hash, artistId: Number(artistId), name: row.name, url })
  }

  async function writeMiss(hash) {
    const file = path.join(dir, `${hash}.none`)
    try { await fs.promises.writeFile(file, '') } catch {}
    load().set(hash, { missAt: now() })
  }

  async function save(hash, bytes) {
    const key = sha1(bytes).slice(0, 16)
    const file = path.join(dir, `${hash}.${key}.jpg`)
    const tmp = `${file}.${process.pid}.tmp`
    await fs.promises.writeFile(tmp, bytes)
    await fs.promises.rename(tmp, file)
    // Old files of this artist (an earlier photo or a "none" marker).
    try {
      for (const name of await fs.promises.readdir(dir)) {
        if (name.startsWith(`${hash}.`) && name !== path.basename(file) && !name.endsWith('.tmp')) await fs.promises.rm(path.join(dir, name), { force: true })
      }
    } catch {}
    load().set(hash, { file, key: `artist-${key}` })
  }

  async function run(job) {
    let url = job.url
    if (!url) {
      url = await resolver(job.name)
      if (url === undefined) return // provider off: decide later
    }
    if (!url || !isUsablePhotoUrl(url)) return writeMiss(job.hash)
    const res = await fetchImpl(smallerDeezerPicture(url), { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (!/^image\//i.test(res.headers?.get?.('content-type') || 'image/jpeg')) throw new Error('not an image')
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length < 1000 || bytes.length > MAX_BYTES) throw new Error('bad size')
    await save(job.hash, bytes)
    for (const fn of listeners) { try { fn(job.artistId) } catch {} }
  }

  async function pump() {
    if (running) return
    running = true
    try {
      while (queue.length && !stopped) {
        const job = queue.shift()
        try {
          await run(job)
        } catch (error) {
          errors.set(job.hash, now())
          if (errors.size > 5000) errors.clear()
          logger.debug?.(`[player] artist photo for ${job.name} failed: ${error?.message || error}`)
        } finally {
          queued.delete(job.hash)
        }
        if (queue.length && gapMs) await new Promise((resolve) => { const t = setTimeout(resolve, gapMs); t.unref?.() })
      }
    } finally {
      running = false
    }
  }

  return {
    photo,
    token,
    want,
    remember,
    /** fn(name) → Promise<url | null (no photo) | undefined (cannot tell now)>. */
    setResolver(fn) { resolver = typeof fn === 'function' ? fn : null },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    idle: () => !running && !queue.length,
    stop() { stopped = true; queue.length = 0; queued.clear() }
  }
}
