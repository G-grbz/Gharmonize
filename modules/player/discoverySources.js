import {
  deezerGet,
  mapDeezerTrack,
  mapDeezerAlbum,
  mapDeezerArtist,
  mapDeezerPlaylist,
  mapYouTubeItem,
  mapSpotifyAlbum,
  mapSpotifyTrack,
  mapSpotifyPlaylist,
  cleanYouTubeArtist
} from './online.js'
import { normalizeKey } from './scanner.js'

const list = (body, map) => (Array.isArray(body?.data) ? body.data.map(map).filter(Boolean) : [])
const clip = (value, max = 300) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}

// Tracks of a playlist resolved by the core link resolvers (Spotify, Apple
// Music, Deezer…): the same lists the classic interface previews.
export function mapResolvedTrack(item, provider) {
  const title = clip(item?.title || item?.track)
  if (!title) return null
  const url = [item.webpage_url, item.spUrl, item.amUrl, item.deezer_track_url, item.dzUrl, item.url]
    .map((u) => String(u || '').trim()).find((u) => /^https:\/\//i.test(u)) || null
  const ms = Number(item.duration_ms)
  return {
    provider,
    kind: 'track',
    id: url || `${provider}:${normalizeKey(`${item.artist || ''} ${title}`)}`,
    title,
    artist: clip(item.artist),
    album: clip(item.album),
    duration: ms > 0 ? Math.round(ms / 1000) : (Number(item.duration) || null),
    artworkUrl: /^https:\/\//i.test(String(item.coverUrl || '')) ? item.coverUrl : null,
    url,
    isrc: clip(item.isrc, 32)
  }
}

// ---- Deezer -----------------------------------------------------------------

export function createDeezerSource({ fetchImpl } = {}) {
  const get = (p) => deezerGet(p, { fetchImpl })
  return {
    name: 'deezer',
    available: () => true,
    chartTracks: async (limit = 30) => list(await get(`/chart/0/tracks?limit=${limit}`), mapDeezerTrack),
    chartAlbums: async (limit = 20) => list(await get(`/chart/0/albums?limit=${limit}`), mapDeezerAlbum),
    chartArtists: async (limit = 20) => list(await get(`/chart/0/artists?limit=${limit}`), mapDeezerArtist),
    chartPlaylists: async (limit = 20) => list(await get(`/chart/0/playlists?limit=${limit}`), mapDeezerPlaylist),
    genreChartTracks: async (genreId, limit = 30) => list(await get(`/chart/${Number(genreId)}/tracks?limit=${limit}`), mapDeezerTrack),
    genres: async () => (await get('/genre'))?.data?.filter((g) => g.id > 0).map((g) => ({ id: g.id, name: g.name })) || [],
    // Exact (diacritic-insensitive) name match only, to avoid wrong artists.
    // Several artists can share a name (e.g. "Tarkan"); Deezer's ranking is not
    // reliable for that, so the most-followed exact match wins.
    async findArtistId(name) {
      const want = normalizeKey(name)
      if (!want) return null
      const body = await get(`/search/artist?q=${encodeURIComponent(name)}&limit=10`)
      const hits = (body?.data || []).filter((a) => normalizeKey(a.name) === want)
      hits.sort((a, b) => (Number(b.nb_fan) || 0) - (Number(a.nb_fan) || 0))
      return hits.length ? String(hits[0].id) : null
    },
    artist: async (id) => mapDeezerArtist(await get(`/artist/${Number(id)}`)),
    artistTop: async (id, limit = 20) => list(await get(`/artist/${Number(id)}/top?limit=${limit}`), mapDeezerTrack),
    artistRelated: async (id, limit = 20) => list(await get(`/artist/${Number(id)}/related?limit=${limit}`), mapDeezerArtist),
    artistAlbums: async (id, limit = 30) => list(await get(`/artist/${Number(id)}/albums?limit=${limit}`), mapDeezerAlbum),
    searchAlbums: async (q, limit = 10) => list(await get(`/search/album?q=${encodeURIComponent(q)}&limit=${limit}`), mapDeezerAlbum),
    artistRadio: async (id, limit = 30) => list(await get(`/artist/${Number(id)}/radio?limit=${limit}`), mapDeezerTrack),
    async album(id) {
      const body = await get(`/album/${Number(id)}`)
      const album = mapDeezerAlbum(body)
      if (!album) return null
      // The album answer lists at most 25 songs and without ISRC codes; its
      // /tracks list has every song with its ISRC (used to match them).
      let listed = body?.tracks?.data || []
      try {
        const full = await get(`/album/${Number(id)}/tracks?limit=500`)
        if (Array.isArray(full?.data) && full.data.length >= listed.length) listed = full.data
      } catch {}
      const tracks = listed
        .map((t) => mapDeezerTrack({ ...t, album: { id: body.id, title: body.title, cover_xl: body.cover_xl, cover_big: body.cover_big } }))
        .filter(Boolean)
      return { album: { ...album, trackCount: Number(body.nb_tracks) || tracks.length, genre: body.genres?.data?.[0]?.name || null, label: body.label || null }, tracks }
    },
    async playlist(id) {
      const body = await get(`/playlist/${Number(id)}`)
      const playlist = mapDeezerPlaylist(body)
      if (!playlist) return null
      return { playlist, tracks: (body?.tracks?.data || []).map(mapDeezerTrack).filter(Boolean) }
    }
  }
}

// ---- YouTube Music (YTLive's tested functions: cache, 429 guard) ----------
// The Player never uses the YouTube account (home, discovery, artist pages);
// only personal mixes (list=RD…) are read with it, like the downloader does.

export function createYouTubeSource({ yt = null } = {}) {
  const mod = async () => yt || import('../yt.js')
  const anonymous = async (fn) => {
    const m = await mod()
    return typeof m.withoutYouTubeAccount === 'function' ? m.withoutYouTubeAccount(fn) : fn()
  }
  return {
    name: 'youtube',
    available: () => true,
    async home({ lang, shelves = 8, limit = 16 } = {}) {
      const { getYouTubeMusicHomeShelves } = await mod()
      const result = await anonymous(() => getYouTubeMusicHomeShelves({ shelves, limit, lang }))
      return {
        personalized: Boolean(result?.personalized),
        shelves: (result?.shelves || []).map((shelf) => ({
          title: String(shelf.title || '').slice(0, 120),
          items: (shelf.items || []).map((item) => mapYouTubeItem(item)).filter(Boolean)
        })).filter((shelf) => shelf.title && shelf.items.length)
      }
    },
    async discover(preset, { lang, limit = 20 } = {}) {
      const { discoverYouTubeContent } = await mod()
      const result = await anonymous(() => discoverYouTubeContent({ preset, lang, limit }))
      return (result?.items || []).map((item) => mapYouTubeItem(item)).filter(Boolean)
    },
    // Album (browse/MPRE…) or playlist (?list=) track listing. Mixes
    // (list=RD…) are read like the download pipeline reads them.
    async playlist(url, { artist = null, automix = false } = {}) {
      const m = await mod()
      const result = automix ? await m.extractAutomixAllFlat(url) : await anonymous(() => m.extractPlaylistAllFlat(url))
      const tracks = (result?.items || []).map((entry) => {
        const mapped = mapYouTubeItem({ ...entry, type: 'track', uploader: entry.artist || entry.uploader || artist || '' }, 'track')
        if (!mapped) return null
        return { ...mapped, artist: mapped.artist || cleanYouTubeArtist(artist), album: entry.album || null, duration: Number(entry.duration) || null }
      }).filter(Boolean)
      return { title: result?.title || null, count: result?.count || tracks.length, tracks }
    },
    // An artist's "Mix" (artist radio) and the playlist shelves of the
    // artist's YouTube Music page. null = no artist with exactly this name.
    async artistMixes(name, { lang } = {}) {
      const { getYouTubeMusicArtistMixes } = await mod()
      const result = await anonymous(() => getYouTubeMusicArtistMixes(name, { lang, limit: 12 }))
      if (!result) return null
      const artistName = clip(result.artist?.title) || clip(name)
      const mix = result.mix
        ? {
            provider: 'youtube',
            kind: 'playlist',
            id: String(result.mix.playlistId),
            title: `${artistName} Mix`,
            artist: 'YouTube Music',
            // Search rows carry a small picture; ask Google's image server for a bigger one.
            artworkUrl: result.mix.thumbnail ? String(result.mix.thumbnail).replace(/=w\d+-h\d+/, '=w544-h544') : null,
            url: result.mix.url,
            mix: 'youtube',
            seed: artistName
          }
        : null
      const shelves = (result.shelves || []).map((shelf) => ({
        title: clip(shelf.title, 120),
        items: (shelf.items || []).map((item) => mapYouTubeItem(item, 'playlist')).filter(Boolean)
      })).filter((shelf) => shelf.items.length)
      return { artist: artistName, mix, shelves }
    }
  }
}

// ---- Apple Music (public pages; no account or API key) ------------------------

const APPLE_STOREFRONTS = { tr: 'tr', de: 'de', fr: 'fr', es: 'es', en: 'us' }
const APPLE_TIMEOUT_MS = 10_000
const APPLE_HEADERS = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', accept: 'text/html,application/json' }

export function isApplePlaylistUrl(value) {
  try {
    const u = new URL(String(value || ''))
    return u.protocol === 'https:' && u.hostname === 'music.apple.com' && /^\/[a-z]{2}\/playlist\/[^/]+\/pl\.[A-Za-z0-9.-]+$/i.test(u.pathname)
  } catch { return false }
}

function appleArtwork(url) {
  const s = String(url || '')
  if (!/^https:\/\/[a-z0-9.-]+\.mzstatic\.com\//i.test(s)) return null
  return s.replace('{w}', '600').replace('{h}', '600').replace('{c}', 'cc').replace('{f}', 'jpg')
}

// Playlists on an Apple Music artist page ("Artist Playlists": Essentials,
// Inspired by, Influences…), read from the page's embedded data.
export function parseAppleArtistPlaylists(html, artistName = '') {
  const m = /<script[^>]+id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ''))
  if (!m) return []
  let data
  try { data = JSON.parse(m[1]) } catch { return [] }
  const out = new Map()
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 40 || out.size >= 30) return
    const cd = node.contentDescriptor
    if (cd?.kind === 'playlist' && Array.isArray(node.titleLinks) && node.titleLinks[0]?.title) {
      const url = String(cd.url || '')
      const id = String(cd.identifiers?.storeAdamID || '')
      const title = clip(node.titleLinks[0].title)
      if (isApplePlaylistUrl(url) && /^pl\./.test(id) && !out.has(id) && !/\bvideo/i.test(title)) {
        out.set(id, {
          provider: 'apple',
          kind: 'playlist',
          id,
          title,
          artist: clip(node.subtitleLinks?.[0]?.title) || 'Apple Music',
          artworkUrl: appleArtwork(node.artwork?.dictionary?.url),
          url,
          seed: clip(artistName)
        })
      }
      return
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) if (child && typeof child === 'object') walk(child, depth + 1)
  }
  walk(data)
  return [...out.values()]
}

export function createAppleSource({ fetchImpl = fetch, core = null } = {}) {
  const mod = async () => core || import('../apple.js')
  const get = async (url, as) => {
    const res = await fetchImpl(url, { headers: APPLE_HEADERS, signal: AbortSignal.timeout(APPLE_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`Apple Music answered HTTP ${res.status}.`)
    return as === 'json' ? res.json() : res.text()
  }
  return {
    name: 'apple',
    available: () => true,
    // Exact (diacritic-insensitive) artist name only.
    async artistPlaylists(name, { lang = 'en' } = {}) {
      const want = normalizeKey(name)
      if (!want) return null
      const country = APPLE_STOREFRONTS[lang] || 'us'
      const body = await get(`https://itunes.apple.com/search?term=${encodeURIComponent(String(name).slice(0, 200))}&entity=musicArtist&limit=10&country=${country}`, 'json')
      const artist = (body?.results || []).find((a) => normalizeKey(a.artistName) === want && Number(a.artistId) > 0)
      if (!artist) return null
      const html = await get(`https://music.apple.com/${country}/artist/${Number(artist.artistId)}`, 'text')
      return { artist: clip(artist.artistName), items: parseAppleArtistPlaylists(html, artist.artistName) }
    },
    async playlist(url) {
      if (!isApplePlaylistUrl(url)) return null
      const { resolveAppleMusicUrlLite } = await mod()
      const result = await resolveAppleMusicUrlLite(url, {})
      const tracks = (result?.items || []).map((item) => mapResolvedTrack(item, 'apple')).filter(Boolean)
      return { title: clip(result?.title) || 'Apple Music', count: tracks.length, tracks }
    }
  }
}

// ---- Spotify (only with API credentials; endpoints still open to new apps) --

export function createSpotifySource({ makeClient = null, env = process.env } = {}) {
  const client = async () => (makeClient || (await import('../spotify.js')).makeSpotify)()
  const market = () => String(env.SPOTIFY_MARKET || '').trim() || undefined
  return {
    name: 'spotify',
    available: () => Boolean(String(env.SPOTIFY_CLIENT_ID || '').trim() && String(env.SPOTIFY_CLIENT_SECRET || '').trim()),
    async newReleases(limit = 20) {
      const api = await client()
      const res = await api.getNewReleases({ limit, country: market() })
      return (res?.body?.albums?.items || []).map(mapSpotifyAlbum).filter(Boolean)
    },
    // Spotify's own lists for an artist ("This Is …", "… Radio"); needs API
    // credentials for the search.
    async artistPlaylists(name) {
      const want = normalizeKey(name)
      if (!want) return []
      const api = await client()
      const found = await Promise.all([`This Is ${name}`, `${name} Radio`].map(async (q) => {
        try {
          const res = await api.searchPlaylists(q, { limit: 10, market: market() })
          return (res?.body?.playlists?.items || []).filter(Boolean).map(mapSpotifyPlaylist).filter(Boolean)
        } catch { return [] }
      }))
      const seen = new Set()
      return found.flat().filter((p) => {
        if (!p.editorial || seen.has(p.id) || !normalizeKey(p.title).includes(want)) return false
        seen.add(p.id)
        return true
      }).map((p) => ({ ...p, seed: clip(name) })).slice(0, 4)
    },
    // Any playlist link, read with the core resolver (works without API
    // credentials too, through Spotify's public player data).
    async playlist(id) {
      if (!/^[A-Za-z0-9]{10,40}$/.test(String(id || ''))) return null
      const { resolveSpotifyUrlLite } = await import('../spotify.js')
      const result = await resolveSpotifyUrlLite(`https://open.spotify.com/playlist/${id}`, { market: market() })
      const tracks = (result?.items || []).map((item) => mapResolvedTrack(item, 'spotify')).filter(Boolean)
      return { title: clip(result?.title) || 'Spotify', count: tracks.length, tracks }
    },
    async album(id) {
      const api = await client()
      const res = await api.getAlbum(String(id), { market: market() })
      const body = res?.body
      const album = mapSpotifyAlbum(body)
      if (!album) return null
      const tracks = (body?.tracks?.items || [])
        .map((t) => mapSpotifyTrack({ ...t, album: { name: body.name, images: body.images, release_date: body.release_date } }))
        .filter(Boolean)
      return { album, tracks }
    }
  }
}
