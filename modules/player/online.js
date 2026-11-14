import { pickTrackArtist, pickTrackTitle } from './ytTitles.js'
import { cleanTitleForMatch, primaryArtistKey, splitArtistFromTitle } from './matching.js'

const DEEZER_API = 'https://api.deezer.com'
const PROVIDER_TIMEOUT_MS = 9000
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 300
// Merged results prefer the source with the richest metadata.
const PROVIDER_PRIORITY = { spotify: 0, deezer: 1, youtube: 2 }

export class OnlineError extends Error {
  constructor(code, message, status = 502) {
    super(message)
    this.code = code
    this.status = status
  }
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new OnlineError('PROVIDER_TIMEOUT', `${label} did not answer in time.`)), ms) })
  ]).finally(() => clearTimeout(timer))
}

function text(value, max = 300) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}

export function cleanYouTubeArtist(uploader) {
  return text(String(uploader || '')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/\s\|\s.*$/, '')
    .replace(/\s[-•·]\s.*$/, '')
    .replace(/\s+-\s*Topic$/i, '')
    .replace(/\s+VEVO$/i, ''))
}

// ---- Deezer (public API, no account needed) ------------------------------

export function mapDeezerTrack(t) {
  if (!t?.id || !t?.title) return null
  return {
    provider: 'deezer',
    kind: 'track',
    id: String(t.id),
    title: text(t.title),
    artist: text(t.artist?.name),
    album: text(t.album?.title),
    duration: Number(t.duration) || null,
    artworkUrl: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || null,
    url: t.link || `https://www.deezer.com/track/${t.id}`,
    isrc: text(t.isrc, 32),
    explicit: Boolean(t.explicit_lyrics),
    // 30 s preview clip, playable before downloading.
    previewUrl: /^https:\/\//.test(String(t.preview || '')) ? t.preview : null,
    providerIds: { deezerArtist: t.artist?.id ? String(t.artist.id) : null, deezerAlbum: t.album?.id ? String(t.album.id) : null }
  }
}

export function mapDeezerPlaylist(p) {
  if (!p?.id || !p?.title) return null
  return {
    provider: 'deezer',
    kind: 'playlist',
    id: String(p.id),
    title: text(p.title),
    artist: text(p.user?.name) || 'Deezer',
    trackCount: Number(p.nb_tracks) || null,
    artworkUrl: p.picture_xl || p.picture_big || p.picture_medium || null,
    url: p.link || `https://www.deezer.com/playlist/${p.id}`
  }
}

export function mapDeezerAlbum(a) {
  if (!a?.id || !a?.title) return null
  return {
    provider: 'deezer',
    kind: 'album',
    id: String(a.id),
    title: text(a.title),
    artist: text(a.artist?.name),
    year: Number(String(a.release_date || '').slice(0, 4)) || null,
    trackCount: Number(a.nb_tracks) || null,
    artworkUrl: a.cover_xl || a.cover_big || a.cover_medium || null,
    url: a.link || `https://www.deezer.com/album/${a.id}`,
    recordType: text(a.record_type, 20),
    releaseDate: text(a.release_date, 10),
    providerIds: { deezerArtist: a.artist?.id ? String(a.artist.id) : null }
  }
}

export function mapDeezerArtist(a) {
  if (!a?.id || !a?.name) return null
  return {
    provider: 'deezer',
    kind: 'artist',
    id: String(a.id),
    title: text(a.name),
    artist: text(a.name),
    fans: Number(a.nb_fan) || null,
    artworkUrl: a.picture_xl || a.picture_big || a.picture_medium || null,
    url: a.link || `https://www.deezer.com/artist/${a.id}`
  }
}

// Deezer allows ~50 requests / 5 s per client. Stay well below it and back
// off for a while when the quota error (code 4) is returned anyway.
const deezerLimiter = { active: 0, queue: [], lastStart: 0, blockedUntil: 0 }
const DEEZER_MAX_ACTIVE = 4
const DEEZER_MIN_SPACING_MS = 120

function deezerSlot() {
  return new Promise((resolve) => {
    deezerLimiter.queue.push(resolve)
    pumpDeezer()
  })
}

function pumpDeezer() {
  if (!deezerLimiter.queue.length || deezerLimiter.active >= DEEZER_MAX_ACTIVE) return
  const wait = Math.max(deezerLimiter.blockedUntil - Date.now(), deezerLimiter.lastStart + DEEZER_MIN_SPACING_MS - Date.now(), 0)
  if (wait > 0) {
    if (!deezerLimiter.timer) {
      deezerLimiter.timer = setTimeout(() => { deezerLimiter.timer = null; pumpDeezer() }, wait)
      deezerLimiter.timer.unref?.()
    }
    return
  }
  deezerLimiter.active += 1
  deezerLimiter.lastStart = Date.now()
  const resolve = deezerLimiter.queue.shift()
  resolve(() => { deezerLimiter.active -= 1; pumpDeezer() })
  pumpDeezer()
}

export async function deezerGet(pathAndQuery, { fetchImpl = fetch, timeoutMs = PROVIDER_TIMEOUT_MS } = {}) {
  const release = await deezerSlot()
  try {
    const res = await fetchImpl(`${DEEZER_API}${pathAndQuery}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) throw new OnlineError('PROVIDER_HTTP', `Deezer answered HTTP ${res.status}.`)
    const body = await res.json()
    if (body?.error) {
      if (Number(body.error.code) === 4) deezerLimiter.blockedUntil = Date.now() + 5000
      throw new OnlineError('PROVIDER_ERROR', `Deezer: ${body.error.message || body.error.type || 'error'}`)
    }
    return body
  } finally {
    release()
  }
}

// Deezer signs preview links for about 15 minutes, and list answers (radios,
// charts) often carry links that already expired. Players therefore ask for a
// fresh link right before playing.
const DEEZER_PREVIEW_RE = /^https:\/\/[a-z0-9.-]+\.dzcdn\.net\//i
const PREVIEW_CACHE_MAX = 500
const previewCache = new Map()

export function previewExpiresAt(url) {
  const m = /[?&~=]exp=(\d{9,12})/.exec(String(url || ''))
  return m ? Number(m[1]) * 1000 : 0
}

export async function freshDeezerPreview(id, { fetchImpl, now = Date.now } = {}) {
  const key = String(id || '')
  if (!/^\d{1,20}$/.test(key)) return null
  const hit = previewCache.get(key)
  if (hit && hit.expiresAt - now() > 60_000) return hit.url
  const body = await deezerGet(`/track/${key}`, { fetchImpl })
  const url = DEEZER_PREVIEW_RE.test(String(body?.preview || '')) ? body.preview : null
  if (!url) return null
  previewCache.delete(key)
  previewCache.set(key, { url, expiresAt: previewExpiresAt(url) || now() + 5 * 60_000 })
  if (previewCache.size > PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value)
  return url
}

function deezerProvider({ fetchImpl } = {}) {
  return {
    name: 'deezer',
    available: () => true,
    async search(q, kind, limit) {
      const path = kind === 'album' ? 'album' : kind === 'artist' ? 'artist' : 'track'
      const body = await deezerGet(`/search/${path}?q=${encodeURIComponent(q)}&limit=${limit}`, { fetchImpl })
      const map = kind === 'album' ? mapDeezerAlbum : kind === 'artist' ? mapDeezerArtist : mapDeezerTrack
      return (body?.data || []).map(map).filter(Boolean)
    }
  }
}

// ---- YouTube Music (existing Gharmonize search) ---------------------------

export function mapYouTubeItem(item, kind = null) {
  if (!item?.id || !item?.title) return null
  kind = kind || ({ album: 'album', playlist: 'playlist', artist: 'artist' }[String(item.type || '').toLowerCase()] || 'track')
  const artist = cleanYouTubeArtist(item.uploader || item.artist)
  if (kind === 'playlist') {
    return {
      provider: 'youtube',
      kind: 'playlist',
      id: String(item.playlistId || item.id),
      title: text(item.title),
      artist: /oynatma listesi|playlist|youtube music/i.test(String(item.uploader || '')) ? 'YouTube Music' : artist,
      artworkUrl: item.thumbnail || null,
      url: item.webpage_url || item.url
    }
  }
  if (kind === 'album') {
    return {
      provider: 'youtube',
      kind: 'album',
      id: String(item.browseId || item.id),
      title: text(item.title),
      artist,
      artworkUrl: item.thumbnail || null,
      url: item.webpage_url || item.url
    }
  }
  if (kind === 'artist') return null
  const split = { title: item.track || pickTrackTitle(item), artist: pickTrackArtist(item) }
  return {
    provider: 'youtube',
    kind: 'track',
    id: String(item.id),
    title: text(split.title),
    artist: text(split.artist) || artist,
    album: null,
    duration: Number(item.duration) || null,
    artworkUrl: item.thumbnail || null,
    url: item.webpage_url || item.url || `https://music.youtube.com/watch?v=${item.id}`
  }
}

function youtubeProvider({ searchImpl } = {}) {
  return {
    name: 'youtube',
    available: () => true,
    async search(q, kind, limit) {
      if (kind === 'artist') return []
      const search = searchImpl || (await import('../yt.js')).searchYouTubeContent
      const result = await search(q, { limit, type: kind === 'album' ? 'album' : 'track' })
      return (result?.items || []).map((item) => mapYouTubeItem(item, kind)).filter(Boolean)
    }
  }
}

// ---- Spotify (only when the user configured API credentials) --------------

export function mapSpotifyTrack(t) {
  if (!t?.id || !t?.name) return null
  return {
    provider: 'spotify',
    kind: 'track',
    id: t.id,
    title: text(t.name),
    artist: text((t.artists || []).map((a) => a.name).join(', ')),
    album: text(t.album?.name),
    year: Number(String(t.album?.release_date || '').slice(0, 4)) || null,
    duration: t.duration_ms ? t.duration_ms / 1000 : null,
    artworkUrl: t.album?.images?.[0]?.url || null,
    url: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
    isrc: text(t.external_ids?.isrc, 32),
    explicit: Boolean(t.explicit)
  }
}

export function mapSpotifyAlbum(a) {
  if (!a?.id || !a?.name) return null
  return {
    provider: 'spotify',
    kind: 'album',
    id: a.id,
    title: text(a.name),
    artist: text((a.artists || []).map((x) => x.name).join(', ')),
    year: Number(String(a.release_date || '').slice(0, 4)) || null,
    trackCount: Number(a.total_tracks) || null,
    artworkUrl: a.images?.[0]?.url || null,
    url: a.external_urls?.spotify || `https://open.spotify.com/album/${a.id}`
  }
}

export function mapSpotifyArtist(a) {
  if (!a?.id || !a?.name) return null
  return {
    provider: 'spotify',
    kind: 'artist',
    id: a.id,
    title: text(a.name),
    artist: text(a.name),
    artworkUrl: a.images?.[0]?.url || null,
    url: a.external_urls?.spotify || `https://open.spotify.com/artist/${a.id}`
  }
}

function spotifyProvider({ makeClient, env = process.env } = {}) {
  return {
    name: 'spotify',
    available: () => Boolean(String(env.SPOTIFY_CLIENT_ID || '').trim() && String(env.SPOTIFY_CLIENT_SECRET || '').trim()),
    async search(q, kind, limit) {
      const make = makeClient || (await import('../spotify.js')).makeSpotify
      const api = await make()
      const market = String(env.SPOTIFY_MARKET || '').trim() || undefined
      if (kind === 'album') {
        const res = await api.searchAlbums(q, { limit, market })
        return (res?.body?.albums?.items || []).map(mapSpotifyAlbum).filter(Boolean)
      }
      if (kind === 'artist') {
        const res = await api.searchArtists(q, { limit, market })
        return (res?.body?.artists?.items || []).map(mapSpotifyArtist).filter(Boolean)
      }
      const res = await api.searchTracks(q, { limit, market })
      return (res?.body?.tracks?.items || []).map(mapSpotifyTrack).filter(Boolean)
    }
  }
}

// ---- orchestration --------------------------------------------------------

export function onlineItemKey(item) {
  if (item.kind === 'artist') return `artist|${primaryArtistKey(item.artist || item.title)}`
  const titleKey = item.kind === 'track' ? cleanTitleForMatch(item.title) : cleanTitleForMatch(item.title)
  return `${item.kind}|${primaryArtistKey(item.artist)}|${titleKey}`
}

// Merges results from several providers. The richest source wins; the other
// sources are kept as alternatives so a failed download can fall back.
export function mergeOnlineItems(lists) {
  const merged = new Map()
  const order = []
  const rounds = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < rounds; i += 1) {
    for (const list of lists) {
      const item = list[i]
      if (!item) continue
      const key = onlineItemKey(item)
      const existing = merged.get(key)
      if (!existing) {
        merged.set(key, { ...item, alternatives: [] })
        order.push(key)
        continue
      }
      const better = PROVIDER_PRIORITY[item.provider] < PROVIDER_PRIORITY[existing.provider]
      const primary = better ? { ...item, alternatives: [] } : existing
      const other = better ? existing : item
      primary.alternatives = [...(better ? existing.alternatives : primary.alternatives), { provider: other.provider, url: other.url }]
      if (!primary.isrc && other.isrc) primary.isrc = other.isrc
      if (!primary.duration && other.duration) primary.duration = other.duration
      if (!primary.album && other.album) primary.album = other.album
      if (!primary.artworkUrl && other.artworkUrl) primary.artworkUrl = other.artworkUrl
      merged.set(key, primary)
    }
  }
  return order.map((key) => merged.get(key))
}

export function createOnlineSearch({ providers = null, getEnabledProviders = () => ['deezer', 'youtube', 'spotify'], logger = console, now = () => Date.now(), fetchImpl, searchImpl, makeClient } = {}) {
  const all = providers || [
    spotifyProvider({ makeClient }),
    deezerProvider({ fetchImpl }),
    youtubeProvider({ searchImpl })
  ]
  const cache = new Map()

  function activeProviders() {
    const enabled = new Set(getEnabledProviders())
    return all.filter((p) => enabled.has(p.name) && p.available())
  }

  function status() {
    const enabled = new Set(getEnabledProviders())
    return all.map((p) => ({ name: p.name, enabled: enabled.has(p.name), available: p.available() }))
  }

  async function runProvider(provider, q, kind, limit) {
    const key = `${provider.name}|${kind}|${limit}|${q.toLowerCase()}`
    const hit = cache.get(key)
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.items
    const items = await withTimeout(provider.search(q, kind, limit), PROVIDER_TIMEOUT_MS, provider.name)
    cache.set(key, { at: now(), items })
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
    return items
  }

  async function search(query, { kinds = ['track', 'album', 'artist'], limit = 12, only = null } = {}) {
    const q = String(query || '').trim().slice(0, 200)
    const out = { query: q, providers: {}, tracks: [], albums: [], artists: [] }
    if (!q) return out
    const list = activeProviders().filter((p) => !only || only.includes(p.name))
    const max = Math.min(Math.max(Number(limit) || 12, 1), 30)
    const perKind = await Promise.all(kinds.map((kind) => Promise.allSettled(list.map((p) => runProvider(p, q, kind, max)))))
    for (const [kindIndex, kind] of kinds.entries()) {
      const settled = perKind[kindIndex]
      const lists = []
      settled.forEach((r, i) => {
        const name = list[i].name
        const entry = out.providers[name] || (out.providers[name] = { ok: true, errors: {} })
        if (r.status === 'fulfilled') lists.push(r.value)
        else {
          entry.ok = false
          entry.errors[kind] = r.reason?.code || 'PROVIDER_FAILED'
          logger.debug?.(`[player] ${name} ${kind} search failed: ${r.reason?.message || r.reason}`)
        }
      })
      const merged = mergeOnlineItems(lists).slice(0, max * 2)
      if (kind === 'track') out.tracks = merged
      else if (kind === 'album') out.albums = merged
      else out.artists = merged
    }
    return out
  }

  return { search, status, activeProviders }
}
