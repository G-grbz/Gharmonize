import {
  deezerGet,
  mapDeezerTrack,
  mapDeezerAlbum,
  mapDeezerArtist,
  mapDeezerPlaylist,
  mapYouTubeItem,
  mapSpotifyAlbum,
  mapSpotifyTrack,
  cleanYouTubeArtist
} from './online.js'
import { normalizeKey } from './scanner.js'

const list = (body, map) => (Array.isArray(body?.data) ? body.data.map(map).filter(Boolean) : [])

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
    artistRadio: async (id, limit = 30) => list(await get(`/artist/${Number(id)}/radio?limit=${limit}`), mapDeezerTrack),
    async album(id) {
      const body = await get(`/album/${Number(id)}`)
      const album = mapDeezerAlbum(body)
      if (!album) return null
      const tracks = (body?.tracks?.data || [])
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

// ---- YouTube Music (YTLive's tested functions: cookies, cache, 429 guard) ---

export function createYouTubeSource({ yt = null } = {}) {
  const mod = async () => yt || import('../yt.js')
  return {
    name: 'youtube',
    available: () => true,
    async home({ lang, shelves = 8, limit = 16 } = {}) {
      const { getYouTubeMusicHomeShelves } = await mod()
      const result = await getYouTubeMusicHomeShelves({ shelves, limit, lang })
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
      const result = await discoverYouTubeContent({ preset, lang, limit })
      return (result?.items || []).map((item) => mapYouTubeItem(item)).filter(Boolean)
    },
    // Album (browse/MPRE…) or playlist (?list=) track listing.
    async playlist(url, { artist = null } = {}) {
      const { extractPlaylistAllFlat } = await mod()
      const result = await extractPlaylistAllFlat(url)
      const tracks = (result?.items || []).map((entry) => {
        const mapped = mapYouTubeItem({ ...entry, type: 'track', uploader: entry.artist || entry.uploader || artist || '' }, 'track')
        if (!mapped) return null
        return { ...mapped, artist: mapped.artist || cleanYouTubeArtist(artist), album: entry.album || null, duration: Number(entry.duration) || null }
      }).filter(Boolean)
      return { title: result?.title || null, count: result?.count || tracks.length, tracks }
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
