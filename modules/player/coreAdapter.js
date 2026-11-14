// Adapter between Gharmonize Player and the existing Gharmonize download
// pipeline. It only *uses* exported core functions (createJob, enqueueJob,
// processJob, URL resolvers, Spotify→YouTube mapping); nothing in the core is
// changed. Core modules are imported lazily, the first time a download runs.

import fs from 'node:fs'
import path from 'node:path'
import { AUDIO_EXTENSIONS, normalizeKey } from './scanner.js'
import { toFrozenEntries } from './ytTitles.js'
import { cleanTitleForMatch, primaryArtistKey } from './songKey.js'

export class BridgeError extends Error {
  constructor(code, message, { status = 400, permanent = false } = {}) {
    super(message)
    this.code = code
    this.status = status
    this.permanent = permanent
  }
}

export const DOWNLOAD_FORMATS = {
  // 'auto' = variable bitrate (same as the classic interface's "Auto").
  mp3: { bitrates: ['auto', '128k', '192k', '256k', '320k'], defaultBitrate: '320k' },
  flac: { bitrates: ['lossless'], defaultBitrate: 'lossless' },
  ogg: { bitrates: ['auto', '128k', '192k', '256k', '320k'], defaultBitrate: '256k' },
  aac: { bitrates: ['128k', '192k', '256k', '320k'], defaultBitrate: '256k' }
}

let modsPromise = null
function loadCore() {
  modsPromise ||= Promise.all([
    import('../store.js'),
    import('../queue.js'),
    import('../processor.js'),
    import('../yt.js'),
    import('../spotify.js'),
    import('../apple.js'),
    import('../deezer.js'),
    import('../tidal.js'),
    import('../soundcloud.js'),
    import('../mappedMusicCache.js'),
    import('../market.js'),
    import('../concurrency.js'),
    import('../outputPaths.js'),
    import('../security.js'),
    import('../ytMusicMetadata.js')
  ]).then(([store, queue, processor, yt, spotify, apple, deezer, tidal, soundcloud, mappedCache, market, concurrency, outputPaths, security, ytMusic]) => ({
    store, queue, processor, yt, spotify, apple, deezer, tidal, soundcloud, mappedCache, market, concurrency, outputPaths, security, ytMusic
  })).catch((error) => { modsPromise = null; throw error })
  return modsPromise
}

function mappedSource(m, url) {
  if (m.apple.isAppleMusicUrl(url)) return { source: 'apple_music', label: 'Apple Music', resolve: () => m.apple.resolveAppleMusicUrl(url, { market: m.market.resolveMarket() }) }
  if (m.deezer.isDeezerUrl(url)) return { source: 'deezer', label: 'Deezer', resolve: () => m.deezer.resolveDeezerUrl(url, { market: m.market.resolveMarket() }) }
  if (m.tidal.isTidalUrl(url)) return { source: 'tidal', label: 'TIDAL', resolve: () => m.tidal.resolveTidalUrl(url, { market: m.market.resolveMarket(), maxItems: 1000 }) }
  if (m.soundcloud.isSoundCloudUrl(url)) return { source: 'soundcloud', label: 'SoundCloud', resolve: () => m.soundcloud.resolveSoundCloudUrl(url, { maxItems: 1000 }) }
  if (m.spotify.isSpotifyUrl(url)) return { source: 'spotify', label: 'Spotify', resolve: () => m.spotify.resolveSpotifyUrl(url, { market: m.market.resolveMarket() }) }
  return null
}

// The same YouTube playlist preparation the classic UI + jobs route do: list
// the entries, clean each title/uploader exactly like the classic preview,
// then apply the core's YouTube Music album normalisation. Without this the
// core only sees bare playlist indexes and cannot name, match or tag tracks.
export async function prepareYouTubePlaylist(m, url, { isAutomix = false } = {}) {
  const all = isAutomix ? await m.yt.extractAutomixAllFlat(url) : await m.yt.extractPlaylistAllFlat(url)
  const items = Array.isArray(all?.items) ? all.items.filter(Boolean) : []
  if (!items.length) return null
  const playlistTitle = String(all?.title || '').trim()
  const parentMeta = { title: playlistTitle, playlist_title: playlistTitle, url, webpage_url: url }
  const normalizedTitle = m.ytMusic.normalizeYtMusicAlbumTitle(playlistTitle, { meta: parentMeta, sourceUrl: url })
  const frozenEntries = toFrozenEntries(items).map((entry) => m.ytMusic.normalizeYtMusicAlbumEntry(entry, {
    parentMeta,
    playlistTitle: normalizedTitle || playlistTitle,
    sourceUrl: url
  }))
  const ids = items.map((item) => item.id || null)
  const out = {
    frozenEntries,
    // Classic only pins ids when every entry has one.
    selectedIds: ids.length && ids.every(Boolean) ? ids : null,
    frozenTitle: playlistTitle ? (normalizedTitle || playlistTitle) : null,
    albumArtist: ''
  }
  if (m.ytMusic.isYtMusicAlbumContext(parentMeta, url)) {
    out.albumArtist = m.ytMusic.pickYtMusicAlbumArtist(...frozenEntries.slice(0, 12)) || ''
  }
  return out
}

// Collects absolute output files from a finished core job.
export function collectJobOutputs(job, resolveDownloadPathToAbs) {
  const raw = job?.resultPath
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : []
  const files = []
  for (const entry of entries) {
    const value = typeof entry === 'string' ? entry : (entry?.outputPath || entry?.path)
    if (!value) continue
    const abs = path.isAbsolute(value) && !String(value).startsWith('/download/')
      ? value
      : resolveDownloadPathToAbs(value)
    if (abs && AUDIO_EXTENSIONS.has(path.extname(abs).toLowerCase())) files.push(abs)
  }
  return [...new Set(files)]
}

// ---- substitute for a YouTube video that cannot be played here --------------

const fold = (text) => normalizeKey(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
// Versions that sound different from the studio recording.
const VARIANT_RE = /(^| )(live|canli|konser|concert|cover|remix|rmx|slowed|sped|speed up|nightcore|karaoke|instrumental|8d|reverb|acoustic|akustik)( |$)/

export function youTubeVideoId(url) {
  try {
    const u = new URL(String(url || ''))
    const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v')
    return /^[A-Za-z0-9_-]{11}$/.test(String(id || '')) ? id : null
  } catch { return null }
}

// Region-blocked or removed uploads (often YouTube Music "song" entries) have
// public copies: the artist's official video, a lyrics upload... Picks the
// one with the same artist, the same song title and about the same length.
export function pickAlternativeVideo(entries, { title, artist, duration = 0, excludeId = null } = {}) {
  const wantTitle = fold(cleanTitleForMatch(title) || title)
  const wantArtist = fold(primaryArtistKey(artist) || artist)
  if (!wantTitle || !wantArtist) return null
  const wantWords = wantTitle.split(' ')
  const wantVariant = VARIANT_RE.test(fold(title))
  const want = Number(duration) || 0
  let best = null
  ;(Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    const id = String(entry?.id || '')
    if (!/^[A-Za-z0-9_-]{11}$/.test(id) || id === excludeId) return
    const text = fold(entry.title)
    const channel = fold(entry.channel || entry.uploader)
    const words = new Set(text.split(' '))
    if (!wantWords.every((w) => words.has(w))) return
    if (!text.includes(wantArtist) && !channel.includes(wantArtist)) return
    if (!wantVariant && VARIANT_RE.test(text)) return
    const length = Number(entry.duration) || 0
    if (want > 0 && length > 0 && Math.abs(length - want) > Math.max(6, want * 0.06)) return
    let score = -index * 0.01
    if (channel.includes(wantArtist)) score += 3
    if (/(^| )(official|resmi)( |$)/.test(text)) score += 2
    if (/ topic$/.test(channel)) score += 2
    if (want > 0 && length > 0) score += 1
    if (!best || score > best.score) best = { id, title: entry.title, score }
  })
  return best
}

export function createCoreAdapter({ logger = console } = {}) {
  async function inspect(url) {
    const m = await loadCore()
    let safe
    try { safe = await m.security.assertSafeRemoteUrl(url) } catch (error) {
      throw new BridgeError('UNSAFE_SOURCE_URL', error.message, { permanent: true })
    }
    if (m.yt.isYouTubeUrl(safe)) {
      const normalized = m.yt.normalizeYouTubeUrl(safe)
      return { provider: 'youtube', url: normalized, isPlaylist: m.yt.isYouTubePlaylist(normalized) || m.yt.isYouTubeAutomix(normalized) }
    }
    const mapped = mappedSource(m, safe)
    if (mapped) return { provider: mapped.source === 'apple_music' ? 'apple' : mapped.source, url: safe, isPlaylist: true }
    throw new BridgeError('UNSUPPORTED_SOURCE', 'This link cannot be downloaded into the library.', { permanent: true })
  }

  async function createAndEnqueue({ url, preset, tag }) {
    const m = await loadCore()
    const info = await inspect(url)
    const format = DOWNLOAD_FORMATS[preset.format] ? preset.format : 'mp3'
    const bitrate = DOWNLOAD_FORMATS[format].bitrates.includes(preset.bitrate) ? preset.bitrate : DOWNLOAD_FORMATS[format].defaultBitrate
    const common = {
      includeLyrics: Boolean(preset.lyrics),
      embedLyrics: Boolean(preset.lyrics),
      spotifyConcurrency: m.concurrency.resolveSpotifyConcurrency(undefined, undefined),
      youtubeConcurrency: m.concurrency.parseConcurrency(undefined, 4),
      stereoConvert: 'auto',
      atempoAdjust: 'none',
      compressionLevel: format === 'flac' ? 5 : null,
      selectedStreams: null,
      ringtone: null,
      loudnorm: false,
      loudnormMode: null,
      // Classic sends the volume slider value (1.0 = unchanged).
      volumeGain: 1,
      autoCreateZip: false,
      // Lets the classic jobs panel show where a job came from.
      playerDownloadId: tag
    }

    let metadata
    if (info.provider === 'youtube') {
      const isAutomix = m.yt.isYouTubeAutomix(info.url)
      metadata = {
        source: 'youtube',
        mediaPlatform: 'youtube',
        url: info.url,
        originalUrl: url,
        isPlaylist: info.isPlaylist,
        isAutomix,
        selectedIndices: info.isPlaylist ? 'all' : null
      }
      if (info.isPlaylist) {
        let prepared
        try { prepared = await prepareYouTubePlaylist(m, info.url, { isAutomix }) } catch (error) {
          // Transient (network / YouTube); the bridge retries with backoff.
          throw new BridgeError('SOURCE_RESOLVE_FAILED', String(error?.message || error).slice(0, 300))
        }
        if (!prepared) throw new BridgeError('SOURCE_EMPTY', 'The playlist is empty or could not be read.', { permanent: true })
        metadata.frozenEntries = prepared.frozenEntries
        if (prepared.selectedIds) metadata.selectedIds = prepared.selectedIds
        if (prepared.frozenTitle) metadata.frozenTitle = prepared.frozenTitle
        if (prepared.albumArtist) {
          metadata.albumArtist = prepared.albumArtist
          metadata.album_artist = prepared.albumArtist
        }
      }
    } else {
      const mapped = mappedSource(m, info.url)
      let resolved
      try { resolved = await mapped.resolve() } catch (error) {
        const msg = String(error?.message || error)
        const permanent = /404|not found|SPOTIFY_MIX_UNSUPPORTED|required/i.test(msg)
        throw new BridgeError('SOURCE_RESOLVE_FAILED', msg.slice(0, 300), { permanent })
      }
      const items = resolved?.items || []
      if (!items.length) throw new BridgeError('SOURCE_EMPTY', 'The source has no tracks.', { permanent: true })
      const ids = []
      const frozen = []
      await m.mappedCache.mapMappedMusicWithCache({ ...resolved, items }, {
        url: info.url,
        source: mapped.source,
        concurrency: common.spotifyConcurrency,
        replaceManifest: true,
        onUpdate: (idx, item) => {
          if (!item?.id) return
          ids[idx] = item.id
          // Same entry shape as the classic matching flow (keeps the source
          // album and cover so the file gets the right artwork).
          frozen[idx] = { ...item, index: idx + 1, thumbnails: [] }
        }
      })
      const selectedIds = ids.filter(Boolean)
      if (!selectedIds.length) throw new BridgeError('NO_MATCH', 'No playable match was found on YouTube for this item.')
      metadata = {
        source: mapped.source,
        isPlaylist: true,
        isAutomix: false,
        spotifyKind: resolved.kind,
        spotifyTitle: resolved.title,
        selectedIndices: 'all',
        selectedIds,
        frozenEntries: frozen.filter(Boolean),
        frozenTitle: resolved.title || mapped.label
      }
    }

    const job = m.store.createJob({
      status: 'queued',
      progress: 0,
      format,
      bitrate,
      sampleRate: 48000,
      compressionLevel: common.compressionLevel,
      bitDepth: null,
      videoSettings: null,
      metadata: { ...metadata, ...common },
      resultPath: null,
      error: null,
      clientBatch: null
    })
    m.queue.enqueueJob(job.id, () => m.processor.processJob(job.id, null, format, bitrate))
    logger.log?.(`🎧 [player] download queued as job ${job.id} (${info.provider})`)
    return { jobId: job.id, provider: info.provider }
  }

  async function getJob(jobId) {
    const m = await loadCore()
    const job = m.store.getJob(jobId)
    if (!job) return null
    return {
      status: job.status,
      progress: Number(job.progress) || 0,
      phase: job.currentPhase || null,
      error: job.error ? String(job.error?.message || job.error).slice(0, 500) : null,
      outputs: job.status === 'completed' ? collectJobOutputs(job, m.outputPaths.resolveDownloadPathToAbs) : []
    }
  }

  async function cancel(jobId) {
    const m = await loadCore()
    const job = m.store.getJob(jobId)
    if (!job || ['completed', 'error', 'canceled'].includes(job.status)) return
    job.canceled = true
    job.status = 'canceled'
    job.currentPhase = 'canceled'
    job.error = null
    job.canceledBy = 'player'
    try { m.queue.removeFromQueue(jobId) } catch {}
    try { m.store.killJobProcesses(jobId) } catch {}
  }

  // A failed/canceled job may leave its (empty) output folder behind; with
  // retries that would clutter the library. rmdir only removes EMPTY folders.
  async function cleanupJob(jobId) {
    const m = await loadCore()
    const job = m.store.getJob(jobId)
    const rel = String(job?.metadata?.outputSubdir || '').trim()
    if (!rel) return false
    const root = path.resolve(m.outputPaths.OUTPUT_ROOT_DIR)
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(root + path.sep)) return false
    try { await fs.promises.rmdir(abs); return true } catch { return false }
  }

  async function findAlternative({ title, artist, duration, excludeUrl }) {
    if (!title || !artist) return null
    const m = await loadCore()
    const data = await m.yt.runYtJson(['--flat-playlist', `ytsearch10:${artist} ${title}`], 'player-alternative', 30_000)
    const pick = pickAlternativeVideo(data?.entries, { title, artist, duration, excludeId: youTubeVideoId(excludeUrl) })
    if (!pick) return null
    logger.log?.(`🔁 [player] alternative for "${artist} - ${title}": ${pick.title} (${pick.id})`)
    return `https://www.youtube.com/watch?v=${pick.id}`
  }

  return { inspect, createAndEnqueue, getJob, cancel, cleanupJob, findAlternative }
}
