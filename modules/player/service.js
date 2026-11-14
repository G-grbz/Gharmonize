import { openPlayerDatabase, getSetting, setSetting } from './db.js'
import { resolvePlayerDataDir, resolvePlayerCacheDir, resolveDefaultLibraryDir, ensurePrivateDir } from './paths.js'
import { createAuthStore } from './auth.js'
import { createLibraryStore } from './libraries.js'
import { createScanner } from './scanner.js'
import { createCatalog } from './catalog.js'
import { createArtworkService } from './artwork.js'
import { createStreamService } from './stream.js'
import { createLyricsService } from './lyrics.js'
import { createPlayerRouter } from './router.js'
import { createLibraryMatcher } from './matching.js'
import { createOnlineSearch } from './online.js'
import { createDownloadBridge } from './bridge.js'
import { createAccess } from './access.js'
import { createOnlineCache } from './onlineCache.js'
import { createAnnotator } from './annotate.js'
import { createDiscovery } from './discovery.js'
import { createDeezerSource, createYouTubeSource, createSpotifySource } from './discoverySources.js'
import { createCoreAdapter, DOWNLOAD_FORMATS } from './coreAdapter.js'
import { createPlayerListener } from './listener.js'
import { createTailscaleProbe } from './tailscale.js'
import { buildConnectInfo, normalizePublicUrl } from './connect.js'
import { getRemoteAccessMode, getPlayerListenConfig, getTunnelConfig } from './gate.js'
import { createTunnel } from './cloudflared.js'
import { createMixes } from './mixes.js'
import { createStats } from './stats.js'
import path from 'node:path'

const ONLINE_PROVIDERS = ['deezer', 'youtube', 'spotify']

export const DEFAULT_CONFIG = Object.freeze({
  serverName: 'Gharmonize Player',
  scanIntervalMinutes: 60,
  transcodeCacheMb: 2048,
  onlineLyrics: true,
  // Download bridge
  // Master switch; who may download is a per-user right (admins always).
  downloadsEnabled: true,
  downloadFormat: 'mp3',
  downloadBitrate: '320k',
  downloadLyrics: true,
  maxParallelDownloads: 2,
  maxQueuedPerUser: 50,
  onlineProviders: ['deezer', 'youtube', 'spotify'],
  // Online recommendation shelves
  discoveryEnabled: true,
  // Extra addresses (reverse proxy, tunnel, Tailscale on a Docker host…)
  // offered when pairing phones.
  publicUrls: []
})

export function normalizeConfig(input = {}, base = DEFAULT_CONFIG) {
  const out = { ...base }
  if (input.serverName !== undefined) out.serverName = String(input.serverName || '').trim().slice(0, 64) || DEFAULT_CONFIG.serverName
  if (input.scanIntervalMinutes !== undefined) {
    const n = Math.floor(Number(input.scanIntervalMinutes))
    // 0 = manual scans only; otherwise between 5 minutes and 7 days.
    out.scanIntervalMinutes = !Number.isFinite(n) || n <= 0 ? 0 : Math.min(Math.max(n, 5), 7 * 24 * 60)
  }
  if (input.transcodeCacheMb !== undefined) {
    const n = Math.floor(Number(input.transcodeCacheMb))
    out.transcodeCacheMb = Number.isFinite(n) ? Math.min(Math.max(n, 0), 512 * 1024) : base.transcodeCacheMb
  }
  if (input.onlineLyrics !== undefined) out.onlineLyrics = Boolean(input.onlineLyrics)
  if (input.downloadsEnabled !== undefined) out.downloadsEnabled = Boolean(input.downloadsEnabled)
  if (input.downloadFormat !== undefined) out.downloadFormat = DOWNLOAD_FORMATS[input.downloadFormat] ? input.downloadFormat : DEFAULT_CONFIG.downloadFormat
  if (input.downloadBitrate !== undefined || input.downloadFormat !== undefined) {
    const spec = DOWNLOAD_FORMATS[out.downloadFormat]
    const wanted = input.downloadBitrate !== undefined ? String(input.downloadBitrate) : out.downloadBitrate
    out.downloadBitrate = spec.bitrates.includes(wanted) ? wanted : spec.defaultBitrate
  }
  if (input.downloadLyrics !== undefined) out.downloadLyrics = Boolean(input.downloadLyrics)
  if (input.maxParallelDownloads !== undefined) {
    const n = Math.floor(Number(input.maxParallelDownloads))
    out.maxParallelDownloads = Number.isFinite(n) ? Math.min(Math.max(n, 1), 10) : base.maxParallelDownloads
  }
  if (input.maxQueuedPerUser !== undefined) {
    const n = Math.floor(Number(input.maxQueuedPerUser))
    out.maxQueuedPerUser = Number.isFinite(n) ? Math.min(Math.max(n, 1), 1000) : base.maxQueuedPerUser
  }
  if (input.discoveryEnabled !== undefined) out.discoveryEnabled = Boolean(input.discoveryEnabled)
  if (input.publicUrls !== undefined) {
    const list = Array.isArray(input.publicUrls) ? input.publicUrls : String(input.publicUrls || '').split(/[\s,]+/)
    out.publicUrls = [...new Set(list.map(normalizePublicUrl).filter(Boolean))].slice(0, 5)
  }
  if (input.onlineProviders !== undefined) {
    const list = Array.isArray(input.onlineProviders) ? input.onlineProviders : String(input.onlineProviders || '').split(',')
    out.onlineProviders = ONLINE_PROVIDERS.filter((p) => list.map((x) => String(x).trim().toLowerCase()).includes(p))
  }
  return out
}

export async function startPlayerService({ env = process.env, logger = console, dataDir = null, cacheDir = null, defaultLibraryDir = null, initialScanDelayMs = 5000, core = null, onlineOptions = {}, bridgePollMs = 2000, discoverySources = null, discoveryOptions = {}, listenerOptions = {}, tailscaleProbe = null, networkOptions = {}, routerOptions = {}, tunnelOptions = {} } = {}) {
  const resolvedDataDir = dataDir || resolvePlayerDataDir(env)
  const resolvedCacheDir = ensurePrivateDir(cacheDir || resolvePlayerCacheDir(env))
  const db = await openPlayerDatabase(resolvedDataDir)
  const timers = new Set()
  let stopped = false

  let config = normalizeConfig(getSetting(db, 'config', {}) || {})
  const getConfig = () => config
  const updateConfig = (patch) => {
    config = normalizeConfig(patch, config)
    setSetting(db, 'config', config)
    reschedule()
    return config
  }

  const libraries = createLibraryStore(db, { defaultLibraryDir: defaultLibraryDir || resolveDefaultLibraryDir(env) })
  libraries.ensureDefaultLibrary()
  const auth = createAuthStore(db)
  const access = createAccess(db)
  const catalog = createCatalog(db)
  const artwork = createArtworkService({ cacheDir: resolvedCacheDir, db, libraries, logger })
  const mixes = createMixes(db)
  const scanner = createScanner(db, { logger, onTrackChanges: () => { artwork.invalidate(); mixes.invalidate() } })
  const stream = createStreamService({ cacheDir: resolvedCacheDir, libraries, getCacheLimitBytes: () => config.transcodeCacheMb * 1024 * 1024, logger })
  const stats = createStats(db, { catalog })
  const lyrics = createLyricsService({ libraries, getOnlineAllowed: () => config.onlineLyrics, logger })
  const matcher = createLibraryMatcher(db)
  const online = createOnlineSearch({ getEnabledProviders: () => config.onlineProviders, logger, ...onlineOptions })
  const bridge = createDownloadBridge({ db, core: core || createCoreAdapter({ logger }), scanner, matcher, catalog, getConfig, logger, pollMs: bridgePollMs })
  const onlineCache = createOnlineCache(db, { logger })
  const annotator = createAnnotator({ matcher, bridge })
  const discovery = createDiscovery({
    db,
    cache: onlineCache,
    annotator,
    getConfig,
    logger,
    sources: discoverySources || { deezer: createDeezerSource(), youtube: createYouTubeSource(), spotify: createSpotifySource({ env }) },
    ...discoveryOptions
  })

  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn() }, ms)
    timer.unref?.()
    timers.add(timer)
    return timer
  }
  let scanTimer = null
  function reschedule() {
    if (scanTimer) { clearInterval(scanTimer); timers.delete(scanTimer); scanTimer = null }
    if (stopped || !config.scanIntervalMinutes) return
    scanTimer = setInterval(() => scanner.requestScan('all').catch(() => {}), config.scanIntervalMinutes * 60 * 1000)
    scanTimer.unref?.()
    timers.add(scanTimer)
  }

  const housekeeping = setInterval(() => {
    try { auth.purgeExpired() } catch {}
    try { bridge.purgeOld() } catch {}
    try { onlineCache.purge() } catch {}
    stream.cleanup().catch(() => {})
  }, 60 * 60 * 1000)
  housekeeping.unref?.()
  timers.add(housekeeping)

  // Other Gharmonize parts (e.g. the download pipeline) can announce new
  // files; scans are debounced so a burst of downloads triggers one scan.
  let changeDebounce = null
  const onLibraryChanged = () => {
    if (stopped) return
    if (changeDebounce) { clearTimeout(changeDebounce); timers.delete(changeDebounce) }
    changeDebounce = later(() => { changeDebounce = null; scanner.requestScan('all').catch(() => {}) }, 15_000)
  }
  process.on('gharmonize:library-changed', onLibraryChanged)

  reschedule()
  bridge.start()
  if (initialScanDelayMs >= 0) later(() => scanner.requestScan('all').catch(() => {}), initialScanDelayMs)

  // ---- network: player-only listener + connection info for pairing ------
  const tailscale = tailscaleProbe || createTailscaleProbe()
  let router = null
  const listener = createPlayerListener({ handle: (req, res, next) => router(req, res, next), logger, getConfig: () => getPlayerListenConfig(env), ...listenerOptions })
  // Cloudflare Tunnel: cloudflared only reaches this 127.0.0.1 listener, whose
  // requests are marked "tunnel" for the network gate.
  const tunnelListener = createPlayerListener({
    handle: (req, res, next) => router(req, res, next),
    logger,
    via: 'tunnel',
    label: 'Cloudflare Tunnel origin',
    getConfig: () => { const t = getTunnelConfig(env); return { enabled: t.enabled, port: t.port, host: '127.0.0.1' } },
    ...(tunnelOptions.listener || {})
  })
  const tunnel = tunnelOptions.tunnel || createTunnel({
    getConfig: () => { const t = getTunnelConfig(env); return { ...t, port: tunnelListener.status().port } },
    binDir: path.join(resolvedDataDir, 'bin'),
    logger,
    env
  })
  async function applyNetworkSettings() {
    await listener.apply()
    await tunnelListener.apply()
    await tunnel.apply()
  }
  const mainAddress = () => ({
    host: String(env.GHARMONIZE_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: Number(env.PORT || 5174)
  })
  async function connectInfo(req, { fresh = false } = {}) {
    const main = mainAddress()
    const status = listener.status()
    const ports = [main.port, status.listening ? status.port : null].filter(Boolean)
    const ts = await tailscale.get(ports, { fresh })
    return buildConnectInfo({ req, main, listener: status, tailscale: ts, tunnel: tunnel.status(), remoteAccess: getRemoteAccessMode(env), publicUrls: config.publicUrls, docker: Boolean(ts.docker), serverName: config.serverName, ...networkOptions })
  }

  const context = { db, auth, access, libraries, catalog, scanner, artwork, stream, lyrics, matcher, online, bridge, onlineCache, annotator, discovery, getConfig, updateConfig, logger, connectInfo, listener, tunnel, tunnelOrigin: tunnelListener, mixes, stats }
  router = createPlayerRouter(context, routerOptions)
  // Do not block start-up on a cloudflared download.
  await listener.apply()
  await tunnelListener.apply()
  tunnel.apply().catch((error) => logger.warn?.('⚠️ [player] tunnel start failed:', error?.message || error))

  async function stop() {
    if (stopped) return
    stopped = true
    process.off('gharmonize:library-changed', onLibraryChanged)
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer) }
    timers.clear()
    await tunnel.stop()
    await tunnelListener.stop()
    await listener.stop()
    await bridge.stop()
    onlineCache.close()
    await scanner.stop()
    await stream.stop()
    try { db.close() } catch {}
  }

  return { router, stop, context, applyNetworkSettings, dataDir: resolvedDataDir, cacheDir: resolvedCacheDir }
}
