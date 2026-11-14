// Gharmonize Player gate.
//
// This is the ONLY player file that is loaded at startup. It reads a few plain
// environment values and nothing else. While the player is disabled (the
// default) no database is opened, no scanner/timer runs and every
// /api/player request is answered with a cheap 404. The real service is
// imported lazily the first time the player is enabled and is fully stopped
// again when it is disabled from settings.

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
export const REMOTE_ACCESS_MODES = Object.freeze(['off', 'tunnel', 'tailscale', 'any'])

export function isPlayerEnabled(env = process.env) {
  return TRUE_VALUES.has(String(env.GHARMONIZE_PLAYER_ENABLED ?? '').trim().toLowerCase())
}

export function normalizePlayerEnabled(value) {
  return TRUE_VALUES.has(String(value ?? '').trim().toLowerCase()) ? '1' : '0'
}

export function normalizeRemoteAccessMode(value) {
  const mode = String(value ?? '').trim().toLowerCase()
  return REMOTE_ACCESS_MODES.includes(mode) ? mode : 'off'
}

export function getRemoteAccessMode(env = process.env) {
  return normalizeRemoteAccessMode(env.GHARMONIZE_PLAYER_REMOTE_ACCESS)
}

// Optional player-only listener on all interfaces, so phones on the home
// network (and Tailscale) can reach the player even when Gharmonize itself
// only listens on 127.0.0.1 (desktop app). Only player routes are served.
export const DEFAULT_PLAYER_PORT = 5175

export function normalizePlayerListen(value) {
  return TRUE_VALUES.has(String(value ?? '').trim().toLowerCase()) ? '1' : '0'
}

export function normalizePlayerPort(value) {
  const n = Math.floor(Number(String(value ?? '').trim()))
  return String(Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_PLAYER_PORT)
}

export function getPlayerListenConfig(env = process.env) {
  return {
    enabled: normalizePlayerListen(env.GHARMONIZE_PLAYER_LISTEN) === '1',
    port: Number(normalizePlayerPort(env.GHARMONIZE_PLAYER_PORT)),
    host: String(env.GHARMONIZE_PLAYER_LISTEN_HOST || '0.0.0.0').trim() || '0.0.0.0'
  }
}

// Cloudflare Tunnel (remote access mode "tunnel"): "quick" needs no account
// (random trycloudflare.com address that changes on restart), "token" runs a
// tunnel created in the user's Cloudflare account (fixed hostname).
export const DEFAULT_TUNNEL_PORT = 5185

export function normalizeTunnelMode(value) {
  return String(value ?? '').trim().toLowerCase() === 'token' ? 'token' : 'quick'
}

export function normalizeTunnelToken(value) {
  const v = String(value ?? '').trim()
  return /^[A-Za-z0-9+/=_-]{20,4096}$/.test(v) ? v : ''
}

export function normalizeTunnelUrl(value) {
  const v = String(value ?? '').trim()
  if (!v) return ''
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`)
    if (u.protocol !== 'https:' || u.username || u.password) return ''
    return `https://${u.host}`
  } catch {
    return ''
  }
}

export function getTunnelConfig(env = process.env) {
  const port = Math.floor(Number(env.GHARMONIZE_PLAYER_TUNNEL_PORT))
  return {
    enabled: isPlayerEnabled(env) && getRemoteAccessMode(env) === 'tunnel',
    mode: normalizeTunnelMode(env.GHARMONIZE_PLAYER_TUNNEL_MODE),
    token: normalizeTunnelToken(env.GHARMONIZE_PLAYER_TUNNEL_TOKEN),
    publicUrl: normalizeTunnelUrl(env.GHARMONIZE_PLAYER_TUNNEL_URL),
    port: Number.isFinite(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_TUNNEL_PORT
  }
}

function sendDisabled(res) {
  res.set('Cache-Control', 'no-store')
  res.status(404).json({ error: { code: 'PLAYER_DISABLED', message: 'Gharmonize Player is disabled.' } })
}

export function createPlayerGate({ loadService = () => import('./service.js'), logger = console } = {}) {
  let service = null
  let starting = null
  let generation = 0

  async function ensureStarted() {
    if (service) return service
    if (!starting) {
      const myGeneration = generation
      starting = (async () => {
        const mod = await loadService()
        const instance = await mod.startPlayerService()
        if (myGeneration !== generation || !isPlayerEnabled()) {
          // Disabled while starting: do not leave anything running.
          await instance.stop().catch(() => {})
          return null
        }
        service = instance
        logger.log?.('🎧 Gharmonize Player started')
        return service
      })().finally(() => { starting = null })
    }
    return starting
  }

  async function stop() {
    generation += 1
    const current = service
    service = null
    if (current) {
      await current.stop().catch((error) => logger.warn?.('⚠️ Gharmonize Player stop failed:', error?.message || error))
      logger.log?.('🎧 Gharmonize Player stopped')
    }
  }

  async function sync() {
    if (isPlayerEnabled()) {
      try { await ensureStarted() } catch (error) {
        logger.error?.('❌ Gharmonize Player failed to start:', error?.message || error)
      }
    } else {
      await stop()
    }
  }

  async function middleware(req, res, next) {
    if (!isPlayerEnabled()) {
      if (req.path === '/status') {
        res.set('Cache-Control', 'no-store')
        return res.json({ enabled: false, name: 'Gharmonize Player' })
      }
      return sendDisabled(res)
    }
    try {
      const active = await ensureStarted()
      if (!active) return sendDisabled(res)
      return active.router(req, res, next)
    } catch (error) {
      logger.error?.('❌ Gharmonize Player unavailable:', error?.message || error)
      res.set('Cache-Control', 'no-store')
      return res.status(503).json({ error: { code: 'PLAYER_UNAVAILABLE', message: 'Gharmonize Player could not be started.' } })
    }
  }

  // Re-applies network settings (player listener) without restarting.
  async function refreshNetwork() {
    if (!service) return
    try { await service.applyNetworkSettings?.() } catch (error) {
      logger.warn?.('⚠️ Gharmonize Player network refresh failed:', error?.message || error)
    }
  }

  return { middleware, sync, stop, refreshNetwork, isRunning: () => Boolean(service), getService: () => service }
}
