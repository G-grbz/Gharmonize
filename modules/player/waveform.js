import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as binaries from '../binaries.js'
import { spawnSafe } from '../safeProcess.js'
import { terminateProcess } from '../processTermination.js'

// Real waveform data for the seek bar ("wave" progress style). The audio is
// decoded once to a small mono 8 kHz stream, reduced to loudness per 50 ms
// window and then to a fixed number of bins; the result is cached as a tiny
// JSON file next to the transcode cache. Nothing runs unless a client asks.

export const WAVEFORM_BINS = 240
const SAMPLE_RATE = 8000
const WINDOW = 400 // samples per window (50 ms)
const VERSION = 2
const TIMEOUT_MS = 90_000

// Reduces per-window RMS values to `bins` values in 0..100. Each bin keeps the
// loudest window inside it, so short hits stay visible, and the result is
// scaled to the loudest bin. Mastered music is loud almost everywhere, so a
// mild expansion curve makes its dynamics (intro, verse, drop) readable.
export function reduceWindows(windows, bins = WAVEFORM_BINS) {
  const out = new Array(bins).fill(0)
  if (!windows.length) return out
  for (let i = 0; i < bins; i += 1) {
    const from = Math.floor((i * windows.length) / bins)
    const to = Math.max(from + 1, Math.floor(((i + 1) * windows.length) / bins))
    let max = 0
    for (let j = from; j < to && j < windows.length; j += 1) if (windows[j] > max) max = windows[j]
    out[i] = max
  }
  const peak = Math.max(...out)
  if (!(peak > 0)) return out.map(() => 0)
  return out.map((v) => Math.max(0, Math.min(100, Math.round(Math.pow(v / peak, 1.5) * 100))))
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
    this.waiters.shift()?.()
  }
}

export function createWaveformService({ cacheDir, libraries, maxConcurrent = 2, logger = console, spawn = spawnSafe }) {
  const dir = path.join(cacheDir, 'waveform')
  fs.mkdirSync(dir, { recursive: true })
  const jobs = new Map()
  const semaphore = new Semaphore(maxConcurrent)
  const children = new Set()
  let stopped = false

  function analyze(abs) {
    return new Promise((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', abs,
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE),
        '-f', 's16le', 'pipe:1'
      ]
      let child
      try { child = spawn(binaries.FFMPEG_BIN || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) { reject(error); return }
      children.add(child)
      const windows = []
      let sum = 0
      let count = 0
      let carry = null
      let stderr = ''
      const timer = setTimeout(() => terminateProcess(child), TIMEOUT_MS)
      child.stdout.on('data', (chunk) => {
        let buf = carry ? Buffer.concat([carry, chunk]) : chunk
        const usable = buf.length - (buf.length % 2)
        carry = usable < buf.length ? buf.subarray(usable) : null
        for (let i = 0; i < usable; i += 2) {
          const s = buf.readInt16LE(i) / 32768
          sum += s * s
          count += 1
          if (count === WINDOW) {
            windows.push(Math.sqrt(sum / count))
            sum = 0
            count = 0
          }
        }
      })
      child.stderr?.on('data', (chunk) => { if (stderr.length < 2000) stderr += chunk })
      child.once('error', (error) => { clearTimeout(timer); children.delete(child); reject(error) })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        children.delete(child)
        if (count > WINDOW / 4) windows.push(Math.sqrt(sum / count))
        if (code === 0 && windows.length) resolve(reduceWindows(windows))
        else reject(new Error(`ffmpeg ${signal || code}: ${stderr.trim().split('\n').pop() || 'no audio'}`))
      })
    })
  }

  // Returns { bins } for a library track row, or null when the file is gone.
  async function getWaveform(trackRow) {
    const abs = libraries.resolveTrackFile(trackRow)
    if (!abs) return null
    let st
    try { st = await fs.promises.stat(abs) } catch { return null }
    const key = crypto.createHash('sha1').update(`${abs}\0${st.size}\0${Math.floor(st.mtimeMs)}\0${VERSION}\0${WAVEFORM_BINS}`).digest('hex')
    const file = path.join(dir, `${key}.json`)
    try {
      const cached = JSON.parse(await fs.promises.readFile(file, 'utf8'))
      if (Array.isArray(cached?.bins)) return { bins: cached.bins }
    } catch {}
    if (jobs.has(key)) return jobs.get(key)
    const job = (async () => {
      await semaphore.acquire()
      try {
        if (stopped) throw new Error('Player stopped')
        const bins = await analyze(abs)
        const tmp = `${file}.${process.pid}.tmp`
        await fs.promises.writeFile(tmp, JSON.stringify({ v: VERSION, bins }))
        await fs.promises.rename(tmp, file)
        return { bins }
      } finally {
        semaphore.release()
        jobs.delete(key)
      }
    })()
    jobs.set(key, job)
    job.catch((error) => { if (!stopped) logger.warn?.(`⚠️ [player] waveform failed: ${error?.message || error}`) })
    return job
  }

  async function stop() {
    stopped = true
    for (const child of children) terminateProcess(child)
    children.clear()
  }

  return { getWaveform, stop, dir }
}
