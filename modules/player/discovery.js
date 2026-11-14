import { visibleSql } from './access.js'
import { normalizeKey } from './scanner.js'
import { primaryArtistKey } from './matching.js'
import { songKey } from './songKey.js'
import { seededRandom, seededShuffle, localDayKey } from './mixes.js'

export const MOOD_PRESETS = ['energizing', 'workout', 'feel-good', 'relax', 'sad', 'romance', 'commute', 'party', 'focus', 'sleep']

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const TTL = {
  chart: HOUR,
  ytHome: 15 * 60 * 1000,
  ytDiscover: 30 * 60 * 1000,
  artistId: 30 * DAY,
  artistMissing: 3 * DAY,
  artistTop: DAY,
  artistRelated: DAY,
  artistAlbums: 12 * HOUR,
  artistRadio: 2 * HOUR,
  detail: DAY,
  ytPlaylist: 6 * HOUR,
  genres: 30 * DAY,
  spotify: 6 * HOUR
}
const SHELF_TIMEOUT_MS = 10_000
// Deezer's official per-country "Top" charts (Deezer Charts editor).
export const DEEZER_COUNTRY_CHARTS = { tr: { id: '1116189071', country: 'TR' }, de: { id: '1111143121', country: 'DE' }, fr: { id: '1109890291', country: 'FR' }, es: { id: '1116190041', country: 'ES' } }
const NEW_RELEASE_WINDOW_DAYS = 180

export class DiscoveryError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function timeout(promise, ms) {
  let timer
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), ms) })]).finally(() => clearTimeout(timer))
}

function dayIndex(now) {
  return Math.floor(now / DAY)
}

function rotate(list, by) {
  if (!list.length) return list
  const k = ((by % list.length) + list.length) % list.length
  return [...list.slice(k), ...list.slice(0, k)]
}

export function normalizeLang(value, fallback = 'en') {
  const lang = String(value || '').trim().toLowerCase().slice(0, 2)
  return ['tr', 'en', 'de', 'fr', 'es'].includes(lang) ? lang : fallback
}

export function createDiscovery({ db, cache, sources, annotator, getConfig, logger = console, now = () => Date.now(), shelfTimeoutMs = SHELF_TIMEOUT_MS }) {
  const { deezer, youtube, spotify } = sources
  const enabled = (name) => {
    const cfg = getConfig()
    if (!cfg.discoveryEnabled) return false
    if (!cfg.onlineProviders.includes(name)) return false
    const src = sources[name]
    return Boolean(src && src.available())
  }

  // ---- cached source calls ----------------------------------------------------

  const dz = {
    chartTracks: () => cache.wrap('dz:chart:tracks', TTL.chart, () => deezer.chartTracks(40)),
    chartAlbums: () => cache.wrap('dz:chart:albums', TTL.chart, () => deezer.chartAlbums(30)),
    chartArtists: () => cache.wrap('dz:chart:artists', TTL.chart, () => deezer.chartArtists(30)),
    chartPlaylists: () => cache.wrap('dz:chart:playlists', TTL.chart, () => deezer.chartPlaylists(30)),
    genres: () => cache.wrap('dz:genres', TTL.genres, () => deezer.genres()),
    genreChart: (id) => cache.wrap(`dz:genre-chart:${id}`, TTL.chart, () => deezer.genreChartTracks(id, 40)),
    // Unknown artists are re-checked sooner than known ones.
    artistId: (name) => cache.wrap(`dz:artist-id:${normalizeKey(name)}`, TTL.artistId, () => deezer.findArtistId(name), {
      ttlFor: (id) => (id ? TTL.artistId : TTL.artistMissing)
    }),
    artist: (id) => cache.wrap(`dz:artist:${id}`, TTL.detail, () => deezer.artist(id)),
    artistTop: (id) => cache.wrap(`dz:artist-top:${id}`, TTL.artistTop, () => deezer.artistTop(id, 25)),
    artistRelated: (id) => cache.wrap(`dz:artist-related:${id}`, TTL.artistRelated, () => deezer.artistRelated(id, 20)),
    artistAlbums: (id) => cache.wrap(`dz:artist-albums:${id}`, TTL.artistAlbums, () => deezer.artistAlbums(id, 50)),
    artistRadio: (id) => cache.wrap(`dz:artist-radio:${id}`, TTL.artistRadio, () => deezer.artistRadio(id, 30)),
    album: (id) => cache.wrap(`dz:album:${id}`, TTL.detail, () => deezer.album(id)),
    playlist: (id) => cache.wrap(`dz:playlist:${id}`, TTL.detail, () => deezer.playlist(id))
  }
  const yt = {
    home: (lang) => cache.wrap(`yt:home:${lang}`, TTL.ytHome, () => youtube.home({ lang, shelves: 10, limit: 20 })),
    discover: (preset, lang) => cache.wrap(`yt:discover:${preset}:${lang}`, TTL.ytDiscover, () => youtube.discover(preset, { lang, limit: 24 })),
    playlist: (url, artist) => cache.wrap(`yt:playlist:${url}`, TTL.ytPlaylist, () => youtube.playlist(url, { artist }))
  }
  const sp = {
    newReleases: () => cache.wrap('sp:new-releases', TTL.spotify, () => spotify.newReleases(30)),
    album: (id) => cache.wrap(`sp:album:${id}`, TTL.detail, () => spotify.album(id))
  }

  // ---- personal seeds from the user's own (visible) library ----------------

  function seedArtists(userId, limit = 8) {
    const $uid = Number(userId) || 0
    const VIS = visibleSql('t', '$uid')
    const names = []
    const push = (rows) => {
      for (const row of rows) {
        const key = primaryArtistKey(row.name)
        if (key && !names.some((n) => primaryArtistKey(n) === key) && !/^unknown artist$/i.test(row.name)) names.push(row.name)
      }
    }
    push(db.prepare(`SELECT ar.name, COUNT(*) AS n FROM play_history h JOIN tracks t ON t.id = h.track_id JOIN artists ar ON ar.id = t.artist_id
      WHERE h.user_id = $uid AND h.played_at >= $since AND ${VIS} GROUP BY ar.id ORDER BY n DESC LIMIT 20`).all({ $uid, $since: now() - 90 * DAY }))
    push(db.prepare(`SELECT ar.name FROM favorites f JOIN artists ar ON ar.id = f.item_id WHERE f.user_id = $uid AND f.item_type = 'artist'
      ORDER BY f.created_at DESC LIMIT 20`).all({ $uid }))
    push(db.prepare(`SELECT ar.name, COUNT(*) AS n FROM favorites f JOIN tracks t ON t.id = f.item_id JOIN artists ar ON ar.id = t.artist_id
      WHERE f.user_id = $uid AND f.item_type = 'track' AND ${VIS} GROUP BY ar.id ORDER BY n DESC LIMIT 20`).all({ $uid }))
    push(db.prepare(`SELECT ar.name, COUNT(*) AS n FROM tracks t JOIN artists ar ON ar.id = t.artist_id
      WHERE ${VIS} GROUP BY ar.id ORDER BY n DESC LIMIT 40`).all({ $uid }))
    return names.slice(0, limit)
  }

  function topGenre(userId) {
    const row = db.prepare(`SELECT t.genre AS name, COUNT(*) AS n FROM tracks t WHERE t.genre IS NOT NULL AND t.genre != '' AND ${visibleSql('t', '$uid')}
      GROUP BY t.genre COLLATE NOCASE ORDER BY n DESC LIMIT 1`).get({ $uid: Number(userId) || 0 })
    return row?.name || null
  }

  // ---- shelf builders --------------------------------------------------------

  function shelf(id, source, kind, items, { title = null, titleKey = null, titleVars = null, subtitleKey = null, seed = null } = {}) {
    if (!Array.isArray(items) || !items.length) return null
    return { id, source, kind, title, titleKey, titleVars, subtitleKey, seed, items }
  }

  async function globalShelves(lang) {
    const builders = []
    if (enabled('youtube')) {
      builders.push(async () => {
        const home = await yt.home(lang)
        return (home?.shelves || []).map((s, i) => shelf(`yt-home-${i}`, 'youtube', 'mixed', s.items, { title: s.title, subtitleKey: home.personalized ? 'player.discover.ytPersonal' : 'player.discover.ytPublic' }))
      })
      builders.push(async () => shelf('yt-popular', 'youtube', 'tracks', await yt.discover('popular', lang), { titleKey: 'player.discover.ytPopular' }))
      builders.push(async () => shelf('yt-new', 'youtube', 'tracks', await yt.discover('new', lang), { titleKey: 'player.discover.ytNew' }))
      builders.push(async () => shelf('yt-local', 'youtube', 'tracks', await yt.discover('local', lang), { titleKey: 'player.discover.ytLocal' }))
      builders.push(async () => shelf('yt-playlists', 'youtube', 'playlists', await yt.discover('playlist', lang), { titleKey: 'player.discover.ytPlaylists' }))
    }
    if (enabled('deezer')) {
      const countryChart = DEEZER_COUNTRY_CHARTS[lang]
      if (countryChart) {
        builders.push(async () => {
          const data = await dz.playlist(countryChart.id)
          return shelf('dz-country-top', 'deezer', 'tracks', data?.tracks?.slice(0, 50), { titleKey: 'player.discover.dzCountryTop', titleVars: { country: countryChart.country } })
        })
      }
      builders.push(async () => shelf('dz-chart-tracks', 'deezer', 'tracks', await dz.chartTracks(), { titleKey: 'player.discover.dzTopTracks' }))
      builders.push(async () => shelf('dz-chart-albums', 'deezer', 'albums', await dz.chartAlbums(), { titleKey: 'player.discover.dzTopAlbums' }))
      builders.push(async () => shelf('dz-chart-artists', 'deezer', 'artists', await dz.chartArtists(), { titleKey: 'player.discover.dzTopArtists' }))
      builders.push(async () => shelf('dz-chart-playlists', 'deezer', 'playlists', await dz.chartPlaylists(), { titleKey: 'player.discover.dzPlaylists' }))
    }
    if (enabled('spotify')) {
      builders.push(async () => shelf('sp-new-releases', 'spotify', 'albums', await sp.newReleases(), { titleKey: 'player.discover.spNewReleases' }))
    }
    return builders
  }

  function personalBuilders(userId) {
    if (!enabled('deezer')) return []
    const seeds = seedArtists(userId, 8)
    if (!seeds.length) return []
    const today = rotate(seeds, dayIndex(now()))
    const builders = []

    // New releases by artists you already listen to / own.
    builders.push(async () => {
      const cutoff = new Date(now() - NEW_RELEASE_WINDOW_DAYS * DAY).toISOString().slice(0, 10)
      const results = await Promise.all(seeds.slice(0, 8).map(async (name) => {
        const id = await dz.artistId(name)
        if (!id) return []
        return (await dz.artistAlbums(id)).filter((a) => a.releaseDate && a.releaseDate >= cutoff)
      }))
      const albums = results.flat().sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate)))
      const unique = [...new Map(albums.map((a) => [a.url, a])).values()].slice(0, 24)
      return shelf('new-from-your-artists', 'deezer', 'albums', unique, { titleKey: 'player.discover.newFromYourArtists' })
    })

    for (const name of today.slice(0, 3)) {
      const artistKey = primaryArtistKey(name).replace(/\s+/g, '-')
      builders.push(async () => {
        const id = await dz.artistId(name)
        if (!id) return null
        const top = await dz.artistTop(id)
        // Only songs you do not own yet: the "fill your library" shelf.
        const missing = annotator.items(top, userId).filter((t) => !t.library)
        return shelf(`missing-${artistKey}`, 'deezer', 'tracks', missing.slice(0, 20), { titleKey: 'player.discover.missingFromArtist', titleVars: { artist: name }, seed: name })
      })
      builders.push(async () => {
        const id = await dz.artistId(name)
        if (!id) return null
        return shelf(`fans-${artistKey}`, 'deezer', 'artists', await dz.artistRelated(id), { titleKey: 'player.discover.fansOf', titleVars: { artist: name }, seed: name })
      })
    }
    const radioSeed = today[0]
    builders.push(async () => {
      const id = await dz.artistId(radioSeed)
      if (!id) return null
      return shelf(`radio-${primaryArtistKey(radioSeed).replace(/\s+/g, '-')}`, 'deezer', 'tracks', await dz.artistRadio(id), { titleKey: 'player.discover.artistRadio', titleVars: { artist: radioSeed }, seed: radioSeed })
    })
    builders.push(async () => {
      const genre = topGenre(userId)
      if (!genre) return null
      const want = normalizeKey(genre)
      const match = (await dz.genres()).find((g) => {
        const name = normalizeKey(g.name)
        return name === want || name.split(/[\/&,]/).map((p) => p.trim()).includes(want) || want.includes(name)
      })
      if (!match) return null
      return shelf(`genre-${match.id}`, 'deezer', 'tracks', await dz.genreChart(match.id), { titleKey: 'player.discover.genreChart', titleVars: { genre: match.name } })
    })
    return builders
  }

  async function runBuilders(builders) {
    let partial = false
    const results = await Promise.all(builders.map(async (build) => {
      try {
        const value = await timeout(build(), shelfTimeoutMs)
        if (value === undefined) { partial = true; return null }
        return value
      } catch (error) {
        partial = true
        logger.debug?.(`[player] discovery shelf failed: ${error?.message || error}`)
        return null
      }
    }))
    return { shelves: results.flat().filter(Boolean), partial }
  }

  // Personal shelves first (they are what makes it "ours"), then global ones.
  async function discover(user, { lang, scope = 'all' } = {}) {
    if (!getConfig().discoveryEnabled) return { enabled: false, shelves: [], partial: false, generatedAt: now() }
    const safeLang = normalizeLang(lang, normalizeLang(process.env.YT_LANG))
    const builders = [
      ...(scope === 'global' ? [] : personalBuilders(user.id)),
      ...(scope === 'personal' ? [] : await globalShelves(safeLang))
    ]
    const { shelves, partial } = await runBuilders(builders)
    return { enabled: true, shelves: annotator.shelves(shelves, user.id), partial, generatedAt: now(), lang: safeLang }
  }

  async function mood(user, preset, { lang } = {}) {
    if (!MOOD_PRESETS.includes(preset)) throw new DiscoveryError('UNKNOWN_MOOD', 'Unknown mood.', 404)
    if (!enabled('youtube')) return { preset, items: [] }
    const safeLang = normalizeLang(lang, normalizeLang(process.env.YT_LANG))
    return { preset, items: annotator.items(await yt.discover(preset, safeLang), user.id) }
  }

  // ---- online detail pages ----------------------------------------------------

  function requireId(value) {
    const id = String(value || '').trim()
    if (!/^[A-Za-z0-9]{1,40}$/.test(id)) throw new DiscoveryError('INVALID_ID', 'Invalid id.')
    return id
  }

  function requireYouTubeUrl(value) {
    let parsed
    try { parsed = new URL(String(value || '')) } catch { throw new DiscoveryError('INVALID_URL', 'Invalid link.') }
    const host = parsed.hostname.toLowerCase()
    if (parsed.protocol !== 'https:' || !(host === 'youtube.com' || host.endsWith('.youtube.com'))) throw new DiscoveryError('INVALID_URL', 'Only YouTube links are supported here.')
    if (!parsed.searchParams.get('list') && !/^\/browse\/MPRE[A-Za-z0-9_-]+$/i.test(parsed.pathname)) throw new DiscoveryError('INVALID_URL', 'Not a playlist or album link.')
    return parsed.toString()
  }

  // With the full track list at hand, "complete" means every track is owned
  // (a count alone can be equal while the songs differ).
  function withCompleteness(album, tracks) {
    const owned = tracks.filter((t) => t.library).length
    const library = album.library || (owned ? { albumId: null } : null)
    return {
      album: library ? { ...album, library: { ...library, ownedTracks: owned, complete: tracks.length > 0 && owned === tracks.length } } : album,
      tracks,
      ownedTracks: owned
    }
  }

  async function onlineAlbum(user, { provider, id, url, artist } = {}) {
    if (provider === 'deezer') {
      const data = await dz.album(requireId(id))
      if (!data) throw new DiscoveryError('NOT_FOUND', 'Album not found.', 404)
      return withCompleteness(annotator.items([data.album], user.id)[0], annotator.items(data.tracks, user.id))
    }
    if (provider === 'spotify') {
      if (!enabled('spotify')) throw new DiscoveryError('PROVIDER_DISABLED', 'Spotify is not configured.', 409)
      const data = await sp.album(requireId(id))
      if (!data) throw new DiscoveryError('NOT_FOUND', 'Album not found.', 404)
      return withCompleteness(annotator.items([data.album], user.id)[0], annotator.items(data.tracks, user.id))
    }
    if (provider === 'youtube') {
      const link = requireYouTubeUrl(url)
      const data = await yt.playlist(link, artist)
      const album = { provider: 'youtube', kind: 'album', id: link, title: data.title, artist: artist || null, trackCount: data.count, url: link, artworkUrl: data.tracks[0]?.artworkUrl || null }
      return withCompleteness(annotator.items([album], user.id)[0], annotator.items(data.tracks.map((t) => ({ ...t, album: t.album || data.title })), user.id))
    }
    throw new DiscoveryError('UNKNOWN_PROVIDER', 'Unknown provider.')
  }

  async function onlinePlaylist(user, { provider, id, url } = {}) {
    if (provider === 'deezer') {
      const data = await dz.playlist(requireId(id))
      if (!data) throw new DiscoveryError('NOT_FOUND', 'Playlist not found.', 404)
      return { playlist: annotator.items([data.playlist], user.id)[0], tracks: annotator.items(data.tracks, user.id) }
    }
    if (provider === 'youtube') {
      const link = requireYouTubeUrl(url)
      const data = await yt.playlist(link, null)
      const playlist = { provider: 'youtube', kind: 'playlist', id: link, title: data.title, artist: 'YouTube Music', trackCount: data.count, url: link, artworkUrl: data.tracks[0]?.artworkUrl || null }
      return { playlist: annotator.items([playlist], user.id)[0], tracks: annotator.items(data.tracks, user.id) }
    }
    throw new DiscoveryError('UNKNOWN_PROVIDER', 'Unknown provider.')
  }

  // Artist page: by Deezer id, or by name (e.g. from a library artist page).
  // Albums you do not own are what makes "complete the discography" possible.
  async function onlineArtist(user, { id, name } = {}) {
    if (!enabled('deezer')) throw new DiscoveryError('PROVIDER_DISABLED', 'Online artist data needs Deezer to be enabled.', 409)
    const artistId = id ? requireId(id) : await dz.artistId(String(name || '').slice(0, 200))
    if (!artistId) throw new DiscoveryError('NOT_FOUND', 'Artist not found online.', 404)
    const [artist, top, albums, related] = await Promise.all([
      dz.artist(artistId).catch(() => null),
      dz.artistTop(artistId).catch(() => []),
      dz.artistAlbums(artistId).catch(() => []),
      dz.artistRelated(artistId).catch(() => [])
    ])
    if (!artist) throw new DiscoveryError('NOT_FOUND', 'Artist not found online.', 404)
    const sorted = [...albums].sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')))
    const annotatedAlbums = annotator.items(sorted, user.id)
    return {
      artist: annotator.items([artist], user.id)[0],
      topTracks: annotator.items(top, user.id),
      albums: annotatedAlbums.filter((a) => a.recordType !== 'single'),
      singles: annotatedAlbums.filter((a) => a.recordType === 'single'),
      related: annotator.items(related, user.id),
      missingAlbums: annotatedAlbums.filter((a) => a.recordType !== 'single' && !a.library).length
    }
  }

  // Online songs that fit a personal mix: artist radios of the mix's artists
  // (Deezer), only songs the user does not own yet. Same picks all day.
  async function mixSuggestions(user, { mixId, artists = [], limit = 15 } = {}) {
    if (!enabled('deezer')) return { enabled: false, items: [] }
    const names = (artists.length ? artists : seedArtists(user.id, 4)).slice(0, 3)
    const lists = await Promise.all(names.map(async (name) => {
      try {
        const id = await timeout(dz.artistId(name), shelfTimeoutMs)
        if (!id) return []
        return (await timeout(dz.artistRadio(id), shelfTimeoutMs)) || []
      } catch { return [] }
    }))
    const seen = new Set()
    const pool = []
    for (const item of annotator.items(lists.flat(), user.id)) {
      if (item.library) continue
      const key = songKey(item.title, item.artist) || item.url
      if (seen.has(key)) continue
      seen.add(key)
      pool.push(item)
    }
    const rnd = seededRandom(`${user.id}:${mixId}:${localDayKey(now())}:online`)
    return { enabled: true, items: seededShuffle(pool, rnd).slice(0, limit) }
  }

  return { discover, mood, onlineAlbum, onlinePlaylist, onlineArtist, seedArtists, mixSuggestions, moods: () => MOOD_PRESETS }
}
