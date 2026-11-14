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

const KNOWN_ERRORS = [PlayerAuthError, LibraryError, CatalogError, BridgeError, OnlineError, DiscoveryError]

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
  const { auth, access, libraries, catalog, scanner, artwork, stream, lyrics, online, bridge, annotator, discovery, onlineCache, getConfig, updateConfig, connectInfo } = ctx
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

  router.get('/artwork/:kind/:id', requireUser, async (req, res) => {
    const id = intParam(req.params.id)
    if (!id) return sendError(res, 404, 'NOT_FOUND', 'Artwork not found.')
    const art = await artwork.getArtwork(String(req.params.kind), id, req.query.size, uid(req))
    if (!art) {
      res.set('Cache-Control', 'private, max-age=600')
      return sendError(res, 404, 'NO_ARTWORK', 'No artwork available.')
    }
    res.set('Cache-Control', 'private, max-age=604800')
    res.type(art.contentType)
    res.sendFile(art.file, { dotfiles: 'allow', lastModified: true, cacheControl: false }, (err) => {
      if (err && !res.headersSent) sendError(res, 404, 'NO_ARTWORK', 'No artwork available.')
    })
  })

  // ---- catalog ---------------------------------------------------------------

  router.get('/home', requireUser, (req, res) => res.json(catalog.home(uid(req))))
  router.get('/stats', requireUser, (req, res) => res.json(catalog.getStats(uid(req))))
  router.get('/search', requireUser, (req, res) => res.json(catalog.search(req.query.q, { limit: req.query.limit, userId: uid(req) })))
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
    if (!found) return sendError(res, 404, 'NO_LYRICS', 'No lyrics found.')
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

  router.get('/artists', requireUser, (req, res) => {
    res.json({ items: catalog.listArtists({ sort: req.query.sort, limit: req.query.limit, offset: req.query.offset, favorites: bool(req.query.favorites), userId: uid(req) }) })
  })
  router.get('/artists/:id', requireUser, (req, res) => {
    const artist = catalog.getArtist(intParam(req.params.id), uid(req))
    if (!artist) return sendError(res, 404, 'NOT_FOUND', 'Artist not found.')
    res.json(artist)
  })

  // ---- mixes & listening statistics ---------------------------------------------

  router.get('/mixes', requireUser, (req, res) => res.json({ items: ctx.mixes.list(uid(req)) }))
  router.get('/mixes/:id', requireUser, (req, res) => {
    const mix = ctx.mixes.get(uid(req), String(req.params.id))
    if (!mix) return sendError(res, 404, 'NOT_FOUND', 'Mix not found.')
    const { trackIds, ...rest } = mix
    res.json({ ...rest, tracks: catalog.getTracksByIds(trackIds, uid(req)) })
  })
  router.get('/mixes/:id/online', requireUser, async (req, res) => {
    const mix = ctx.mixes.get(uid(req), String(req.params.id))
    if (!mix) return sendError(res, 404, 'NOT_FOUND', 'Mix not found.')
    res.json(await discovery.mixSuggestions(req.playerUser, { mixId: mix.id, artists: mix.artists || [] }))
  })
  router.get('/stats/listening', requireUser, (req, res) => res.json(ctx.stats.listening(uid(req), { range: String(req.query.range || 'month') })))
  router.get('/stats/years', requireUser, (req, res) => res.json({ items: ctx.stats.years(uid(req)) }))
  router.get('/stats/wrapped', requireUser, (req, res) => res.json(ctx.stats.wrapped(uid(req), req.query.year)))

  // ---- personal --------------------------------------------------------------

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
  router.get('/playlists/:id', requireUser, (req, res) => res.json(catalog.getPlaylist(intParam(req.params.id), uid(req))))
  router.patch('/playlists/:id', requireUser, (req, res) => res.json(catalog.updatePlaylist(intParam(req.params.id), uid(req), req.body || {})))
  router.delete('/playlists/:id', requireUser, (req, res) => { catalog.deletePlaylist(intParam(req.params.id), uid(req)); res.json({ ok: true }) })
  router.post('/playlists/:id/tracks', requireUser, (req, res) => res.json(catalog.addPlaylistTracks(intParam(req.params.id), uid(req), req.body?.trackIds || [])))
  router.delete('/playlists/:id/tracks/:entryId', requireUser, (req, res) => res.json(catalog.removePlaylistEntry(intParam(req.params.id), uid(req), intParam(req.params.entryId))))
  router.post('/playlists/:id/move', requireUser, (req, res) => res.json(catalog.movePlaylistEntry(intParam(req.params.id), uid(req), intParam(req.body?.entryId), req.body?.toIndex)))

  // ---- online search & download bridge -------------------------------------

  // Badges each online result with "already in your library" and
  // "downloading now" so the client can show play / download / progress.
  function annotateOnline(result, userId) {
    return { ...result, tracks: annotator.items(result.tracks, userId), albums: annotator.items(result.albums, userId), artists: annotator.items(result.artists, userId) }
  }

  router.get('/online/providers', requireUser, (req, res) => {
    res.json({ providers: online.status(), canDownload: bridge.canDownload(req.playerUser) })
  })

  router.get('/online/search', requireUser, rateLimit(60, 60_000), async (req, res) => {
    const kinds = String(req.query.kinds || 'track,album,artist').split(',').map((k) => k.trim()).filter((k) => ['track', 'album', 'artist'].includes(k))
    const only = req.query.providers ? String(req.query.providers).split(',').map((p) => p.trim()) : null
    const result = await online.search(req.query.q, { kinds: kinds.length ? kinds : ['track'], limit: req.query.limit, only })
    res.json(annotateOnline(result, uid(req)))
  })

  // ---- online recommendations (shelves) & online detail pages --------------

  router.get('/discover', requireUser, rateLimit(60, 60_000), async (req, res) => {
    const scope = ['personal', 'global'].includes(req.query.scope) ? req.query.scope : 'all'
    res.json(await discovery.discover(req.playerUser, { lang: req.query.lang, scope }))
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
    res.json(await discovery.onlinePlaylist(req.playerUser, { provider: req.query.provider, id: req.query.id, url: req.query.url }))
  })
  router.get('/online/artist', requireUser, rateLimit(60, 60_000), async (req, res) => {
    res.json(await discovery.onlineArtist(req.playerUser, { id: req.query.id, name: req.query.name }))
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
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    bridge.events.on('update', send)
    res.write(`event: ready\ndata: {}\n\n`)
    req.on('close', () => { clearInterval(ping); bridge.events.off('update', send) })
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
  router.delete('/admin/libraries/:id', requireAdmin, (req, res) => { libraries.remove(intParam(req.params.id)); artwork.invalidate(); res.json({ ok: true }) })
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
