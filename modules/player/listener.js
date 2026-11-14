// Player-only HTTP listener (optional, GHARMONIZE_PLAYER_LISTEN=1).
//
// The desktop app binds Gharmonize to 127.0.0.1, so phones cannot reach it.
// Instead of exposing the whole downloader to the network, this listener on
// all interfaces serves ONLY the player page, its assets and /api/player.
// The player's own network gate still applies (home network always, external
// clients only with the "allow external connections" consent).

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { getPlayerListenConfig } from './gate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '../../public')

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self'",
  "worker-src 'self' blob:"
].join('; ')

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', CSP)
  next()
}

// Same-origin rule for state-changing browser requests (apps use Bearer).
function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (String(req.get('authorization') || '').startsWith('Bearer ')) return next()
  const origin = String(req.get('origin') || '').trim()
  if (!origin) return next()
  try {
    if (new URL(origin).host.toLowerCase() === String(req.get('host') || '').toLowerCase()) return next()
  } catch {}
  return res.status(403).json({ error: { code: 'CROSS_SITE_REQUEST_BLOCKED', message: 'Invalid request origin' } })
}

export function createPlayerApp({ handle, publicDir = DEFAULT_PUBLIC_DIR, via = null }) {
  const app = express()
  app.disable('x-powered-by')
  // Marks every request from this listener (e.g. 'tunnel') for the network gate.
  if (via) app.use((req, _res, next) => { req.playerVia = via; next() })
  // Trust X-Forwarded-For only from a reverse proxy on this machine.
  app.set('trust proxy', 'loopback')
  app.use(securityHeaders)
  app.use('/api/player', express.json({ limit: '1mb' }), originCheck, (req, res, next) => handle(req, res, next))
  app.get('/', (_req, res) => res.redirect(302, '/player/'))
  const staticOpts = { index: false, dotfiles: 'ignore', fallthrough: true, maxAge: '1h' }
  app.use('/player', express.static(path.join(publicDir, 'player'), { ...staticOpts, index: 'index.html', redirect: true, maxAge: 0 }))
  app.use('/lang', express.static(path.join(publicDir, 'lang'), staticOpts))
  const file = (route, rel) => app.get(route, (_req, res, next) => res.sendFile(rel, { root: publicDir }, (err) => err && next()))
  file('/i18n.js', 'i18n.js')
  file('/src/logo.png', 'src/logo.png')
  file('/src/favicon.ico', 'src/favicon.ico')
  file('/favicon.ico', 'src/favicon.ico')
  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'))
  return app
}

// Starts / stops / re-binds the listener to follow the settings.
export function createPlayerListener({ handle, publicDir = DEFAULT_PUBLIC_DIR, logger = console, getConfig = () => getPlayerListenConfig(), via = null, label = 'player only' }) {
  let server = null
  let bound = null
  let lastError = null
  let queue = Promise.resolve()

  function close() {
    const current = server
    server = null
    bound = null
    if (!current) return Promise.resolve()
    return new Promise((resolve) => {
      current.close(() => resolve())
      // SSE and keep-alive connections would keep close() waiting.
      current.closeAllConnections?.()
    })
  }

  function open(cfg) {
    return new Promise((resolve) => {
      const app = createPlayerApp({ handle, publicDir, via })
      const srv = http.createServer(app)
      srv.keepAliveTimeout = 65_000
      srv.once('error', (error) => {
        lastError = { code: error.code || 'LISTEN_FAILED', message: error.message }
        logger.error?.(`❌ [player] listener ${cfg.host}:${cfg.port} failed: ${error.message}`)
        srv.close(() => {})
        resolve()
      })
      srv.listen(cfg.port, cfg.host, () => {
        server = srv
        bound = { host: cfg.host, port: srv.address().port }
        lastError = null
        logger.log?.(`🎧 Gharmonize Player listening on http://${cfg.host}:${bound.port} (${label})`)
        resolve()
      })
    })
  }

  function apply() {
    queue = queue.then(async () => {
      const cfg = getConfig()
      if (!cfg.enabled) { lastError = null; await close(); return }
      if (bound && bound.host === cfg.host && (bound.port === cfg.port || cfg.port === 0)) return
      await close()
      await open(cfg)
    }).catch((error) => { lastError = { code: 'LISTEN_FAILED', message: error?.message || String(error) } })
    return queue
  }

  function stop() {
    queue = queue.then(() => close())
    return queue
  }

  function status() {
    const cfg = getConfig()
    return { enabled: cfg.enabled, host: cfg.host, port: bound?.port || cfg.port, listening: Boolean(bound), error: cfg.enabled ? lastError : null }
  }

  return { apply, stop, status }
}
