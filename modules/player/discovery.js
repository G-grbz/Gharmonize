import { visibleSql } from './access.js'
import { normalizeKey } from './scanner.js'
import { primaryArtistKey, albumBaseKey, artistsMatch, cleanTitleForMatch, sameRecordingLength } from './matching.js'
import { songKey, artistCredits, artistCreditNames, artistCreditKeys } from './songKey.js'
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
  spotify: 6 * HOUR,
  artistMixes: DAY,
  artistMixesMissing: 3 * DAY,
  applePlaylists: 3 * DAY
}
const SHELF_TIMEOUT_MS = 10_000
const WARM_RETRY_MS = 30 * 60 * 1000
// Artists the personal shelves are built from: a wide pool, a different
// handful every day (and on every manual refresh).
const SEED_POOL = 24
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

export function normalizeLang(value, fallback = 'en') {
  const lang = String(value || '').trim().toLowerCase().slice(0, 2)
  return ['tr', 'en', 'de', 'fr', 'es'].includes(lang) ? lang : fallback
}

export function createDiscovery({ db, cache, sources, annotator, getConfig, logger = console, now = () => Date.now(), shelfTimeoutMs = SHELF_TIMEOUT_MS, artistPhotos = null }) {
  const { deezer, youtube, spotify, apple } = sources
  const enabled = (name) => {
    const cfg = getConfig()
    if (!cfg.discoveryEnabled) return false
    if (!cfg.onlineProviders.includes(name)) return false
    const src = sources[name]
    return Boolean(src && src.available())
  }

  // ---- cached source calls ----------------------------------------------------

  // Cache key, lifetime and loader of the per-artist mix lookups. Unknown
  // artists (null) are re-checked sooner than known ones.
  const missingSooner = (ttl) => ({ ttlFor: (value) => (value ? ttl : TTL.artistMixesMissing) })
  const mixSpec = {
    yt: (name, lang) => [`yt:artist-mixes:${lang}:${normalizeKey(name)}`, TTL.artistMixes, () => youtube.artistMixes(name, { lang }), missingSooner(TTL.artistMixes)],
    dz: (name) => [`dz:artist-mix:${normalizeKey(name)}`, TTL.artistMixes, () => deezerMix(name), missingSooner(TTL.artistMixes)],
    ap: (name, lang) => [`ap:artist-playlists:${lang}:${normalizeKey(name)}`, TTL.applePlaylists, () => apple.artistPlaylists(name, { lang }), missingSooner(TTL.applePlaylists)],
    sp: (name) => [`sp:artist-playlists:${normalizeKey(name)}`, TTL.artistMixes, () => spotify.artistPlaylists(name), {}]
  }

  // Home mix shelves never make the page wait: they show what is cached and
  // fetch the rest in the background, one lookup at a time, so the shared
  // YouTube Music request queue is not filled up ahead of searches.
  const warming = new Set()
  const warmFailedAt = new Map()
  let warmChain = Promise.resolve()
  function cachedOrWarm([key, ttl, loader, opts]) {
    const entry = cache.entry(key)
    const fresh = entry && entry.expiresAt > now()
    if (!fresh && !warming.has(key) && now() - (warmFailedAt.get(key) || 0) > WARM_RETRY_MS) {
      warming.add(key)
      warmChain = warmChain
        .then(() => cache.refresh(key, ttl, loader, opts))
        .then(() => warmFailedAt.delete(key), () => warmFailedAt.set(key, now()))
        .finally(() => warming.delete(key))
    }
    return entry ? entry.value : null
  }

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
    // Deezer lists an artist's albums without their artist: it is filled in
    // here (also for lists cached before), or no album could be matched with
    // the library and every owned album looked missing.
    artistAlbums: async (id) => {
      const albums = await cache.wrap(`dz:artist-albums:${id}`, TTL.artistAlbums, () => deezer.artistAlbums(id, 50))
      if (!Array.isArray(albums) || !albums.some((a) => !a.artist)) return albums
      const artist = await dz.artist(id).catch(() => null)
      if (!artist?.title) return albums
      return albums.map((a) => (a.artist ? a : { ...a, artist: artist.title, providerIds: { ...a.providerIds, deezerArtist: a.providerIds?.deezerArtist || String(id) } }))
    },
    artistRadio: (id) => cache.wrap(`dz:artist-radio:${id}`, TTL.artistRadio, () => deezer.artistRadio(id, 30)),
    // v2: every song with its ISRC (the first answers had at most 25, no ISRC).
    album: (id) => cache.wrap(`dz:album2:${id}`, TTL.detail, () => deezer.album(id)),
    searchAlbums: (q) => cache.wrap(`dz:search-albums:${normalizeKey(q)}`, TTL.detail, () => deezer.searchAlbums(q, 10)),
    playlist: (id) => cache.wrap(`dz:playlist:${id}`, TTL.detail, () => deezer.playlist(id))
  }
  const yt = {
    home: (lang) => cache.wrap(`yt:home:${lang}`, TTL.ytHome, () => youtube.home({ lang, shelves: 10, limit: 20 })),
    discover: (preset, lang) => cache.wrap(`yt:discover:${preset}:${lang}`, TTL.ytDiscover, () => youtube.discover(preset, { lang, limit: 24 })),
    playlist: (url, artist, automix = false) => cache.wrap(`yt:playlist:${url}`, TTL.ytPlaylist, () => youtube.playlist(url, { artist, automix })),
    artistMixes: (name, lang) => cache.wrap(...mixSpec.yt(name, lang))
  }
  const sp = {
    newReleases: () => cache.wrap('sp:new-releases', TTL.spotify, () => spotify.newReleases(30)),
    album: (id) => cache.wrap(`sp:album:${id}`, TTL.detail, () => spotify.album(id)),
    artistPlaylists: (name) => cache.wrap(...mixSpec.sp(name)),
    playlist: (id) => cache.wrap(`sp:playlist:${id}`, TTL.ytPlaylist, () => spotify.playlist(id))
  }
  const ap = {
    artistPlaylists: (name, lang) => cache.wrap(...mixSpec.ap(name, lang)),
    playlist: (url) => cache.wrap(`ap:playlist:${url}`, TTL.ytPlaylist, () => apple.playlist(url))
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

  // A daily pick from the seed pool. Artists you listen to most come up more
  // often, the others take turns (weighted sampling: key = r^(1/w)). `round`
  // is bumped by the refresh button for another pick on the same day.
  function pickSeeds(userId, count, round = 0) {
    const pool = seedArtists(userId, SEED_POOL)
    const rnd = seededRandom(`${userId}:${localDayKey(now())}:seeds:${round}`)
    if (pool.length <= count) return seededShuffle(pool, rnd)
    return pool
      .map((name, i) => ({ name, key: Math.pow(rnd(), 1 + i / 4) }))
      .sort((a, b) => b.key - a.key)
      .slice(0, count)
      .map((x) => x.name)
  }

  // Same items, a different order every day / refresh.
  function dailyOrder(items, userId, salt, round = 0) {
    return seededShuffle(items, seededRandom(`${userId}:${localDayKey(now())}:${salt}:${round}`))
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

  // ---- mixes ---------------------------------------------------------------

  // Deezer's artist mix (artist radio). It has no link the download pipeline
  // can read, so its songs are downloaded one by one.
  async function deezerMix(name) {
    const id = await dz.artistId(name)
    if (!id) return null
    const artist = await dz.artist(id).catch(() => null)
    const title = artist?.title || name
    return {
      provider: 'deezer',
      kind: 'playlist',
      id: `artist-mix-${id}`,
      title: `${title} Mix`,
      artist: 'Deezer',
      artworkUrl: artist?.artworkUrl || null,
      url: null,
      sourceUrl: `https://www.deezer.com/artist/${id}`,
      mix: 'deezer',
      mixId: String(id),
      downloadable: false,
      seed: title
    }
  }

  const settle = (promise) => timeout(Promise.resolve(promise).catch(() => null), shelfTimeoutMs).then((v) => v ?? null)
  const MIX_TITLE = /\b(radio|mix)\b/i

  // Mixes and playlists made around one artist, from every enabled source.
  async function artistMixes(user, { name, lang } = {}) {
    const artist = String(name || '').trim().slice(0, 200)
    if (!artist || !getConfig().discoveryEnabled) return { enabled: false, artist, mixes: [], playlists: [] }
    const safeLang = normalizeLang(lang, normalizeLang(process.env.YT_LANG))
    const [ytRes, dzMix, apRes, spRes] = await Promise.all([
      enabled('youtube') ? settle(yt.artistMixes(artist, safeLang)) : null,
      enabled('deezer') ? settle(cache.wrap(...mixSpec.dz(artist))) : null,
      enabled('apple') ? settle(ap.artistPlaylists(artist, safeLang)) : null,
      enabled('spotify') ? settle(sp.artistPlaylists(artist)) : null
    ])
    const spotifyLists = spRes || []
    const mixes = [ytRes?.mix, dzMix, ...spotifyLists.filter((p) => MIX_TITLE.test(p.title))].filter(Boolean)
    const seen = new Set(mixes.map((m) => m.url || m.id))
    // Sources take turns so one of them does not fill the whole row.
    const lanes = [spotifyLists.filter((p) => !MIX_TITLE.test(p.title)), apRes?.items || [], ...(ytRes?.shelves || []).map((s) => s.items)]
    const rounds = Math.max(0, ...lanes.map((l) => l.length))
    const mixed = []
    for (let i = 0; i < rounds; i++) for (const lane of lanes) if (lane[i]) mixed.push(lane[i])
    const playlists = mixed
      .filter((p) => {
        const key = p.url || p.id
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, 30)
    return { enabled: true, artist, mixes: annotator.items(mixes, user.id), playlists: annotator.items(playlists, user.id) }
  }

  // Home "mix" shelves: one per source, built from the artists you listen to.
  // Only cached lookups are used (see cachedOrWarm); the rest follow on a
  // later load.
  function mixBuilders(userId, lang, round = 0) {
    const today = pickSeeds(userId, 8, round)
    if (!today.length) return []
    const builders = []
    const cached = (names, spec) => names.map((name) => cachedOrWarm(spec(name))).filter(Boolean)
    if (enabled('youtube')) {
      builders.push(async () => {
        const found = cached(today.slice(0, 6), (name) => mixSpec.yt(name, lang))
        const mixes = shelf('mixes-youtube', 'youtube', 'playlists', found.map((r) => r.mix).filter(Boolean), { titleKey: 'player.discover.ytMixes' })
        // "Featured on" lists of each artist, taking turns between artists.
        const lists = found.map((r) => r.shelves?.[0]?.items || [])
        const items = []
        const seen = new Set()
        for (let i = 0; i < 6; i++) {
          for (const l of lists) {
            const item = l[i]
            if (item && !seen.has(item.url)) { seen.add(item.url); items.push(item) }
          }
        }
        return [mixes, shelf('mixes-yt-featured', 'youtube', 'playlists', dailyOrder(items.slice(0, 24), userId, 'yt-featured', round), { titleKey: 'player.discover.ytFeatured' })]
      })
    }
    if (enabled('deezer')) {
      builders.push(async () => shelf('mixes-deezer', 'deezer', 'playlists', cached(today.slice(0, 8), (name) => mixSpec.dz(name)), { titleKey: 'player.discover.dzMixes' }))
    }
    if (enabled('apple')) {
      builders.push(async () => {
        // A few lists per artist, a different few every day.
        const items = cached(today.slice(0, 4), (name) => mixSpec.ap(name, lang)).flatMap((r) => dailyOrder(r.items || [], userId, `apple:${r.artist}`, round).slice(0, 3))
        return shelf('mixes-apple', 'apple', 'playlists', items, { titleKey: 'player.discover.appleLists' })
      })
    }
    if (enabled('spotify')) {
      builders.push(async () => shelf('mixes-spotify', 'spotify', 'playlists', cached(today.slice(0, 6), (name) => mixSpec.sp(name)).flat(), { titleKey: 'player.discover.spLists' }))
    }
    return builders
  }

  function personalBuilders(userId, round = 0) {
    if (!enabled('deezer')) return []
    // New releases: from your main artists. The other shelves: today's pick.
    const seeds = seedArtists(userId, 8)
    if (!seeds.length) return []
    const today = pickSeeds(userId, 4, round)
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
        return shelf(`missing-${artistKey}`, 'deezer', 'tracks', dailyOrder(missing, userId, `missing:${artistKey}`, round).slice(0, 20), { titleKey: 'player.discover.missingFromArtist', titleVars: { artist: name }, seed: name })
      })
      builders.push(async () => {
        const id = await dz.artistId(name)
        if (!id) return null
        return shelf(`fans-${artistKey}`, 'deezer', 'artists', dailyOrder(await dz.artistRelated(id), userId, `fans:${artistKey}`, round), { titleKey: 'player.discover.fansOf', titleVars: { artist: name }, seed: name })
      })
    }
    // The radio comes from a fourth artist when there is one.
    const radioSeed = today[3] || today[0]
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
  async function discover(user, { lang, scope = 'all', round = 0 } = {}) {
    if (!getConfig().discoveryEnabled) return { enabled: false, shelves: [], partial: false, generatedAt: now() }
    const safeLang = normalizeLang(lang, normalizeLang(process.env.YT_LANG))
    const builders = [
      ...(scope === 'global' ? [] : mixBuilders(user.id, safeLang, round)),
      ...(scope === 'global' ? [] : personalBuilders(user.id, round)),
      ...(scope === 'personal' ? [] : await globalShelves(safeLang))
    ]
    const { shelves, partial } = await runBuilders(builders)
    // Mix lookups still loading in the background: the client asks again soon.
    return { enabled: true, shelves: annotator.shelves(shelves, user.id), partial: partial || warming.size > 0, generatedAt: now(), lang: safeLang }
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
      const links = await annotator.links(data.album.url)
      return withCompleteness(annotator.items([data.album], user.id)[0], annotator.items(data.tracks, user.id, { links }))
    }
    if (provider === 'spotify') {
      if (!enabled('spotify')) throw new DiscoveryError('PROVIDER_DISABLED', 'Spotify is not configured.', 409)
      const data = await sp.album(requireId(id))
      if (!data) throw new DiscoveryError('NOT_FOUND', 'Album not found.', 404)
      const links = await annotator.links(data.album.url)
      return withCompleteness(annotator.items([data.album], user.id)[0], annotator.items(data.tracks, user.id, { links }))
    }
    if (provider === 'youtube') {
      const link = requireYouTubeUrl(url)
      const data = await yt.playlist(link, artist)
      const album = { provider: 'youtube', kind: 'album', id: link, title: data.title, artist: artist || null, trackCount: data.count, url: link, artworkUrl: data.tracks[0]?.artworkUrl || null }
      return withCompleteness(annotator.items([album], user.id)[0], annotator.items(data.tracks.map((t) => ({ ...t, album: t.album || data.title })), user.id))
    }
    throw new DiscoveryError('UNKNOWN_PROVIDER', 'Unknown provider.')
  }

  // Songs of a library album that are not in the user's library: the same
  // release is looked up on Deezer (artist discography first, then a search)
  // and its tracks are compared with what the user owns.
  const NO_ALBUM = new Set(['', 'unknown album', 'unknown', 'single', 'singles', 'bilinmeyen albüm'])
  async function albumMissing(user, local) {
    if (!enabled('deezer')) return { available: false, found: false, missing: [] }
    const title = String(local?.title || '').trim()
    const artist = String(local?.artist || '').trim()
    const want = albumBaseKey(title)
    if (!want || !artist || NO_ALBUM.has(normalizeKey(title)) || !local.tracks?.length) return { available: true, found: false, missing: [] }
    const exact = normalizeKey(title)
    let candidates = []
    for (const name of [...new Set([artist, artist.split(/\s*(?:,|;|&|\/| feat\.? | ft\.? | x )\s*/i)[0]])]) {
      const artistId = await dz.artistId(name).catch(() => null)
      if (!artistId) continue
      candidates = (await dz.artistAlbums(artistId).catch(() => [])).filter((a) => albumBaseKey(a.title) === want)
      if (candidates.length) break
    }
    if (!candidates.length) {
      candidates = (await dz.searchAlbums(`${artist} ${title}`).catch(() => []))
        .filter((a) => albumBaseKey(a.title) === want && artistsMatch(a.artist, artist))
    }
    if (!candidates.length) return { available: true, found: false, missing: [] }
    // Prefer the same edition name, then the release closest in size to (but
    // not smaller than) what is owned: a deluxe edition is not "missing" songs.
    const have = new Set(local.tracks.map((t) => cleanTitleForMatch(t.title)).filter(Boolean))
    const owned = have.size
    const score = (a) => (normalizeKey(a.title) === exact ? 0 : 1000) + ((a.trackCount || 0) >= owned ? (a.trackCount || 0) - owned : 500 + owned - (a.trackCount || 0))
    const best = [...candidates].sort((a, b) => score(a) - score(b))[0]
    const data = await dz.album(best.id)
    if (!data) return { available: true, found: false, missing: [] }
    const tracks = annotator.items(data.tracks, user.id)
    // Titles already in this album also count as owned (store and file titles
    // can differ in details the matcher is strict about).
    const missing = tracks.filter((t) => !t.library && !have.has(cleanTitleForMatch(t.title)))
    return { available: true, found: true, album: annotator.items([data.album], user.id)[0], total: tracks.length, missing }
  }

  async function playlistAnswer(user, playlist, tracks) {
    const links = playlist.url ? await annotator.links(playlist.url) : []
    return { playlist: annotator.items([playlist], user.id)[0], tracks: annotator.items(tracks, user.id, { links }) }
  }

  async function onlinePlaylist(user, { provider, id, url, mix } = {}) {
    if (provider === 'deezer' && mix === 'artist') {
      const artistId = requireId(id)
      if (!/^\d+$/.test(artistId)) throw new DiscoveryError('INVALID_ID', 'Invalid id.')
      const [artist, tracks] = await Promise.all([dz.artist(artistId).catch(() => null), dz.artistRadio(artistId)])
      if (!artist) throw new DiscoveryError('NOT_FOUND', 'Artist not found online.', 404)
      const playlist = {
        provider: 'deezer', kind: 'playlist', id: `artist-mix-${artistId}`, title: `${artist.title} Mix`, artist: 'Deezer',
        artworkUrl: artist.artworkUrl, url: null, sourceUrl: artist.url, mix: 'deezer', mixId: artistId, downloadable: false, seed: artist.title, trackCount: tracks.length
      }
      return playlistAnswer(user, playlist, tracks)
    }
    if (provider === 'deezer') {
      const data = await dz.playlist(requireId(id))
      if (!data) throw new DiscoveryError('NOT_FOUND', 'Playlist not found.', 404)
      return playlistAnswer(user, data.playlist, data.tracks)
    }
    if (provider === 'youtube') {
      const link = requireYouTubeUrl(url)
      // Mixes (RD…, but not YouTube Music's own RDCLAK playlists) are read
      // like the download pipeline reads them.
      const listId = new URL(link).searchParams.get('list') || ''
      const automix = /^RD/.test(listId) && !/^RDCLAK/.test(listId)
      const data = await yt.playlist(link, null, automix)
      const playlist = { provider: 'youtube', kind: 'playlist', id: listId || link, title: data.title, artist: 'YouTube Music', trackCount: data.count, url: link, artworkUrl: data.tracks[0]?.artworkUrl || null, mix: automix ? 'youtube' : undefined }
      return playlistAnswer(user, playlist, data.tracks)
    }
    if (provider === 'spotify') {
      const listId = requireId(id)
      const data = await sp.playlist(listId)
      if (!data) throw new DiscoveryError('NOT_FOUND', 'Playlist not found.', 404)
      const playlist = { provider: 'spotify', kind: 'playlist', id: listId, title: data.title, artist: 'Spotify', trackCount: data.count, url: `https://open.spotify.com/playlist/${listId}`, artworkUrl: data.tracks[0]?.artworkUrl || null }
      return playlistAnswer(user, playlist, data.tracks)
    }
    if (provider === 'apple') {
      if (!apple) throw new DiscoveryError('PROVIDER_DISABLED', 'Apple Music is not available.', 409)
      const data = await ap.playlist(String(url || ''))
      if (!data) throw new DiscoveryError('INVALID_URL', 'Not an Apple Music playlist link.')
      const playlist = { provider: 'apple', kind: 'playlist', id: new URL(url).pathname.split('/').pop(), title: data.title, artist: 'Apple Music', trackCount: data.count, url, artworkUrl: data.tracks[0]?.artworkUrl || null }
      return playlistAnswer(user, playlist, data.tracks)
    }
    throw new DiscoveryError('UNKNOWN_PROVIDER', 'Unknown provider.')
  }

  // Deezer's list of an artist's albums has no song counts, so an album the
  // library has one song of looked complete. Owned albums are checked song
  // by song (like their album page): complete only when every song is in
  // the library. Read a few at a time; what is not read within the time
  // budget keeps the count-based guess and is ready (cached) next time.
  const OWNED_CHECK_MS = 3500
  async function checkOwnedAlbums(items, userId) {
    // Albums and EPs first: singles are one song and rarely partly owned.
    const owned = items.filter((a) => a.library && a.provider === 'deezer' && a.id)
      .sort((a, b) => Number(a.recordType === 'single') - Number(b.recordType === 'single'))
    if (!owned.length) return
    let next = 0
    const worker = async () => {
      while (next < owned.length) {
        const item = owned[next++]
        try {
          const data = await dz.album(item.id)
          if (!data?.tracks?.length) continue
          const links = await annotator.links(data.album?.url || item.url)
          const tracks = annotator.items(data.tracks, userId, { links })
          const have = tracks.filter((t) => t.library).length
          item.trackCount = item.trackCount || data.album?.trackCount || tracks.length
          item.library = { ...item.library, ownedTracks: have, complete: have >= tracks.length }
        } catch (error) {
          logger.debug?.(`[player] album check failed for ${item.id}: ${error?.message || error}`)
        }
      }
    }
    await timeout(Promise.all([worker(), worker(), worker(), worker()]), OWNED_CHECK_MS)
  }

  // Artist page: by Deezer id, or by name (e.g. from a library artist page).
  // Albums you do not own are what makes "complete the discography" possible.
  async function onlineArtist(user, { id, name } = {}) {
    if (!enabled('deezer')) throw new DiscoveryError('PROVIDER_DISABLED', 'Online artist data needs Deezer to be enabled.', 409)
    // "A, B" is not an artist online: then the first of them.
    let artistId = id ? requireId(id) : await dz.artistId(String(name || '').slice(0, 200))
    if (!artistId && !id) {
      const names = artistCreditNames(String(name || '').slice(0, 200))
      if (names.length > 1) artistId = await dz.artistId(names[0])
    }
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
    await checkOwnedAlbums(annotatedAlbums, user.id)
    const mainArtist = annotator.items([artist], user.id)[0]
    const relatedArtists = annotator.items(related, user.id)
    // The photos are already here: library artists keep them (no extra lookup).
    for (const a of [mainArtist, ...relatedArtists]) {
      if (a.library?.artistId && a.artworkUrl) artistPhotos?.remember(a.library.artistId, a.title, a.artworkUrl)
    }
    return {
      artist: { ...mainArtist, follow: followState(user.id, mainArtist) },
      topTracks: annotator.items(top, user.id),
      albums: annotatedAlbums.filter((a) => a.recordType !== 'single'),
      singles: annotatedAlbums.filter((a) => a.recordType === 'single'),
      related: relatedArtists,
      missingAlbums: annotatedAlbums.filter((a) => a.recordType !== 'single' && !a.library).length
    }
  }

  // Every song of an artist on Deezer (albums, singles, EPs; newest first),
  // one entry per song, each marked when it is in the library already, so
  // missing ones can be picked and downloaded. Albums are read at most three
  // at a time and kept in the online cache like album pages.
  async function onlineArtistTracks(user, { id, name } = {}) {
    if (!enabled('deezer')) throw new DiscoveryError('PROVIDER_DISABLED', 'Online artist data needs Deezer to be enabled.', 409)
    const wanted = String(name || '').slice(0, 200)
    let artistId = id ? requireId(id) : await dz.artistId(wanted)
    if (!artistId && !id) {
      const names = artistCreditNames(wanted)
      if (names.length > 1) artistId = await dz.artistId(names[0])
    }
    if (!artistId) throw new DiscoveryError('NOT_FOUND', 'Artist not found online.', 404)
    const [artist, albums] = await Promise.all([dz.artist(artistId).catch(() => null), dz.artistAlbums(artistId).catch(() => [])])
    if (!artist) throw new DiscoveryError('NOT_FOUND', 'Artist not found online.', 404)
    const releases = [...albums].sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || ''))).slice(0, 60)
    const details = new Array(releases.length).fill(null)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(3, releases.length) }, async () => {
      while (next < releases.length) {
        const i = next++
        details[i] = await dz.album(releases[i].id).catch(() => null)
      }
    }))
    // Compilations of the artist can carry other artists' songs: keep the
    // ones crediting this artist.
    const own = new Set(artistCreditKeys(artist.title || wanted))
    const seen = new Set()
    const tracks = []
    details.forEach((detail, i) => {
      if (!detail) return
      const year = Number(String(releases[i].releaseDate || '').slice(0, 4)) || null
      for (const track of detail.tracks) {
        if (own.size && !artistCreditKeys(track.artist).some((key) => own.has(key))) continue
        const key = songKey(track.title, track.artist) || `${track.provider}:${track.id}`
        if (seen.has(key)) continue
        seen.add(key)
        tracks.push({ ...track, year, recordType: releases[i].recordType || null })
        if (tracks.length >= 800) return
      }
    })
    const items = annotator.items(tracks, user.id)
    return {
      artist: annotator.items([artist], user.id)[0],
      tracks: items,
      releases: releases.length,
      missing: items.filter((t) => !t.library).length
    }
  }

  // "Complete the discography": every release of the artist on Deezer that
  // the library lacks songs of (albums, EPs, singles, compilations; newest
  // first) with its songs, plus missing popular songs that are on none of
  // them. A single's song that an album in the list has too (same song,
  // practically the same length) points at it (`sameAs`), so picking both
  // downloads it once.
  const GAPS_MAX_RELEASES = 80
  async function onlineArtistGaps(user, { id, name } = {}) {
    if (!enabled('deezer')) throw new DiscoveryError('PROVIDER_DISABLED', 'Online artist data needs Deezer to be enabled.', 409)
    const wanted = String(name || '').slice(0, 200)
    let artistId = id ? requireId(id) : await dz.artistId(wanted)
    if (!artistId && !id) {
      const names = artistCreditNames(wanted)
      if (names.length > 1) artistId = await dz.artistId(names[0])
    }
    if (!artistId) throw new DiscoveryError('NOT_FOUND', 'Artist not found online.', 404)
    const [artist, top, albums] = await Promise.all([
      dz.artist(artistId).catch(() => null),
      dz.artistTop(artistId).catch(() => []),
      dz.artistAlbums(artistId).catch(() => [])
    ])
    if (!artist) throw new DiscoveryError('NOT_FOUND', 'Artist not found online.', 404)
    const releases = [...albums].sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || ''))).slice(0, GAPS_MAX_RELEASES)
    const details = new Array(releases.length).fill(null)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, releases.length) }, async () => {
      while (next < releases.length) {
        const i = next++
        details[i] = await dz.album(releases[i].id).catch(() => null)
      }
    }))
    const own = new Set(artistCreditKeys(artist.title || wanted))
    const credited = (track) => !own.size || artistCreditKeys(track.artist).some((key) => own.has(key))
    // Songs already on their way (the wizard opened again while its first
    // picks download) are shown as downloading, not as missing.
    const flight = annotator.inFlight ? annotator.inFlight(user.id) : new Map()
    const onItsWay = (song, releaseUrl) => {
      if (flight.has(song.url)) return true
      const there = releaseUrl && flight.get(releaseUrl)
      if (!there) return false
      if (!there.only) return true
      const key = songKey(song.title, song.artist)
      return there.only.some((o) => (o.id && song.id != null && o.id === String(song.id)) || (o.url && o.url === song.url) || (key && songKey(o.title, o.artist) === key))
    }
    const out = []
    for (let i = 0; i < releases.length; i += 1) {
      const detail = details[i]
      if (!detail?.tracks?.length) continue
      const recordType = releases[i].recordType || detail.album?.recordType || 'album'
      // A compilation can carry other artists' songs: only this artist's.
      const listed = recordType === 'compile' ? detail.tracks.filter(credited) : detail.tracks
      if (!listed.length) continue
      const links = await annotator.links(detail.album?.url || releases[i].url)
      const releaseUrl = detail.album?.url || releases[i].url
      const tracks = annotator.items(listed, user.id, { links })
        .map((t) => (!t.library && (onItsWay(t, releases[i].url) || onItsWay(t, releaseUrl)) ? { ...t, downloading: true } : t))
      if (!tracks.some((t) => !t.library)) continue
      const [album] = annotator.items([{ ...releases[i], trackCount: detail.album?.trackCount || releases[i].trackCount }], user.id)
      out.push({
        ...album,
        recordType,
        year: Number(String(releases[i].releaseDate || '').slice(0, 4)) || null,
        trackCount: tracks.length,
        tracks: tracks.map((t) => ({ ...t, album: t.album || album.title }))
      })
    }
    // The same song on several releases (a single re-released, a single whose
    // song an album has too) is downloaded once: a single's copy points at the
    // first one (albums, EPs and compilations first, then newer singles) by
    // `sameAs`, and counts as downloading when that one is on its way.
    const sameSong = (a, b) => songKey(a.title, a.artist) === songKey(b.title, b.artist) &&
      (!a.duration || !b.duration || sameRecordingLength(a.duration, b.duration))
    const ordered = [...out.filter((r) => r.recordType !== 'single'), ...out.filter((r) => r.recordType === 'single')]
    // A copy on its way is the one that counts.
    const firstCopies = ordered.flatMap((r) => r.tracks.filter((t) => t.downloading))
    for (const release of ordered) {
      for (const track of release.tracks) {
        if (track.library || track.downloading) continue
        const twin = firstCopies.find((other) => sameSong(track, other))
        if (!twin) firstCopies.push(track)
        else if (twin.downloading) track.downloading = true
        else if (release.recordType === 'single') track.sameAs = twin.url
      }
    }
    const releasesOut = []
    let downloadingTracks = 0
    for (const release of out) {
      release.missing = release.tracks.filter((t) => !t.library && !t.downloading).length
      release.downloading = release.tracks.filter((t) => t.downloading).length
      downloadingTracks += release.downloading
      if (release.missing) releasesOut.push(release)
    }
    const listedKeys = new Set(out.flatMap((r) => r.tracks.map((t) => songKey(t.title, t.artist))))
    const popular = []
    for (const t of annotator.items(top.slice(0, 10), user.id)) {
      if (t.library || listedKeys.has(songKey(t.title, t.artist))) continue
      if (onItsWay(t, null)) downloadingTracks += 1
      else popular.push(t)
    }
    return {
      artist: annotator.items([artist], user.id)[0],
      releases: releasesOut,
      popular,
      // Only what is pickable counts; `downloadingTracks` are on their way.
      missingTracks: releasesOut.reduce((n, r) => n + r.missing, 0) + popular.length,
      downloadingTracks
    }
  }

  // Follow state of an online artist: the library artist when the user has
  // their songs, else an artist kept only because someone follows it.
  const artistIdByKey = db.prepare('SELECT id FROM artists WHERE name_key = ?')
  const isFollowed = db.prepare("SELECT 1 FROM favorites WHERE user_id = ? AND item_type = 'artist' AND item_id = ?")
  function followState(userId, artist) {
    const artistId = artist.library?.artistId || artistIdByKey.get(normalizeKey(artist.title))?.id || null
    return { artistId, following: Boolean(artistId && isFollowed.get(Number(userId), artistId)) }
  }

  // Deezer photo of an artist (exact name only). undefined = cannot tell now.
  async function artistPhotoUrl(name) {
    if (!enabled('deezer')) return undefined
    const id = await dz.artistId(String(name || '').slice(0, 200))
    if (!id) return null
    const artist = await dz.artist(id)
    return artist?.artworkUrl || null
  }

  // Keeps the photo of a just-followed artist (the Deezer artist is usually
  // still cached from the page the follow came from).
  async function rememberArtistPhoto(artistId, deezerId) {
    if (!artistPhotos || !enabled('deezer') || !/^\d+$/.test(String(deezerId))) return
    const artist = await dz.artist(deezerId).catch(() => null)
    if (artist?.artworkUrl) artistPhotos.remember(artistId, artist.title, artist.artworkUrl)
  }

  // Online songs that fit a personal mix: artist radios of the mix's artists
  // (Deezer), only songs the user does not own yet. Same picks all day.
  // Songs that go with a set of artists (mixes, playlists): Deezer artist
  // radios. Songs not in the library are suggestions to preview / download;
  // the ones the user already owns are returned as library track ids.
  async function radioSuggestions(user, { artists = [], seedKey = '', limit = 15 } = {}) {
    if (!enabled('deezer')) return { enabled: false, items: [], ownedIds: [] }
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
    const ownedIds = []
    for (const item of annotator.items(lists.flat(), user.id)) {
      const key = songKey(item.title, item.artist) || item.url
      if (seen.has(key)) continue
      seen.add(key)
      if (item.library?.trackId) ownedIds.push(item.library.trackId)
      else if (!item.library) pool.push(item)
    }
    const rnd = seededRandom(`${user.id}:${seedKey}:${localDayKey(now())}:online`)
    return { enabled: true, items: seededShuffle(pool, rnd).slice(0, limit), ownedIds }
  }

  // For the autoplay continuation: artists Deezer calls related to `artist`
  // and the user's own songs that Deezer's artist radio plays. A collaboration
  // is looked up as the whole credit and as its first two names. Empty when
  // Deezer is off or does not answer in time (the lookups are cached).
  async function autoplayRelated(user, artist, { timeoutMs = 3000 } = {}) {
    const empty = { artists: [], trackIds: [] }
    const full = String(artist || '').trim().slice(0, 200)
    if (!full || !enabled('deezer')) return empty
    const names = [...new Set([full, ...artistCredits(full).slice(0, 2)])]
    const lists = await Promise.all(names.map(async (name) => {
      try {
        const id = await timeout(dz.artistId(name), timeoutMs)
        if (!id) return null
        const [related, radio] = await Promise.all([
          timeout(dz.artistRelated(id), timeoutMs).catch(() => []),
          timeout(dz.artistRadio(id), timeoutMs).catch(() => [])
        ])
        return { related: related || [], radio: radio || [] }
      } catch { return null }
    }))
    const found = lists.filter(Boolean)
    const artists = [...new Set(found.flatMap((entry) => entry.related.map((a) => a.title)).filter(Boolean))].slice(0, 30)
    const trackIds = [...new Set(annotator.items(found.flatMap((entry) => entry.radio), user.id)
      .map((item) => item.library?.trackId).filter(Boolean))]
    return { artists, trackIds }
  }

  async function mixSuggestions(user, { mixId, artists = [], limit = 15 } = {}) {
    return radioSuggestions(user, { artists, seedKey: mixId, limit })
  }

  // Deezer discography of an artist (by exact name or a known id), for the
  // new-release watch. null when Deezer is off or the artist is unknown.
  async function artistReleases(name, knownId = null) {
    if (!enabled('deezer')) return null
    const id = knownId || await dz.artistId(String(name || '').slice(0, 200))
    if (!id) return null
    return { id: String(id), albums: await dz.artistAlbums(id) }
  }

  return { discover, mood, onlineAlbum, albumMissing, onlinePlaylist, onlineArtist, onlineArtistTracks, onlineArtistGaps, artistPhotoUrl, rememberArtistPhoto, artistMixes, artistReleases, seedArtists, mixSuggestions, radioSuggestions, autoplayRelated, moods: () => MOOD_PRESETS }
}
