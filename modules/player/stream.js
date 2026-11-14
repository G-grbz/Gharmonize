import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as binaries from '../binaries.js'
import { spawnSafe } from '../safeProcess.js'
import { terminateProcess } from '../processTermination.js'

const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.alac': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.aifc': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-ape',
  '.wv': 'audio/x-wavpack',
  '.mka': 'audio/x-matroska',
  '.dsf': 'audio/x-dsf',
  '.dff': 'audio/x-dff',
  '.mpc': 'audio/x-musepack',
  '.tta': 'audio/x-tta'
}

export const TRANSCODE_FORMATS = {
  mp3: { contentType: 'audio/mpeg', ext: '.mp3', bitrates: [128, 192, 256, 320], defaultBitrate: 320, sourceExts: ['.mp3'], args: (kbps) => ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-f', 'mp3'] },
  opus: { contentType: 'audio/ogg', ext: '.opus', bitrates: [64, 96, 128, 160, 192, 256], defaultBitrate: 128, sourceExts: ['.opus'], args: (kbps) => ['-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'on', '-f', 'ogg'] },
  aac: { contentType: 'audio/aac', ext: '.aac', bitrates: [128, 192, 256], defaultBitrate: 256, sourceExts: ['.aac', '.m4a'], args: (kbps) => ['-c:a', 'aac', '-b:a', `${kbps}k`, '-f', 'adts'] }
}

// Named presets used by clients (e.g. Wi-Fi vs. mobile data).
export const QUALITY_PRESETS = {
  original: null,
  lossless: null,
  high: { format: 'opus', bitrate: 192 },
  normal: { format: 'opus', bitrate: 128 },
  low: { format: 'opus', bitrate: 96 },
  saver: { format: 'opus', bitrate: 64 }
}

export function contentTypeForFile(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

// Resolves the requested output. Returns null for "serve the original file".
export function resolveStreamTarget({ quality, format, bitrate } = {}, track = {}) {
  let target = null
  const preset = String(quality || '').toLowerCase()
  if (preset && Object.prototype.hasOwnProperty.call(QUALITY_PRESETS, preset)) target = QUALITY_PRESETS[preset]
  const fmt = String(format || '').toLowerCase()
  if (fmt === 'original' || fmt === 'raw') target = null
  else if (TRANSCODE_FORMATS[fmt]) target = { format: fmt, bitrate: Number(bitrate) || TRANSCODE_FORMATS[fmt].defaultBitrate }
  if (!target) return null
  const spec = TRANSCODE_FORMATS[target.format]
  const kbps = spec.bitrates.reduce((best, b) => (Math.abs(b - target.bitrate) < Math.abs(best - target.bitrate) ? b : best), spec.bitrates[0])
  // Never "upgrade" a lossy file into the same codec at a higher bitrate.
  const ext = path.extname(String(track.rel_path || '')).toLowerCase()
  const sourceKbps = Number(track.bitrate) > 0 ? Number(track.bitrate) / 1000 : 0
  if (!track.lossless && spec.sourceExts.includes(ext) && sourceKbps > 0 && sourceKbps <= kbps * 1.1) return null
  return { format: target.format, bitrate: kbps }
}

// Parses a single "bytes=" range. Returns {start,end}, null (no/ignored range)
// or 'invalid' (unsatisfiable).
export function parseRange(header, size) {
  const value = String(header || '').trim()
  if (!value) return null
  const match = value.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return value.startsWith('bytes=') && value.includes(',') ? null : 'invalid'
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return 'invalid'
  let start
  let end
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!suffix) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid'
  return { start, end }
}

export async function sendFileWithRange(req, res, file, { contentType, cacheControl = 'private, max-age=86400', etag = null } = {}) {
  let st
  try { st = await fs.promises.stat(file) } catch {
    res.status(404).json({ error: { code: 'FILE_MISSING', message: 'The audio file is no longer available.' } })
    return
  }
  const size = st.size
  const tag = etag || `"${size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', contentType || contentTypeForFile(file))
  res.setHeader('Cache-Control', cacheControl)
  res.setHeader('ETag', tag)
  res.setHeader('Last-Modified', st.mtime.toUTCString())

  let range = parseRange(req.headers.range, size)
  const ifRange = req.headers['if-range']
  if (range && ifRange && ifRange !== tag) range = null
  if (range === 'invalid') {
    res.setHeader('Content-Range', `bytes */${size}`)
    res.status(416).end()
    return
  }
  if (!range && req.headers['if-none-match'] === tag) {
    res.status(304).end()
    return
  }
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  if (range) {
    res.status(206)
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  } else {
    res.status(200)
  }
  res.setHeader('Content-Length', String(size === 0 ? 0 : end - start + 1))
  if (req.method === 'HEAD' || size === 0) {
    res.end()
    return
  }
  const stream = fs.createReadStream(file, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.waiters = [] }
  async acquire() {
    if (this.active < this.max) { this.active += 1; return }
    await new Promise((resolve) => this.waiters.push(resolve))
    this.active += 1
  }
  release() {
    this.active -= 1
    const next = this.waiters.shift()
    if (next) next()
  }
}

export function createStreamService({ cacheDir, libraries, getCacheLimitBytes = () => 2 * 1024 ** 3, maxConcurrentTranscodes = 3, logger = console }) {
  const dir = path.join(cacheDir, 'transcode')
  fs.mkdirSync(dir, { recursive: true })
  const jobs = new Map()
  const semaphore = new Semaphore(maxConcurrentTranscodes)
  let cleanupTimer = null
  let stopped = false

  function cacheKey(abs, st, target) {
    return crypto.createHash('sha1')
      .update(`${abs}\0${st.size}\0${Math.floor(st.mtimeMs)}\0${target.format}\0${target.bitrate}`)
      .digest('hex')
  }

  // Starts (or joins) a transcode job that writes into a temp file. The job
  // keeps running when the requesting client disconnects, so the next request
  // (e.g. a seek with a Range header) is served from the finished cache file.
  function startJob(key, abs, target, finalFile) {
    if (jobs.has(key)) return jobs.get(key)
    const spec = TRANSCODE_FORMATS[target.format]
    const tmp = path.join(dir, `${key}.${process.pid}.part`)
    const job = new EventEmitter()
    job.setMaxListeners(50)
    job.tmp = tmp
    job.bytes = 0
    job.done = false
    job.error = null
    job.finalFile = finalFile
    job.finished = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject })
    job.finished.catch(() => {})
    jobs.set(key, job)

    ;(async () => {
      await semaphore.acquire()
      try {
        if (stopped) throw new Error('Player stopped')
        await fs.promises.writeFile(tmp, '')
        job.emit('started')
        await new Promise((resolve, reject) => {
          const args = [
            '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
            '-i', abs,
            '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-ac', '2',
            ...spec.args(target.bitrate),
            tmp
          ]
          let child
          try { child = spawnSafe(binaries.FFMPEG_BIN || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }) } catch (error) { reject(error); return }
          job.child = child
          let stderr = ''
          child.stderr?.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk })
          const poll = setInterval(() => {
            fs.promises.stat(tmp).then((st) => {
              if (st.size > job.bytes) { job.bytes = st.size; job.emit('progress') }
            }).catch(() => {})
          }, 150)
          child.once('error', (error) => { clearInterval(poll); reject(error) })
          child.once('close', (code, signal) => {
            clearInterval(poll)
            if (code === 0) resolve()
            else reject(new Error(`ffmpeg ${signal || code}: ${stderr.trim().split('\n').pop() || ''}`))
          })
        })
        const st = await fs.promises.stat(tmp)
        job.bytes = st.size
        await fs.promises.rename(tmp, finalFile)
        job.done = true
        job.emit('progress')
        job.resolve(finalFile)
        scheduleCleanup()
      } catch (error) {
        job.error = error
        job.done = true
        try { await fs.promises.rm(tmp, { force: true }) } catch {}
        job.emit('progress')
        job.reject(error)
        if (!stopped) logger.warn?.(`⚠️ [player] transcode failed: ${error?.message || error}`)
      } finally {
        semaphore.release()
        jobs.delete(key)
      }
    })()
    return job
  }

  // Streams a file that is still being written by a running job.
  async function streamGrowing(req, res, job, contentType) {
    res.status(200)
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Accept-Ranges', 'none')
    res.setHeader('X-Gharmonize-Transcode', 'live')
    if (req.method === 'HEAD') { res.end(); return }
    let closed = false
    res.on('close', () => { closed = true; job.emit('client-gone') })
    let offset = 0
    let fd = null
    const wait = () => new Promise((resolve) => {
      const timer = setTimeout(done, 500)
      function done() { clearTimeout(timer); job.off('progress', done); job.off('client-gone', done); resolve() }
      job.once('progress', done)
      job.once('client-gone', done)
    })
    try {
      while (!closed) {
        if (job.error) throw job.error
        if (!fd) {
          const source = job.done ? job.finalFile : job.tmp
          try { fd = await fs.promises.open(source, 'r') } catch {
            if (job.done) break
            await wait()
            continue
          }
        }
        const buffer = Buffer.allocUnsafe(64 * 1024)
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, offset)
        if (bytesRead > 0) {
          offset += bytesRead
          if (!res.write(buffer.subarray(0, bytesRead))) {
            await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve) })
          }
          continue
        }
        if (job.done) break
        await wait()
      }
    } catch (error) {
      if (!res.headersSent) res.status(500)
      res.destroy(error)
      return
    } finally {
      try { await fd?.close() } catch {}
    }
    if (!closed) res.end()
  }

  async function serveTrack(req, res, trackRow, query = {}) {
    const abs = libraries.resolveTrackFile(trackRow)
    if (!abs) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Track not found.' } })
    let st
    try { st = await fs.promises.stat(abs) } catch {
      return res.status(404).json({ error: { code: 'FILE_MISSING', message: 'The audio file is no longer available.' } })
    }
    const target = resolveStreamTarget(query, trackRow)
    if (!target) {
      res.setHeader('X-Gharmonize-Transcode', 'original')
      return sendFileWithRange(req, res, abs, { contentType: contentTypeForFile(abs) })
    }
    const spec = TRANSCODE_FORMATS[target.format]
    const key = cacheKey(abs, st, target)
    const finalFile = path.join(dir, key + spec.ext)
    if (fs.existsSync(finalFile)) {
      const now = new Date()
      fs.promises.utimes(finalFile, now, now).catch(() => {})
      res.setHeader('X-Gharmonize-Transcode', 'cached')
      return sendFileWithRange(req, res, finalFile, { contentType: spec.contentType })
    }
    const job = startJob(key, abs, target, finalFile)
    const range = parseRange(req.headers.range, Number.MAX_SAFE_INTEGER)
    const wantsSeek = range && range !== 'invalid' && range.start > 0
    if (wantsSeek) {
      // A seek needs byte offsets: wait for the (fast) transcode to finish.
      try { await job.finished } catch {
        return res.status(500).json({ error: { code: 'TRANSCODE_FAILED', message: 'Transcoding failed.' } })
      }
      res.setHeader('X-Gharmonize-Transcode', 'cached')
      return sendFileWithRange(req, res, finalFile, { contentType: spec.contentType })
    }
    return streamGrowing(req, res, job, spec.contentType)
  }

  function scheduleCleanup() {
    if (cleanupTimer || stopped) return
    cleanupTimer = setTimeout(() => {
      cleanupTimer = null
      cleanup().catch(() => {})
    }, 5000)
    cleanupTimer.unref?.()
  }

  async function cleanup() {
    const limit = Math.max(0, Number(getCacheLimitBytes()) || 0)
    const names = await fs.promises.readdir(dir)
    const files = []
    let total = 0
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        const st = await fs.promises.stat(file)
        if (name.endsWith('.part')) {
          // Stale partials from a crash.
          if (Date.now() - st.mtimeMs > 60 * 60 * 1000) await fs.promises.rm(file, { force: true })
          continue
        }
        files.push({ file, size: st.size, time: st.mtimeMs })
        total += st.size
      } catch {}
    }
    files.sort((a, b) => a.time - b.time)
    for (const entry of files) {
      if (total <= limit) break
      try { await fs.promises.rm(entry.file, { force: true }); total -= entry.size } catch {}
    }
    return { totalBytes: total, files: files.length }
  }

  async function getCacheUsage() {
    let total = 0
    let count = 0
    for (const name of await fs.promises.readdir(dir).catch(() => [])) {
      try { const st = await fs.promises.stat(path.join(dir, name)); total += st.size; count += 1 } catch {}
    }
    return { bytes: total, files: count }
  }

  async function clearCache() {
    for (const name of await fs.promises.readdir(dir).catch(() => [])) {
      if (name.endsWith('.part')) continue
      await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => {})
    }
  }

  async function stop() {
    stopped = true
    if (cleanupTimer) clearTimeout(cleanupTimer)
    for (const job of jobs.values()) {
      if (job.child) terminateProcess(job.child)
    }
    await Promise.allSettled([...jobs.values()].map((job) => job.finished))
  }

  return { serveTrack, cleanup, getCacheUsage, clearCache, stop, activeJobs: () => jobs.size }
}
