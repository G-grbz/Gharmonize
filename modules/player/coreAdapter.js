// Adapter between Gharmonize Player and the existing Gharmonize download
// pipeline. It only *uses* exported core functions (createJob, enqueueJob,
// processJob, URL resolvers, Spotify→YouTube mapping); nothing in the core is
// changed. Core modules are imported lazily, the first time a download runs.

import fs from 'node:fs'
import path from 'node:path'
import { AUDIO_EXTENSIONS, normalizeKey } from './scanner.js'
import { toFrozenEntries } from './ytTitles.js'
import { artistCreditKeys, cleanTitleForMatch, primaryArtistKey, songKey } from './songKey.js'

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

// Positions (0-based) of the source entries that are one of the `wanted`
// songs ({ title, artist, isrc }): same ISRC, or same title and an artist in
// common. Compilations credit every song with all the album's artists
// ("Sagopa Kajmer, Fuat, Kolera …") while the store names one ("Fuat").
export function pickWantedEntries(entries, wanted) {
  const isrcs = new Set(wanted.map((song) => String(song.isrc || '').toUpperCase()).filter(Boolean))
  const credits = (artist) => new Set([fold(primaryArtistKey(artist)), ...artistCreditKeys(artist).map(fold)].filter(Boolean))
  const keys = wanted.map((song) => ({ title: fold(cleanTitleForMatch(song.title) || song.title), artist: fold(primaryArtistKey(song.artist)), credits: credits(song.artist) }))
  const exact = new Set(wanted.map((song) => songKey(song.title, song.artist)).filter(Boolean))
  const picked = []
  ;(Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    if (!entry) return
    const artist = entry.artist || entry.uploader || entry.channel || ''
    const isrc = String(entry.isrc || '').toUpperCase()
    const title = fold(cleanTitleForMatch(entry.title || entry.track) || entry.title || '')
    const artistKey = fold(primaryArtistKey(artist))
    const entryCredits = credits(artist)
    const shared = (key) => [...key.credits].some((name) => entryCredits.has(name))
    if ((isrc && isrcs.has(isrc)) || exact.has(songKey(entry.title || entry.track, artist)) ||
      keys.some((key) => key.title && key.title === title && (!key.artist || !artistKey || key.artist === artistKey || shared(key)))) picked.push(index)
  })
  return picked
}

// Collects absolute output files from a finished core job.
// { total, downloaded, converted } of a job with several songs, else null.
export function jobSteps(job) {
  const c = job?.counters || {}
  const total = Math.max(Number(c.dlTotal) || 0, Number(c.cvTotal) || 0, Number(job?.playlist?.total) || 0)
  if (total < 2) return null
  const clamp = (n) => Math.max(0, Math.min(total, Math.floor(Number(n) || 0)))
  return { total, downloaded: clamp(c.dlDone), converted: clamp(c.cvDone) }
}

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

const nothingNew = () => new BridgeError('NOTHING_NEW', 'Every song of this download is in the library or on its way in another download.')

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

  // `only`: download just these songs of an album or playlist (the ones the
  // library lacks), the way the classic UI downloads selected tracks.
  // `skipVideos(ids)`: the YouTube videos (of those this link maps to) to
  // leave out because the library has them or another download fetches
  // them; nothing left → NOTHING_NEW.
  async function createAndEnqueue({ url, preset, tag, isCanceled, only = null, skipVideos = null }) {
    const m = await loadCore()
    const info = await inspect(url)
    const checkCanceled = () => {
      if (isCanceled?.()) throw new BridgeError('DOWNLOAD_CANCELED', 'The download was canceled.')
    }
    checkCanceled()
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
      if (!info.isPlaylist && skipVideos) {
        const id = youTubeVideoId(info.url)
        if (id && skipVideos([id]).has(id)) throw nothingNew()
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
        if (only?.length) {
          const picked = pickWantedEntries(prepared.frozenEntries, only)
          if (!picked.length) throw new BridgeError('NOTHING_TO_DOWNLOAD', 'None of the missing songs were found in this source.', { permanent: true })
          metadata.frozenEntries = picked.map((i) => prepared.frozenEntries[i])
          metadata.selectedIndices = picked.map((i) => i + 1)
          if (prepared.selectedIds) metadata.selectedIds = picked.map((i) => prepared.selectedIds[i])
        }
        if (skipVideos) {
          const entries = metadata.frozenEntries
          const skip = skipVideos(entries.map((entry) => entry?.id).filter(Boolean))
          if (skip.size) {
            const keep = entries.map((entry, i) => i).filter((i) => !skip.has(entries[i]?.id))
            if (!keep.length) throw nothingNew()
            const positions = Array.isArray(metadata.selectedIndices) ? metadata.selectedIndices : entries.map((entry, i) => i + 1)
            metadata.frozenEntries = keep.map((i) => entries[i])
            metadata.selectedIndices = keep.map((i) => positions[i])
            if (metadata.selectedIds) metadata.selectedIds = keep.map((i) => metadata.selectedIds[i])
          }
        }
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
        // The store did not answer (outage, timeout): try again later.
        const permanent = !error?.transient && /404|not found|SPOTIFY_MIX_UNSUPPORTED|required/i.test(msg)
        throw new BridgeError('SOURCE_RESOLVE_FAILED', msg.slice(0, 300), { permanent })
      }
      checkCanceled()
      const all = resolved?.items || []
      if (!all.length) throw new BridgeError('SOURCE_EMPTY', 'The source has no tracks.', { permanent: true })
      // Positions in the source (1-based), kept as track numbers when only
      // some songs are downloaded, like the classic track selection.
      const positions = only?.length ? pickWantedEntries(all, only).map((i) => i + 1) : null
      if (positions && !positions.length) throw new BridgeError('NOTHING_TO_DOWNLOAD', 'None of the missing songs were found in this source.', { permanent: true })
      const items = positions ? positions.map((n) => all[n - 1]) : all
      const ids = []
      const frozen = []
      await m.mappedCache.mapMappedMusicWithCache({ ...resolved, items }, {
        url: info.url,
        source: mapped.source,
        format,
        concurrency: common.spotifyConcurrency,
        replaceManifest: !positions,
        onUpdate: (idx, item) => {
          if (!item?.id) return
          ids[idx] = item.id
          // Same entry shape as the classic matching flow (keeps the source
          // album and cover so the file gets the right artwork).
          frozen[idx] = { ...item, index: positions ? positions[idx] : idx + 1, thumbnails: [] }
        }
      })
      if (!ids.some(Boolean)) throw new BridgeError('NO_MATCH', 'No playable match was found on YouTube for this item.')
      // Songs listed on several releases (re-released singles ...) map to
      // the same video: one copy is enough.
      const skip = skipVideos ? skipVideos(ids.filter(Boolean)) : new Set()
      const matched = items.map((item, i) => i).filter((i) => ids[i] && frozen[i])
      const keep = matched.filter((i) => !skip.has(ids[i]))
      if (!keep.length) throw nothingNew()
      const partial = Boolean(positions) || keep.length < matched.length
      metadata = {
        source: mapped.source,
        isPlaylist: true,
        isAutomix: false,
        spotifyKind: resolved.kind,
        spotifyTitle: resolved.title,
        selectedIndices: partial ? keep.map((i) => (positions ? positions[i] : i + 1)) : 'all',
        selectedIds: keep.map((i) => ids[i]),
        frozenEntries: keep.map((i) => frozen[i]),
        frozenTitle: resolved.title || mapped.label
      }
    }

    checkCanceled()
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

  // Which YouTube video the core matched each song of an album or playlist
  // link to (its mapping cache): [{ sourceItemId, sourceItemUrl, sourceTitle,
  // sourceArtist, youtubeId }]. Empty for links that were never mapped.
  async function mappedLinks(url) {
    if (!url) return []
    const cache = await import('../mappedMusicCache.js')
    const manifest = cache.readMappedMusicManifest(cache.getMappedMusicSourceKey(url))
    return (manifest?.tracks || []).filter((entry) => entry.youtubeId)
  }

  async function getJob(jobId) {
    const m = await loadCore()
    const job = m.store.getJob(jobId)
    if (!job) return null
    return {
      status: job.status,
      progress: Number(job.progress) || 0,
      phase: job.currentPhase || null,
      // Album / playlist jobs: how many of their songs are downloaded and converted.
      steps: jobSteps(job),
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

  return { inspect, createAndEnqueue, getJob, cancel, cleanupJob, findAlternative, mappedLinks }
}
