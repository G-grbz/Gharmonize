import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rateLimit } from '../rateLimit.js'
import { networkGate } from './network.js'
import { getRemoteAccessMode } from './gate.js'
import { PLAYER_SESSION_COOKIE, SESSION_TTL_MS, readPlayerTokenFromRequest, PlayerAuthError } from './auth.js'
import { LibraryError } from './libraries.js'
import { CatalogError, clampLimit, clampOffset } from './catalog.js'
import { BridgeError } from './bridge.js'
import { OnlineError, freshDeezerPreview } from './online.js'
import { DiscoveryError } from './discovery.js'
import { FollowError } from './follows.js'
import { HealthError } from './health.js'
import { SearchHistoryError } from './searchHistory.js'
import { getInstallId } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let cachedVersion = null
function appVersion() {
  if (cachedVersion) return cachedVersion
  try { cachedVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).version } catch { cachedVersion = '0.0.0' }
  return cachedVersion
}

// The Gharmonize administrator session bridge is resolved lazily so the player
// can be unit-tested without loading the full settings module.
async function defaultAdminBridge() {
  const mod = await import('../settings.js')
  return { getSession: mod.getAdminSessionFromRequest, verifyPassword: mod.verifyAdminPassword }
}

const KNOWN_ERRORS = [PlayerAuthError, LibraryError, CatalogError, BridgeError, OnlineError, DiscoveryError, FollowError, HealthError, SearchHistoryError]

function sendError(res, status, code, message) {
  res.set('Cache-Control', 'no-store')
  return res.status(status).json({ error: { code, message } })
}

function intParam(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

// Browser sessions are listed under a readable name ("Chrome · Android").
function webName(value) {
  return String(value || '').replace(/[^\p{L}\p{N} ·._()-]/gu, '').trim().slice(0, 60) || 'Web'
}

function bool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())
}

export function createPlayerRouter(ctx, { adminBridge = defaultAdminBridge, getMode = () => getRemoteAccessMode() } = {}) {
  const { auth, access, libraries, catalog, scanner, artwork, stream, waveform, lyrics, online, bridge, annotator, discovery, biography, onlineCache, getConfig, updateConfig, connectInfo, follows, releases, health } = ctx
  const router = express.Router()
  let bridgePromise = null
  const getAdminBridge = () => (bridgePromise ||= Promise.resolve(adminBridge()).catch((error) => { bridgePromise = null; throw error }))

  router.use(networkGate({ getMode }))

  // Media requests (seek/range, cover grids) are frequent; API calls are not.
  const mediaLimiter = rateLimit(3000, 60_000)
  const apiLimiter = rateLimit(1200, 60_000)
  router.use((req, res, next) => (/^\/(stream|artwork)\//.test(req.path) ? mediaLimiter : apiLimiter)(req, res, next))

  // Identity: a player account (session cookie or Bearer device token), and
  // independently whether the request carries a Gharmonize admin session.
  router.use(async (req, _res, next) => {
    const raw = readPlayerTokenFromRequest(req)
    const resolved = raw ? auth.resolveToken(raw, { ip: req.ip }) : null
    req.playerUser = resolved?.user || null
    req.playerToken = resolved?.token || null
    req.gharmonizeAdmin = false
    try {
      const b = await getAdminBridge()
      req.gharmonizeAdmin = Boolean(b.getSession(req))
    } catch {}
    next()
  })

  const requireUser = (req, res, next) => {
    if (!req.playerUser) return sendError(res, 401, 'PLAYER_AUTH_REQUIRED', 'Sign in to Gharmonize Player.')
    next()
  }
  const requireAdmin = (req, res, next) => {
    if (req.gharmonizeAdmin || req.playerUser?.role === 'admin') return next()
    return sendError(res, req.playerUser ? 403 : 401, 'PLAYER_ADMIN_REQUIRED', 'Player administrator rights are required.')
  }
  const uid = (req) => req.playerUser?.id || 0

  // Artwork refs leave the server versioned ("album/5/<token>"): the token
  // changes with the install and with the files behind the cover, so the
  // long-lived browser/app image caches never show a stale or foreign cover.
  router.use((req, res, next) => {
    if (typeof artwork?.versionRefs === 'function') {
      const json = res.json.bind(res)
      res.json = (body) => json(artwork.versionRefs(body, uid(req)))
    }
    next()
  })

  function setSessionCookie(req, res, token) {
    res.cookie(PLAYER_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: Boolean(req.secure), path: '/', maxAge: SESSION_TTL_MS })
  }

  // ---- public ----------------------------------------------------------------

  router.get('/status', (req, res) => {
    res.set('Cache-Control', 'no-store')
    const config = getConfig()
    res.json({
      enabled: true,
      name: config.serverName,
      version: appVersion(),
      setupRequired: !auth.hasUsers(),
      network: req.playerNetwork,
      remoteAccess: getMode(),
      user: req.playerUser,
      gharmonizeAdmin: req.gharmonizeAdmin
    })
  })

  // First account. Requires the Gharmonize administrator (session or password).
  router.post('/setup', rateLimit(5, 60_000), async (req, res) => {
    if (auth.hasUsers()) return sendError(res, 409, 'SETUP_DONE', 'Gharmonize Player is already set up.')
    const { username, password, displayName, adminPassword, deviceName } = req.body || {}
    const b = await getAdminBridge()
    const authorized = req.gharmonizeAdmin || b.verifyPassword(adminPassword)
    if (!authorized) return sendError(res, 401, 'GHARMONIZE_ADMIN_REQUIRED', 'The Gharmonize administrator password is required for the first setup.')
    if (auth.hasUsers()) return sendError(res, 409, 'SETUP_DONE', 'Gharmonize Player is already set up.')
    const user = auth.createUser({ username, password, displayName, role: 'admin' })
    const issued = auth.issueToken(user.id, { kind: 'session', name: webName(deviceName), platform: 'web', ip: req.ip })
    setSessionCookie(req, res, issued.token)
    res.status(201).json({ user })
  })

  router.post('/auth/login', rateLimit(10, 60_000), (req, res) => {
    const { username, password, client, deviceName, platform } = req.body || {}
    const user = auth.verifyCredentials(username, password)
    if (!user) return sendError(res, 401, 'BAD_CREDENTIALS', 'Wrong username or password.')
    if (client === 'device') {
      const issued = auth.issueToken(user.id, { kind: 'device', name: deviceName || 'Device', platform, ip: req.ip })
      return res.json({ user, token: issued.token, tokenId: issued.id })
    }
    const issued = auth.issueToken(user.id, { kind: 'session', name: webName(deviceName), platform: 'web', ip: req.ip })
    setSessionCookie(req, res, issued.token)
    res.json({ user, expiresAt: issued.expiresAt })
  })

  router.post('/auth/logout', (req, res) => {
    if (req.playerToken) auth.revokeToken(req.playerToken.id)
    res.clearCookie(PLAYER_SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' })
    res.json({ ok: true })
  })

  // Exchanges a short-lived pairing code for a device token.
  // client 'web': a phone camera opened the QR link, so sign this browser in
  // with a normal session cookie; apps get a device token in the response.
  router.post('/pair', rateLimit(10, 60_000), (req, res) => {
    const { code, deviceName, platform, client } = req.body || {}
    if (client === 'web') {
      const issued = auth.redeemPairingCode(code, { name: webName(deviceName), platform: 'web', ip: req.ip, kind: 'session' })
      setSessionCookie(req, res, issued.token)
      return res.json({ user: issued.user, expiresAt: issued.expiresAt, serverName: getConfig().serverName })
    }
    const issued = auth.redeemPairingCode(code, { name: deviceName, platform, ip: req.ip })
    res.json({ user: issued.user, token: issued.token, tokenId: issued.id, serverName: getConfig().serverName })
  })

  // ---- media (authenticated) ------------------------------------------------

  router.get('/stream/:id', requireUser, async (req, res) => {
    const track = catalog.getTrackRow(intParam(req.params.id), uid(req))
    if (!track) return sendError(res, 404, 'NOT_FOUND', 'Track not found.')
    await stream.serveTrack(req, res, track, req.query)
  })

  // Real waveform for the "wave" seek bar: { bins: [0..100 × 240] }.
  router.get('/waveform/:id', requireUser, async (req, res) => {
    const track = catalog.getTrackRow(intParam(req.params.id), uid(req))
    if (!track) return sendError(res, 404, 'NOT_FOUND', 'Track not found.')
    if (!waveform) return sendError(res, 404, 'NO_WAVEFORM', 'Waveform unavailable.')
    // The URL only carries the track id, which another install on the same
    // address (or a later song reusing the id) shares: revalidate every time
    // against an ETag of the actual file instead of caching by URL.
    if (typeof waveform.tagFor === 'function') {
      let installId = ''
      try { installId = ctx.db ? getInstallId(ctx.db) : '' } catch {}
      res.set('ETag', `"wf-${waveform.tagFor(track, installId)}"`)
      res.set('Cache-Control', 'private, no-cache')
      if (req.fresh) return res.status(304).end()
    }
    try {
      const data = await waveform.getWaveform(track)
      if (!data) {
        res.removeHeader('ETag')
        return sendError(res, 404, 'FILE_MISSING', 'The audio file is no longer available.')
      }
      res.json({ bins: data.bins })
    } catch {
      res.removeHeader('ETag')
      res.set('Cache-Control', 'no-store')
      sendError(res, 422, 'NO_WAVEFORM', 'Waveform unavailable.')
    }
  })

  // /artwork/album/5/<token>: a URL whose token matches the current files may
  // be cached for good. Bare or outdated URLs (old clients, persisted queues)
  // are revalidated on every use instead, as are folder images, which can
  // change without the song files changing.
  router.get('/artwork/:kind/:id{/:ver}', requireUser, async (req, res) => {
    const id = intParam(req.params.id)
    if (!id) return sendError(res, 404, 'NOT_FOUND', 'Artwork not found.')
    const kind = String(req.params.kind)
    const art = await artwork.getArtwork(kind, id, req.query.size, uid(req))
    const current = req.params.ver ? artwork.versionFor?.(kind, id, uid(req)) : null
    const pinned = Boolean(current) && req.params.ver === current
    if (!art) {
      res.set('Cache-Control', pinned ? 'private, max-age=600' : 'private, no-cache')
      return sendError(res, 404, 'NO_ARTWORK', 'No artwork available.')
    }
    // An empty file is never sent, least of all as cacheable for a year.
    const size = await fs.promises.stat(art.file).then((st) => st.size).catch(() => 0)
    if (!size) {
      res.set('Cache-Control', 'no-store')
      return sendError(res, 404, 'NO_ARTWORK', 'No artwork available.')
    }
    res.set('Cache-Control', pinned && art.stable !== false ? 'private, max-age=31536000, immutable' : 'private, no-cache')
    res.type(art.contentType)
    res.sendFile(art.file, { dotfiles: 'allow', lastModified: true, cacheControl: false }, (err) => {
      if (err && !res.headersSent) sendError(res, 404, 'NO_ARTWORK', 'No artwork available.')
    })
  })

  // ---- catalog ---------------------------------------------------------------

  router.get('/home', requireUser, (req, res) => res.json(catalog.home(uid(req))))
  router.get('/stats', requireUser, (req, res) => res.json(catalog.getStats(uid(req))))
  router.get('/search', requireUser, (req, res) => res.json(catalog.search(req.query.q, { limit: req.query.limit, userId: uid(req) })))
  // The user's own search history (every device shows the same one):
  // { queries: [{ q, at }], items: [{ key, at, source, kind, track|album|artist|item }] }.
  router.get('/search/history', requireUser, (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json(ctx.searchHistory.list(uid(req)))
  })
  // { q } and / or { item: { source: 'library', kind, id } | { source: 'online', online } }.
  router.post('/search/history', requireUser, rateLimit(120, 60_000), (req, res) => {
    const body = req.body || {}
    if (body.q == null && body.item == null) throw new SearchHistoryError('BAD_REQUEST', 'Nothing to remember.')
    if (body.q != null) ctx.searchHistory.addQuery(uid(req), body.q)
    if (body.item != null) ctx.searchHistory.addItem(uid(req), body.item)
    res.json({ ok: true })
  })
  // ?q= removes one search text, ?key= one picked result, neither: all.
  router.delete('/search/history', requireUser, (req, res) => {
    ctx.searchHistory.remove(uid(req), { query: req.query.q ?? null, key: req.query.key ?? null })
    res.json({ ok: true })
  })
  router.get('/genres', requireUser, (req, res) => res.json({ items: catalog.listGenres({ limit: req.query.limit, userId: uid(req) }) }))

  router.get('/tracks', requireUser, (req, res) => {
    res.json({
      items: catalog.listTracks({
        sort: req.query.sort,
        limit: req.query.limit,
        offset: req.query.offset,
        genre: req.query.genre,
        artistId: intParam(req.query.artistId),
        favorites: bool(req.query.favorites),
        userId: uid(req)
      })
    })
  })
  router.post('/tracks/batch', requireUser, (req, res) => res.json({ items: catalog.getTracksByIds(req.body?.ids, uid(req)) }))
  router.get('/tracks/:id', requireUser, (req, res) => {
    const track = catalog.getTrack(intParam(req.params.id), uid(req))
    if (!track) return sendError(res, 404, 'NOT_FOUND', 'Track not found.')
    res.json(track)
  })
  router.get('/tracks/:id/lyrics', requireUser, async (req, res) => {
    const track = catalog.getTrackRow(intParam(req.params.id), uid(req))
    if (!track) return sendError(res, 404, 'NOT_FOUND', 'Track not found.')
    const found = await lyrics.getLyrics(track)
    // ?soft=1 (current apps): "no lyrics" is an answer, not an error, so
    // browsers do not log a failed request for every song without lyrics.
    // Older apps still get the 404 they expect.
    if (!found) return req.query.soft ? res.json({ none: true }) : sendError(res, 404, 'NO_LYRICS', 'No lyrics found.')
    res.json(found)
  })

  router.get('/albums', requireUser, (req, res) => {
    res.json({
      items: catalog.listAlbums({
        sort: req.query.sort,
        limit: req.query.limit,
        offset: req.query.offset,
        artistId: intParam(req.query.artistId),
        genre: req.query.genre,
        favorites: bool(req.query.favorites),
        userId: uid(req)
      })
    })
  })
  router.get('/albums/:id', requireUser, (req, res) => {
    const album = catalog.getAlbum(intParam(req.params.id), uid(req))
    if (!album) return sendError(res, 404, 'NOT_FOUND', 'Album not found.')
    res.json(album)
  })
  // Songs of this album that the user does not have yet (from Deezer).
  router.get('/albums/:id/missing', requireUser, rateLimit(60, 60_000), async (req, res) => {
    const album = catalog.getAlbum(intParam(req.params.id), uid(req))
    if (!album) return sendError(res, 404, 'NOT_FOUND', 'Album not found.')
    try {
      res.json(await discovery.albumMissing(req.playerUser, album))
    } catch {
      res.json({ available: true, found: false, error: true, missing: [] })
    }
  })

  router.get('/artists', requireUser, (req, res) => {
    res.json({ items: catalog.listArtists({ sort: req.query.sort, limit: req.query.limit, offset: req.query.offset, favorites: bool(req.query.favorites), userId: uid(req) }) })
  })
  router.get('/artists/:id', requireUser, (req, res) => {
    const artist = catalog.getArtist(intParam(req.params.id), uid(req))
    if (!artist) return sendError(res, 404, 'NOT_FOUND', 'Artist not found.')
    res.json(artist)
  })

  // All of an artist's songs in the libraries this user can see.
  router.get('/artists/:id/tracks', requireUser, (req, res) => {
    const id = intParam(req.params.id)
    if (!catalog.getArtist(id, uid(req))) return sendError(res, 404, 'NOT_FOUND', 'Artist not found.')
    res.json({ items: catalog.artistTracks(id, uid(req), { sort: String(req.query.sort || 'album'), limit: req.query.limit, offset: req.query.offset }) })
  })

  // ---- mixes & listening statistics ---------------------------------------------

  router.get('/mixes', requireUser, (req, res) => res.json({ items: ctx.mixes.list(uid(req)) }))
  router.get('/mixes/:id', requireUser, (req, res) => {
    const mix = ctx.mixes.get(uid(req), String(req.params.id))
    if (!mix) return sendError(res, 404, 'NOT_FOUND', 'Mix not found.')
    const { trackIds, ...rest } = mix
    res.json({ ...rest, tracks: catalog.getTracksByIds(trackIds, uid(req)) })
  })
  // "Goes well with this mix": library songs and new songs (to preview or
  // download) in one list.
  router.get('/mixes/:id/online', requireUser, rateLimit(60, 60_000), async (req, res) => {
    const mix = ctx.mixes.get(uid(req), String(req.params.id))
    if (!mix) return sendError(res, 404, 'NOT_FOUND', 'Mix not found.')
    res.json(await suggestionsFor(req, { seedIds: mix.trackIds, artists: mix.artists || [], seedKey: `mix:${mix.id}` }))
  })
  router.get('/stats/listening', requireUser, (req, res) => res.json(ctx.stats.listening(uid(req), { range: String(req.query.range || 'month') })))
  router.get('/stats/years', requireUser, (req, res) => res.json({ items: ctx.stats.years(uid(req)) }))
  router.get('/stats/wrapped', requireUser, (req, res) => res.json(ctx.stats.wrapped(uid(req), req.query.year)))

  // ---- personal --------------------------------------------------------------

  // Follow / unfollow an artist by name (online artist pages, including
  // artists with no songs here yet).
  router.put('/follows/artists', requireUser, (req, res) => {
    const body = req.body || {}
    const result = catalog.followArtistByName(uid(req), body.name, true)
    if (body.deezerId && result.id) discovery.rememberArtistPhoto?.(result.id, String(body.deezerId)).catch(() => {})
    res.json(result)
  })
  router.delete('/follows/artists', requireUser, (req, res) => res.json(catalog.followArtistByName(uid(req), req.query.name, false)))
  router.put('/favorites/:type/:id', requireUser, (req, res) => res.json(catalog.setFavorite(uid(req), req.params.type, intParam(req.params.id), true)))
  router.delete('/favorites/:type/:id', requireUser, (req, res) => res.json(catalog.setFavorite(uid(req), req.params.type, intParam(req.params.id), false)))

  router.post('/history', requireUser, (req, res) => {
    const body = req.body || {}
    res.json(catalog.recordPlay(uid(req), {
      trackId: intParam(body.trackId),
      playedMs: body.playedMs,
      completed: Boolean(body.completed),
      context: body.context,
      deviceId: req.playerToken?.id || ''
    }))
  })
  router.get('/history/recent', requireUser, (req, res) => res.json({ items: catalog.recentlyPlayed(uid(req), { limit: req.query.limit }) }))
  router.get('/history/top', requireUser, (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 0, 0), 3650)
    res.json({ items: catalog.mostPlayed(uid(req), { limit: req.query.limit, sinceMs: days ? Date.now() - days * 86_400_000 : null }) })
  })

  router.get('/playlists', requireUser, (req, res) => res.json({ items: catalog.listPlaylists(uid(req)) }))
  router.post('/playlists', requireUser, (req, res) => res.status(201).json(catalog.createPlaylist(uid(req), req.body || {})))
  router.get('/playlists/:id', requireUser, (req, res) => {
    const pl = catalog.getPlaylist(intParam(req.params.id), uid(req))
    // A playlist kept in sync with an online list says where it comes from.
    res.json({ ...pl, follow: follows?.forPlaylist(uid(req), pl.id) || null })
  })
  // Songs that would fit this playlist (library first, then new ones).
  router.get('/playlists/:id/suggestions', requireUser, rateLimit(60, 60_000), async (req, res) => {
    const pl = catalog.getPlaylist(intParam(req.params.id), uid(req))
    const counts = new Map()
    for (const tr of pl.tracks) if (tr.artist) counts.set(tr.artist, (counts.get(tr.artist) || 0) + 1)
    const artists = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name)
    const round = Math.max(0, Math.min(1000, Number.parseInt(req.query.round, 10) || 0))
    res.json(await suggestionsFor(req, { seedIds: pl.tracks.map((tr) => tr.id), artists, seedKey: `playlist:${pl.id}:${round}` }))
  })
  // More songs like the ones just played, for "keep playing" at the end of the
  // queue: a few by the same artist (also inside collaborations, spread out,
  // never first), related artists and songs their radio plays (Deezer, when
  // enabled), the same genre; listened songs first within each tier, topped
  // up from the library so it never ends.
  router.get('/autoplay', requireUser, rateLimit(120, 60_000), async (req, res) => {
    const ids = (value) => String(value || '').split(',').map((v) => Number.parseInt(v, 10)).filter((n) => n > 0).slice(0, 300)
    const userId = uid(req)
    const seedIds = ids(req.query.seed).slice(-20)
    let artist = String(req.query.artist || '').trim().slice(0, 200)
    if (!artist && seedIds.length) artist = catalog.getTracksByIds(seedIds.slice(-1), userId)[0]?.artist || ''
    let related = { artists: [], trackIds: [] }
    try { if (discovery?.autoplayRelated) related = await discovery.autoplayRelated(req.playerUser, artist) } catch {}
    res.json({ items: catalog.similarTracks(userId, {
      seedIds,
      excludeIds: ids(req.query.exclude),
      artist,
      genre: String(req.query.genre || '').trim().slice(0, 100),
      relatedArtists: related.artists,
      boostIds: related.trackIds,
      limit: Math.min(30, Number(req.query.limit) || 15),
      // A radio, not the artist's discography: a few songs by the artist,
      // the rest by related artists and others in the same genre.
      perArtist: 2,
      seedArtistMax: 3,
      spread: true,
      preferHistory: true,
      fill: true
    }) })
  })
  router.patch('/playlists/:id', requireUser, (req, res) => res.json(catalog.updatePlaylist(intParam(req.params.id), uid(req), req.body || {})))
  router.delete('/playlists/:id', requireUser, (req, res) => { catalog.deletePlaylist(intParam(req.params.id), uid(req)); res.json({ ok: true }) })
  router.post('/playlists/:id/tracks', requireUser, (req, res) => res.json(catalog.addPlaylistTracks(intParam(req.params.id), uid(req), req.body?.trackIds || [])))
  router.delete('/playlists/:id/tracks/:entryId', requireUser, (req, res) => res.json(catalog.removePlaylistEntry(intParam(req.params.id), uid(req), intParam(req.params.entryId))))
  router.post('/playlists/:id/move', requireUser, (req, res) => res.json(catalog.movePlaylistEntry(intParam(req.params.id), uid(req), intParam(req.body?.entryId), req.body?.toIndex)))

  // ---- suggestions (mixes, playlists) ---------------------------------------

  // A library song in the same shape as an online result, so one list can
  // hold both (it plays from the library and needs no download).
  const libraryAsOnline = (tr) => ({
    provider: 'library', kind: 'track', id: String(tr.id), url: `library:track:${tr.id}`,
    title: tr.title, artist: tr.artist || '', album: tr.album || '', duration: tr.duration || 0,
    artwork: tr.artwork, artworkUrl: null, library: { trackId: tr.id, ...(tr.albumId ? { albumId: tr.albumId } : {}) }, download: null
  })

  async function suggestionsFor(req, { seedIds = [], artists = [], seedKey = '', limit = 24 }) {
    const userId = uid(req)
    let radio = { enabled: false, items: [], ownedIds: [] }
    try { radio = await discovery.radioSuggestions(req.playerUser, { artists, seedKey, limit: Math.ceil(limit / 2) }) } catch {}
    const seeds = new Set(seedIds.map(Number))
    const fromRadio = catalog.getTracksByIds([...new Set(radio.ownedIds || [])].filter((id) => !seeds.has(Number(id))).slice(0, 8), userId)
    const similar = catalog.similarTracks(userId, { seedIds: seedIds.slice(0, 200), excludeIds: fromRadio.map((tr) => tr.id), limit: Math.ceil(limit / 2) })
    const library = [...fromRadio, ...similar].slice(0, Math.ceil(limit / 2)).map(libraryAsOnline)
    const online = radio.items || []
    const items = []
    for (let i = 0; i < Math.max(library.length, online.length); i++) {
      if (library[i]) items.push(library[i])
      if (online[i]) items.push(online[i])
    }
    return { enabled: Boolean(radio.enabled) || library.length > 0, items: items.slice(0, limit), libraryCount: library.length, onlineCount: online.length }
  }

  // ---- online search & download bridge -------------------------------------

  // Badges each online result with "already in your library" and
  // "downloading now" so the client can show play / download / progress.
  function annotateOnline(result, userId) {
    return { ...result, tracks: annotator.items(result.tracks, userId), albums: annotator.items(result.albums, userId), artists: annotator.items(result.artists, userId), playlists: annotator.items(result.playlists || [], userId) }
  }

  router.get('/online/providers', requireUser, (req, res) => {
    res.json({ providers: online.status(), canDownload: bridge.canDownload(req.playerUser) })
  })

  router.get('/online/search', requireUser, rateLimit(60, 60_000), async (req, res) => {
    const kinds = String(req.query.kinds || 'track,album,artist').split(',').map((k) => k.trim()).filter((k) => ['track', 'album', 'artist', 'playlist'].includes(k))
    const only = req.query.providers ? String(req.query.providers).split(',').map((p) => p.trim()) : null
    const result = await online.search(req.query.q, { kinds: kinds.length ? kinds : ['track'], limit: req.query.limit, only })
    res.json(annotateOnline(result, uid(req)))
  })

  // ---- online recommendations (shelves) & online detail pages --------------

  router.get('/discover', requireUser, rateLimit(60, 60_000), async (req, res) => {
    const scope = ['personal', 'global'].includes(req.query.scope) ? req.query.scope : 'all'
    // round: bumped by the refresh button for another pick of artists today.
    const round = Math.min(Math.max(Math.floor(Number(req.query.round) || 0), 0), 1000)
    res.json(await discovery.discover(req.playerUser, { lang: req.query.lang, scope, round }))
  })
  // Fresh 30 s preview link (Deezer links expire after minutes). Browsers get
  // a redirect, the phone app asks for JSON so its token never leaves the server.
  router.get('/online/preview/:provider/:id', requireUser, rateLimit(240, 60_000), async (req, res) => {
    if (req.params.provider !== 'deezer' || !(getConfig().onlineProviders || []).includes('deezer')) return sendError(res, 404, 'NO_PREVIEW', 'No preview available.')
    let url = null
    try { url = await freshDeezerPreview(req.params.id) } catch { return sendError(res, 502, 'PROVIDER_ERROR', 'The preview could not be loaded.') }
    if (!url) return sendError(res, 404, 'NO_PREVIEW', 'No preview available.')
    res.set('Cache-Control', 'no-store')
    if (req.query.format === 'json') return res.json({ url })
    res.redirect(302, url)
  })
  router.get('/discover/moods', requireUser, (_req, res) => res.json({ items: discovery.moods() }))
  router.get('/discover/mood/:preset', requireUser, rateLimit(60, 60_000), async (req, res) => {
    res.json(await discovery.mood(req.playerUser, String(req.params.preset), { lang: req.query.lang }))
  })
  router.get('/online/album', requireUser, rateLimit(60, 60_000), async (req, res) => {
    res.json(await discovery.onlineAlbum(req.playerUser, { provider: req.query.provider, id: req.query.id, url: req.query.url, artist: req.query.artist }))
  })
  router.get('/online/playlist', requireUser, rateLimit(60, 60_000), async (req, res) => {
    const data = await discovery.onlinePlaylist(req.playerUser, { provider: req.query.provider, id: req.query.id, url: req.query.url, mix: req.query.mix })
    res.json({ ...data, follow: req.query.mix ? null : follows?.find(uid(req), { provider: req.query.provider, id: req.query.id, url: req.query.url }) || null })
  })

  // ---- notifications & new releases of followed artists ----------------------------
  router.get('/notifications', requireUser, (req, res) => res.json(releases.notifications(uid(req), { limit: req.query.limit })))
  router.post('/notifications/read', requireUser, (req, res) => res.json(releases.markRead(uid(req), Array.isArray(req.body?.ids) ? req.body.ids : null)))
  router.get('/releases/settings', requireUser, (req, res) => res.json(releases.settings(uid(req))))
  router.put('/releases/settings', requireUser, (req, res) => res.json(releases.updateSettings(uid(req), req.body || {})))
  router.post('/releases/check', requireUser, rateLimit(6, 60_000), async (req, res) => {
    if (!getConfig().discoveryEnabled) return sendError(res, 409, 'DISCOVERY_DISABLED', 'Online data is turned off.')
    res.json(await releases.checkUser(uid(req), { force: true }))
  })

  // ---- followed online playlists ---------------------------------------------------
  router.get('/follows/playlists', requireUser, (req, res) => res.json({ items: follows.list(uid(req)) }))
  router.post('/follows/playlists', requireUser, rateLimit(30, 60_000), async (req, res) => {
    if (!getConfig().discoveryEnabled) return sendError(res, 409, 'DISCOVERY_DISABLED', 'Online data is turned off.')
    res.status(201).json(await follows.follow(req.playerUser, req.body || {}))
  })
  router.delete('/follows/playlists/:id', requireUser, (req, res) => res.json(follows.unfollow(uid(req), intParam(req.params.id))))
  router.post('/follows/playlists/:id/sync', requireUser, rateLimit(20, 60_000), async (req, res) => {
    const own = follows.list(uid(req)).find((f) => f.id === intParam(req.params.id))
    if (!own) return sendError(res, 404, 'NOT_FOUND', 'Not followed.')
    res.json(await follows.sync(own.id))
  })
  // Mixes (YouTube Music / Deezer / Spotify artist radios) and playlists
  // (Apple Music, Spotify, YouTube Music) made around one artist.
  router.get('/online/artist-mixes', requireUser, rateLimit(60, 60_000), async (req, res) => {
    res.json(await discovery.artistMixes(req.playerUser, { name: req.query.name, lang: req.query.lang }))
  })
  // Artist biography (Wikipedia, language order from SPOTIFY_MARKET then
  // SPOTIFY_FALLBACK_MARKETS). Nothing is asked online while every online
  // provider is switched off.
  router.get('/online/artist-bio', requireUser, rateLimit(60, 60_000), async (req, res) => {
    if (!biography || !(getConfig().onlineProviders || []).length) return res.json({ bio: null })
    res.json({ bio: await biography.get({ name: req.query.name, deezerId: req.query.deezerId, lang: req.query.lang }) })
  })
  router.get('/online/artist', requireUser, rateLimit(60, 60_000), async (req, res) => {
    res.json(await discovery.onlineArtist(req.playerUser, { id: req.query.id, name: req.query.name }))
  })
  // All of an artist's songs online (to pick and download the missing ones).
  router.get('/online/artist/tracks', requireUser, rateLimit(20, 60_000), async (req, res) => {
    res.json(await discovery.onlineArtistTracks(req.playerUser, { id: req.query.id, name: req.query.name }))
  })

  router.post('/downloads', requireUser, rateLimit(120, 60_000), async (req, res) => {
    const body = req.body || {}
    const record = await bridge.request(req.playerUser, body.item || {}, { playlistId: body.playlistId, force: Boolean(body.force) })
    res.status(record.status === 'exists' ? 200 : 202).json(record)
  })
  router.get('/downloads', requireUser, (req, res) => {
    res.json({ items: bridge.list(req.playerUser, { all: bool(req.query.all), activeOnly: bool(req.query.active), limit: req.query.limit }) })
  })
  // Live updates (Server-Sent Events) for the user's own downloads.
  router.get('/downloads/events', requireUser, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.flushHeaders?.()
    const user = req.playerUser
    const send = (row) => {
      if (!row || (row.userId !== user.id && user.role !== 'admin')) return
      res.write(`event: download\ndata: ${JSON.stringify(row)}\n\n`)
    }
    const libraryRemoved = () => res.write('event: library-removed\ndata: {}\n\n')
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    bridge.events.on('update', send)
    scanner.events?.on('removed', libraryRemoved)
    res.write(`event: ready\ndata: {}\n\n`)
    req.on('close', () => {
      clearInterval(ping)
      bridge.events.off('update', send)
      scanner.events?.off('removed', libraryRemoved)
    })
  })
  router.get('/downloads/:id', requireUser, (req, res) => res.json(bridge.get(req.params.id, req.playerUser)))
  router.post('/downloads/:id/cancel', requireUser, async (req, res) => res.json(await bridge.cancel(req.params.id, req.playerUser)))
  router.post('/downloads/:id/retry', requireUser, (req, res) => res.json(bridge.retry(req.params.id, req.playerUser)))

  // ---- account & devices -------------------------------------------------------

  router.get('/me', requireUser, (req, res) => res.json({
    user: req.playerUser,
    permissions: {
      canDownload: bridge.canDownload(req.playerUser),
      libraries: libraries.list().filter((l) => l.enabled && access.canSeeLibrary(uid(req), l.id)).map((l) => ({ id: l.id, name: l.name, isDefault: l.isDefault }))
    },
    currentDeviceId: req.playerToken?.id,
    devices: auth.listTokens(uid(req))
  }))
  router.post('/me/password', requireUser, rateLimit(10, 60_000), (req, res) => {
    const { currentPassword, newPassword } = req.body || {}
    if (!auth.verifyCredentials(req.playerUser.username, currentPassword)) return sendError(res, 401, 'BAD_CREDENTIALS', 'Current password is wrong.')
    auth.updateUser(uid(req), { password: newPassword })
    // Changing the password signs out every device; keep this browser signed in.
    const issued = auth.issueToken(uid(req), { kind: 'session', name: webName(req.playerToken?.name), platform: 'web', ip: req.ip })
    setSessionCookie(req, res, issued.token)
    res.json({ ok: true })
  })
  // Addresses a phone can use to reach this server (pairing QR code).
  router.get('/connect', requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const info = await connectInfo(req)
    res.json({ serverName: info.serverName, remoteAccess: info.remoteAccess, addresses: info.addresses, warnings: info.warnings, requestNetwork: info.requestNetwork })
  })
  router.post('/me/pairing-code', requireUser, rateLimit(10, 60_000), (req, res) => res.json(auth.createPairingCode(uid(req))))
  router.get('/me/pairing-code/:code', requireUser, rateLimit(120, 60_000), (req, res) => {
    const status = auth.pairingStatus(req.params.code, uid(req))
    if (!status) return sendError(res, 404, 'NOT_FOUND', 'Pairing code not found.')
    res.set('Cache-Control', 'no-store')
    res.json(status)
  })
  router.delete('/me/devices/:tokenId', requireUser, (req, res) => res.json({ ok: auth.revokeToken(String(req.params.tokenId), { userId: uid(req) }) }))

  // ---- administration --------------------------------------------------------

  // ---- library health (admin) ---------------------------------------------------------
  router.get('/admin/health', requireAdmin, (_req, res) => res.json(health.status()))
  router.post('/admin/health/check', requireAdmin, (req, res) => res.json(health.start(uid(req))))
  router.post('/admin/health/batch', requireAdmin, (req, res) => res.status(202).json(health.startBatch(req.playerUser, req.body || {})))
  // Light status for clients following one batch (no report).
  router.get('/admin/health/batch', requireAdmin, (_req, res) => res.json({ batch: health.status().batch }))
  // "Refresh online": one song replaced by a version the admin picked.
  router.post('/admin/health/replace', requireAdmin, rateLimit(30, 60_000), (req, res) =>
    res.status(202).json(health.replaceWith(req.playerUser, intParam(req.body?.trackId), req.body?.source || {})))
  router.post('/admin/health/batch/:id/control', requireAdmin, (req, res) => res.json(health.controlBatch(req.params.id, req.body?.command)))
  router.post('/admin/health/trash', requireAdmin, async (req, res) => res.json(await health.trash(intParam(req.body?.trackId))))
  router.post('/admin/health/trash/empty', requireAdmin, async (_req, res) => res.json(await health.emptyTrash()))
  router.post('/admin/health/cover', requireAdmin, rateLimit(60, 60_000), async (req, res) => res.json(await health.fixCover(intParam(req.body?.albumId))))
  router.post('/admin/health/redownload', requireAdmin, rateLimit(60, 60_000), async (req, res) => res.json(await health.redownload(req.playerUser, intParam(req.body?.trackId))))

  router.get('/admin/config', requireAdmin, (_req, res) => res.json({ config: getConfig(), remoteAccess: getMode() }))
  router.patch('/admin/config', requireAdmin, (req, res) => res.json({ config: updateConfig(req.body || {}) }))

  router.get('/admin/libraries', requireAdmin, (_req, res) => res.json({ items: libraries.list(), scan: scanner.getStatus() }))
  router.post('/admin/libraries', requireAdmin, (req, res) => {
    const lib = libraries.add(req.body || {})
    scanner.requestScan(lib.id).catch(() => {})
    res.status(201).json(lib)
  })
  router.patch('/admin/libraries/:id', requireAdmin, (req, res) => {
    const lib = libraries.update(intParam(req.params.id), req.body || {})
    artwork.invalidate()
    if (lib.enabled) scanner.requestScan(lib.id).catch(() => {})
    res.json(lib)
  })
  // Player download folder (used while the Gharmonize download library is off).
  router.get('/admin/download-folder', requireAdmin, (_req, res) => res.json(libraries.downloadFolder()))
  router.put('/admin/download-folder', requireAdmin, (req, res) => {
    const info = libraries.setDownloadFolder(req.body?.path)
    artwork.invalidate()
    scanner.requestScan(info.libraryId).catch(() => {})
    res.json(info)
  })
  router.delete('/admin/download-folder', requireAdmin, (_req, res) => res.json(libraries.clearDownloadFolder()))
  router.delete('/admin/libraries/:id', requireAdmin, (req, res) => {
    libraries.remove(intParam(req.params.id))
    artwork.invalidate()
    scanner.events?.emit('removed')
    res.json({ ok: true })
  })
  router.post('/admin/scan', requireAdmin, (req, res) => {
    const id = intParam(req.body?.libraryId)
    scanner.requestScan(id || 'all').catch(() => {})
    res.status(202).json(scanner.getStatus())
  })
  router.get('/admin/scan', requireAdmin, (_req, res) => res.json(scanner.getStatus()))

  router.get('/admin/users', requireAdmin, (_req, res) => res.json({ items: auth.listUsers() }))
  router.get('/admin/users/:id', requireAdmin, (req, res) => {
    const user = auth.getUserDetails(intParam(req.params.id))
    if (!user) return sendError(res, 404, 'USER_NOT_FOUND', 'User not found.')
    res.json(user)
  })
  router.post('/admin/users', requireAdmin, (req, res) => res.status(201).json(auth.createUser(req.body || {})))
  router.patch('/admin/users/:id', requireAdmin, (req, res) => {
    const user = auth.updateUser(intParam(req.params.id), req.body || {})
    // Visibility changed: forget per-user "no artwork" answers.
    artwork.invalidate()
    ctx.mixes?.invalidate()
    res.json(user)
  })
  router.delete('/admin/users/:id', requireAdmin, (req, res) => {
    const id = intParam(req.params.id)
    if (id && id === req.playerUser?.id) return sendError(res, 409, 'CANNOT_DELETE_SELF', 'You cannot delete your own account.')
    auth.deleteUser(id)
    res.json({ ok: true })
  })
  router.get('/admin/users/:id/devices', requireAdmin, (req, res) => res.json({ items: auth.listTokens(intParam(req.params.id)) }))
  router.delete('/admin/devices/:tokenId', requireAdmin, (req, res) => res.json({ ok: auth.revokeToken(String(req.params.tokenId)) }))

  router.get('/admin/network', requireAdmin, async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json(await connectInfo(req, { fresh: bool(req.query.fresh) }))
  })

  router.post('/admin/tunnel/restart', requireAdmin, async (_req, res) => {
    res.json(await ctx.tunnel.restart())
  })

  router.get('/admin/cache', requireAdmin, async (_req, res) => res.json({ transcode: await stream.getCacheUsage(), limitMb: getConfig().transcodeCacheMb }))
  router.delete('/admin/cache', requireAdmin, async (_req, res) => { await stream.clearCache(); res.json({ ok: true }) })
  router.delete('/admin/online-cache', requireAdmin, (_req, res) => { onlineCache.clear(); res.json({ ok: true }) })

  router.use((_req, res) => sendError(res, 404, 'NOT_FOUND', 'Unknown Gharmonize Player endpoint.'))

  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    if (KNOWN_ERRORS.some((E) => err instanceof E)) return sendError(res, err.status || 400, err.code, err.message)
    if (err?.type === 'entity.parse.failed') return sendError(res, 400, 'INVALID_JSON', 'Invalid JSON body.')
    ctx.logger?.error?.('❌ [player] request failed:', err?.message || err)
    if (res.headersSent) return res.destroy()
    return sendError(res, 500, 'PLAYER_INTERNAL', 'Internal player error.')
  })

  return router
}

export { clampLimit, clampOffset }
