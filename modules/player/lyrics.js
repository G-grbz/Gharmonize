import fs from 'node:fs'
import path from 'node:path'

const MAX_LRC_BYTES = 512 * 1024
const CACHE_MAX = 300

// Parses LRC text into [{ timeMs, text }]. Returns [] if it is not synced.
export function parseLrc(text) {
  const lines = []
  let offset = 0
  for (const raw of String(text || '').split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\s*\]/i)
    if (off) { offset = Number(off[1]) || 0; continue }
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (!stamps.length) continue
    const content = raw.replace(/\[[^\]]*\]/g, '').trim()
    for (const stamp of stamps) {
      const frac = stamp[3] ? Number(stamp[3].padEnd(3, '0').slice(0, 3)) : 0
      const timeMs = Number(stamp[1]) * 60_000 + Number(stamp[2]) * 1000 + frac - offset
      lines.push({ timeMs: Math.max(0, timeMs), text: content })
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs)
}

function plainFromLrc(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.replace(/\[[^\]]*\]/g, '').trim()).join('\n').trim()
}

function result(source, { synced = null, plain = null } = {}) {
  const lines = synced ? parseLrc(synced) : []
  const plainText = plain || (synced ? plainFromLrc(synced) : '')
  if (!lines.length && !plainText) return null
  return { source, synced: lines.length > 0, lines, plain: plainText }
}

export function createLyricsService({ libraries, getOnlineAllowed = () => true, fetchOnline = null, parseFile = null, logger = console }) {
  const cache = new Map()

  function remember(key, value) {
    cache.set(key, value)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
    return value
  }

  async function fromSidecar(abs) {
    const base = abs.slice(0, abs.length - path.extname(abs).length)
    for (const candidate of [`${base}.lrc`, `${base}.LRC`, `${base}.txt`]) {
      let file
      try {
        file = await fs.promises.open(candidate, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0))
        const st = await file.stat()
        if (!st.isFile() || st.size > MAX_LRC_BYTES) continue
        // Read the inspected descriptor, with a hard cap if the file grows.
        const bytes = Buffer.alloc(MAX_LRC_BYTES + 1)
        let size = 0
        while (size < bytes.length) {
          const { bytesRead } = await file.read(bytes, size, bytes.length - size, null)
          if (!bytesRead) break
          size += bytesRead
        }
        if (size > MAX_LRC_BYTES) continue
        const text = bytes.toString('utf8', 0, size)
        const isLrc = /\.lrc$/i.test(candidate)
        const found = result('file', isLrc ? { synced: text } : { plain: text.trim() })
        if (found) return found
      } catch {} finally { await file?.close().catch(() => {}) }
    }
    return null
  }

  async function fromEmbedded(abs) {
    try {
      const parse = parseFile || (await import('music-metadata')).parseFile
      const meta = await parse(abs, { skipCovers: true, duration: false })
      const entries = Array.isArray(meta?.common?.lyrics) ? meta.common.lyrics : []
      for (const entry of entries) {
        if (typeof entry === 'string') {
          const found = /\[\d{1,3}:\d{1,2}/.test(entry) ? result('embedded', { synced: entry }) : result('embedded', { plain: entry })
          if (found) return found
          continue
        }
        if (Array.isArray(entry?.syncText) && entry.syncText.length) {
          const lines = entry.syncText
            .filter((l) => l && typeof l.text === 'string')
            .map((l) => ({ timeMs: Math.max(0, Number(l.timestamp) || 0), text: l.text.trim() }))
            .sort((a, b) => a.timeMs - b.timeMs)
          if (lines.length) return { source: 'embedded', synced: true, lines, plain: lines.map((l) => l.text).join('\n') }
        }
        const text = String(entry?.text || '').trim()
        if (text) {
          const found = /\[\d{1,3}:\d{1,2}/.test(text) ? result('embedded', { synced: text }) : result('embedded', { plain: text })
          if (found) return found
        }
      }
    } catch (error) {
      logger.debug?.(`[player] embedded lyrics read failed: ${error?.message || error}`)
    }
    return null
  }

  async function fromOnline(track) {
    if (!getOnlineAllowed()) return null
    try {
      const fetcher = fetchOnline || (async (artist, title, duration) => {
        const { lyricsFetcher } = await import('../lyrics.js')
        return lyricsFetcher.searchLyrics(artist, title, duration)
      })
      const data = await fetcher(track.artist_name, track.title, track.duration)
      if (!data) return null
      return result('lrclib', { synced: data.syncedLyrics || null, plain: data.plainLyrics || null })
    } catch {
      return null
    }
  }

  async function getLyrics(track) {
    const abs = libraries.resolveTrackFile(track)
    if (!abs) return null
    const key = `${track.id}:${track.mtime_ms}`
    if (cache.has(key)) return cache.get(key)
    const found = (await fromSidecar(abs)) || (track.has_lyrics ? await fromEmbedded(abs) : null) || (await fromOnline(track))
    return remember(key, found)
  }

  return { getLyrics }
}
