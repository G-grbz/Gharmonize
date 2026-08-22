import express from 'express'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { initializeDynamicBinaries } from './binaries.js'
import { getBinariesInfo, clearBinariesInfoCache } from './binariesInfo.js'
import {
  decryptSecret,
  deriveSessionSecret,
  encryptSecret,
  hashPassword,
  parseCookieHeader,
  passwordPolicyError,
  verifyPassword
} from './security.js'

const router = express.Router()
const ENV_PATH =
  process.env.ENV_USER_PATH
  || process.env.ENV_PATH
  || path.join(process.env.DATA_DIR || process.cwd(), '.env')
const SESSION_COOKIE = 'gharmonize_admin_session'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const SENSITIVE_KEYS = new Set(['SPOTIFY_CLIENT_SECRET', 'HOMEPAGE_WIDGET_KEY'])
let sessionGeneration = 1
const loginAttempts = new Map()

const ALLOWED_KEYS = [
  'SPOTIFY_CLIENT_ID','SPOTIFY_CLIENT_SECRET','SPOTIFY_MARKET','SPOTIFY_FALLBACK_MARKETS',
  'YT_USE_MUSIC','PREFER_SPOTIFY_TAGS','TITLE_CLEAN_PIPE','YTDLP_UA','YTDLP_COOKIES',
  'YTDLP_COOKIES_FROM_BROWSER','YTDLP_EXTRA','YT_STRIP_COOKIES','YT_DEFAULT_REGION','YT_LANG',
  'YT_ACCEPT_LANGUAGE','YT_FORCE_IPV4','YT_403_WORKAROUNDS','ENRICH_SPOTIFY_FOR_YT','MEDIA_COMMENT',
  'YTDLP_BIN','FFMPEG_BIN','GHARMONIZE_FFMPEG_CHANNEL','TRUST_PROXY','TRUSTED_PROXY_CIDRS',
  'UPLOAD_MAX_BYTES','TRACK_EXTRACTOR_SHELL_INTEGRATION','FRONTEND_UI','YOUTUBE_QUICK_ADD_LIMIT',
  'YTLIVE_MUSIC_TITLE','YTLIVE_MUSIC_SUBTITLE','SPOTIFY_DEBUG_MARKET','CLEAN_SUFFIXES','CLEAN_PHRASES',
  'CLEAN_PARENS','PREVIEW_MAX_ENTRIES','AUTOMIX_ALL_TIMEOUT_MS','AUTOMIX_PAGE_TIMEOUT_MS',
  'PLAYLIST_ALL_TIMEOUT_MS','PLAYLIST_PAGE_TIMEOUT_MS','PLAYLIST_META_TIMEOUT_MS',
  'PLAYLIST_META_FALLBACK_TIMEOUT_MS','YT_UI_FORCE_COOKIES','YT_SEARCH_RESULTS','YT_SEARCH_TIMEOUT_MS',
  'YT_SEARCH_STAGGER_MS','HOMEPAGE_WIDGET_KEY'
]

function parseEnvRaw() {
  const m = new Map()
  if (!fs.existsSync(ENV_PATH)) return m
  const txt = fs.readFileSync(ENV_PATH, 'utf8')
  for (const line of txt.split(/\r?\n/)) {
    const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!mm) continue
    let val = mm[2]
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    m.set(mm[1], val)
  }
  return m
}

function decodeEnvValue(key, value) {
  if (!SENSITIVE_KEYS.has(key)) return String(value ?? '')
  try { return decryptSecret(value, key) } catch (error) {
    console.error(`[security] Could not decrypt ${key}:`, error.message)
    return ''
  }
}

function parseEnv() {
  const raw = parseEnvRaw()
  const out = new Map()
  for (const [key, value] of raw.entries()) out.set(key, decodeEnvValue(key, value))
  return out
}

function serializeEnvValue(key, value) {
  const raw = String(value ?? '')
  return SENSITIVE_KEYS.has(key) && raw ? encryptSecret(raw, key) : raw
}

function writeEnv(updates, extraAllowed = []) {
  const rawMap = parseEnvRaw()
  for (const [k, v] of Object.entries(updates)) {
    if (!(ALLOWED_KEYS.includes(k) || extraAllowed.includes(k))) continue
    if (v === null || typeof v === 'undefined') continue
    rawMap.set(k, serializeEnvValue(k, v))
  }

  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : []
  const seen = new Set()
  const out = existing.map(line => {
    const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!mm) return line
    const key = mm[1]
    if (rawMap.has(key)) {
      seen.add(key)
      const val = rawMap.get(key)
      const needsQuote = /[\s#"'`]/.test(val)
      return `${key}=${needsQuote ? JSON.stringify(val) : val}`
    }
    return line
  })
  for (const [k, v] of rawMap.entries()) {
    if (!seen.has(k)) {
      const needsQuote = /[\s#"'`]/.test(v)
      out.push(`${k}=${needsQuote ? JSON.stringify(v) : v}`)
    }
  }
  const clean = out.filter((line, idx, arr) => idx === 0 || line.trim() !== '' || arr[idx - 1].trim() !== '')
  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true, mode: 0o700 })
  fs.writeFileSync(ENV_PATH, clean.join('\n').trim() + '\n', { encoding: 'utf8', mode: 0o600 })
  try { fs.chmodSync(ENV_PATH, 0o600) } catch {}
}

function getEnv(key) {
  const direct = (process.env[key] ?? '').toString().trim()
  if (direct && !direct.startsWith('enc:v1:')) return direct
  const m = parseEnv()
  return (m.get(key) ?? '').toString().trim()
}

function migrateSecurityState() {
  const raw = parseEnvRaw()
  let changed = false
  const updates = {}

  for (const key of SENSITIVE_KEYS) {
    const value = raw.get(key) || ''
    if (value && !value.startsWith('enc:v1:')) {
      updates[key] = value
      process.env[key] = value
      changed = true
    } else if (value) {
      process.env[key] = decodeEnvValue(key, value)
    }
  }

  const plaintext = String(raw.get('ADMIN_PASSWORD') || process.env.ADMIN_PASSWORD || '').trim()
  let passwordHash = String(raw.get('ADMIN_PASSWORD_HASH') || process.env.ADMIN_PASSWORD_HASH || '').trim()
  if (!passwordHash && plaintext) {
    try {
      passwordHash = hashPassword(plaintext, { enforcePolicy: false })
      updates.ADMIN_PASSWORD_HASH = passwordHash
      updates.ADMIN_PASSWORD = ''
      changed = true
      console.log('🔐 Migrated legacy plaintext admin password to scrypt.')
    } catch (error) {
      console.warn('⚠️ Existing ADMIN_PASSWORD does not meet the new password policy; change it as soon as possible.')
    }
  }

  if (!passwordHash && !plaintext) {
    const initialPassword = `Gh7-${crypto.randomBytes(18).toString('base64url')}`
    passwordHash = hashPassword(initialPassword)
    updates.ADMIN_PASSWORD_HASH = passwordHash
    updates.ADMIN_PASSWORD = ''
    changed = true
    const credentialFile = path.resolve(process.env.GHARMONIZE_INITIAL_ADMIN_PASSWORD_FILE || path.join(process.env.DATA_DIR || process.cwd(), 'INITIAL_ADMIN_PASSWORD.txt'))
    try {
      fs.writeFileSync(credentialFile, `${initialPassword}\n`, { mode: 0o600, flag: 'wx' })
      console.warn(`🔐 Initial admin password generated. Read it once from: ${credentialFile}`)
    } catch {
      console.warn(`🔐 Initial admin password generated for this run: ${initialPassword}`)
    }
  }

  if (changed) writeEnv(updates, ['ADMIN_PASSWORD', 'ADMIN_PASSWORD_HASH'])
  if (passwordHash) process.env.ADMIN_PASSWORD_HASH = passwordHash
  process.env.ADMIN_PASSWORD = ''
}

migrateSecurityState()

function getAdminPasswordHash() {
  return getEnv('ADMIN_PASSWORD_HASH')
}

function setAdminPasswordSync(newPass) {
  const hash = hashPassword(newPass)
  writeEnv({ ADMIN_PASSWORD_HASH: hash, ADMIN_PASSWORD: '' }, ['ADMIN_PASSWORD_HASH', 'ADMIN_PASSWORD'])
  process.env.ADMIN_PASSWORD_HASH = hash
  process.env.ADMIN_PASSWORD = ''
  sessionGeneration += 1
}

function sign(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url')
  const mac = crypto.createHmac('sha256', deriveSessionSecret()).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null
  const [payload, mac] = token.split('.')
  const expected = crypto.createHmac('sha256', deriveSessionSecret()).update(payload).digest('base64url')
  const macBuf = Buffer.from(mac || '', 'utf8')
  const expBuf = Buffer.from(expected, 'utf8')
  if (macBuf.length !== expBuf.length || !crypto.timingSafeEqual(macBuf, expBuf)) return null
  let obj = null
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch {}
  if (!obj || obj.role !== 'admin' || obj.sg !== sessionGeneration) return null
  if (Date.now() > (obj.iat || 0) + SESSION_TTL_MS) return null
  return obj
}

function getTokenFromReq(req) {
  const h = req.get('authorization') || ''
  if (h.startsWith('Bearer ')) {
    const value = h.slice(7)
    if (value.includes('.')) return value
  }
  if (req.query?.token) {
    const value = String(req.query.token)
    if (value.includes('.')) return value
  }
  return parseCookieHeader(req.get('cookie') || '')[SESSION_COOKIE] || null
}

function setSessionCookie(req, res, token) {
  const secure = Boolean(req.secure)
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: SESSION_TTL_MS
  })
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' })
}

function authMiddleware(req, res, next) {
  const ok = verify(getTokenFromReq(req))
  if (!ok) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
  req.adminAuth = ok
  next()
}

export function requireAuth(req, res, next) { return authMiddleware(req, res, next) }

function clientKey(req) { return String(req.ip || req.socket?.remoteAddress || 'unknown') }
function isRateLimited(req) {
  const key = clientKey(req)
  const now = Date.now()
  const windowMs = 10 * 60_000
  const max = 8
  const row = loginAttempts.get(key) || { start: now, count: 0 }
  if (now - row.start > windowMs) { row.start = now; row.count = 0 }
  row.count += 1
  loginAttempts.set(key, row)
  for (const [k, v] of loginAttempts) if (now - v.start > windowMs * 2) loginAttempts.delete(k)
  return row.count > max
}
function clearRateLimit(req) { loginAttempts.delete(clientKey(req)) }

router.post('/auth/login', express.json(), (req, res) => {
  if (isRateLimited(req)) return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' } })
  const { password } = req.body || {}
  const currentHash = getAdminPasswordHash()
  if (!currentHash) return res.status(500).json({ error: { code: 'NO_ADMIN_PASSWORD', message: 'ADMIN_PASSWORD_HASH is not set' } })
  if (!password || !verifyPassword(password, currentHash)) return res.status(401).json({ error: { code: 'BAD_PASSWORD', message: 'Invalid password' } })
  clearRateLimit(req)
  const token = sign({ iat: Date.now(), role: 'admin', sg: sessionGeneration })
  setSessionCookie(req, res, token)
  res.json({ token: 'cookie', expiresInMs: SESSION_TTL_MS })
})

router.post('/auth/logout', (_req, res) => { clearSessionCookie(res); res.json({ ok: true }) })

router.get('/ui-config', (_req, res) => {
  const frontendUi = getEnv('FRONTEND_UI') === 'ytlive' ? 'ytlive' : 'classic'
  const quickAddRaw = Number(getEnv('YOUTUBE_QUICK_ADD_LIMIT') || 25)
  const quickAddLimit = Number.isFinite(quickAddRaw) && quickAddRaw > 0 ? Math.min(100, Math.max(1, Math.round(quickAddRaw))) : 25
  res.json({ frontendUi, quickAddLimit, musicTitle: getEnv('YTLIVE_MUSIC_TITLE') || 'Gharmonize Music', musicSubtitle: getEnv('YTLIVE_MUSIC_SUBTITLE') })
})

router.get('/auth/verify', authMiddleware, (_req, res) => res.json({ valid: true, message: 'Session is valid' }))

router.get('/settings', authMiddleware, (_req, res) => {
  const env = parseEnv(); const data = {}
  for (const k of ALLOWED_KEYS) {
    let val = env.get(k) ?? getEnv(k) ?? ''
    if (SENSITIVE_KEYS.has(k) && val) val = '••••••••'
    if (k === 'GHARMONIZE_FFMPEG_CHANNEL') val = getEnv(k) === 'master' ? 'master' : 'stable'
    if (k === 'TRUST_PROXY') val = ['1','true','yes','on'].includes(String(getEnv(k)).toLowerCase()) ? '1' : '0'
    data[k] = val
  }
  res.json({ settings: data })
})

router.post('/settings', authMiddleware, express.json(), (req, res) => {
  const incoming = (req.body && req.body.settings) || {}; const env = parseEnv(); const updates = {}
  for (const k of ALLOWED_KEYS) {
    if (!(k in incoming)) continue
    const v = incoming[k]
    if (SENSITIVE_KEYS.has(k)) { updates[k] = (!v || v === '••••••••') ? (env.get(k) || '') : String(v); continue }
    if (k === 'GHARMONIZE_FFMPEG_CHANNEL') { updates[k] = String(v || '').trim().toLowerCase() === 'master' ? 'master' : 'stable'; continue }
    if (k === 'TRUST_PROXY') { updates[k] = ['1','true','yes','on'].includes(String(v ?? '').trim().toLowerCase()) ? '1' : '0'; continue }
    if (typeof v !== 'undefined' && v !== null) updates[k] = String(v)
  }
  writeEnv(updates)
  for (const [k, v] of Object.entries(updates)) process.env[k] = v
  process.emit('gharmonize:settings-updated', { updates })
  res.json({ ok: true, appliedInMemory: true })
})

router.post('/auth/change-password', authMiddleware, express.json(), (req, res) => {
  const { oldPassword, newPassword, newPassword2 } = req.body || {}
  const fail = (code, message) => res.status(400).json({ error: { code, message } })
  if (!oldPassword || !newPassword || !newPassword2) return fail('FIELDS_REQUIRED', 'All fields are required.')
  if (newPassword !== newPassword2) return fail('PASSWORD_MISMATCH', 'New passwords do not match.')
  const policyError = passwordPolicyError(newPassword)
  if (policyError) return fail('PASSWORD_POLICY', policyError)
  if (!verifyPassword(oldPassword, getAdminPasswordHash())) return res.status(401).json({ error: { code: 'BAD_PASSWORD', message: 'Old password is incorrect.' } })
  try { setAdminPasswordSync(newPassword); clearSessionCookie(res); return res.json({ ok: true, logout: true }) }
  catch (e) { return res.status(500).json({ error: { code: 'PASSWORD_SAVE_FAILED', message: e.message || 'Could not save password.' } }) }
})

function generateHomepageWidgetKey() { return `hwk_${crypto.randomBytes(32).toString('base64url')}` }
router.post('/settings/homepage-widget-key', authMiddleware, express.json(), (req, res) => {
  const { rotate = true, reveal = false } = req.body || {}; const env = parseEnv(); const existing = (env.get('HOMEPAGE_WIDGET_KEY') || '').trim()
  if (!rotate && existing) return res.json({ ok: true, rotated: false, key: reveal ? existing : undefined })
  const next = generateHomepageWidgetKey(); writeEnv({ HOMEPAGE_WIDGET_KEY: next }, ['HOMEPAGE_WIDGET_KEY']); process.env.HOMEPAGE_WIDGET_KEY = next
  res.json({ ok: true, rotated: true, key: reveal ? next : undefined })
})

router.post('/settings/refresh-binaries', authMiddleware, async (_req, res) => {
  try {
    const refresh = await initializeDynamicBinaries({ force: true }); clearBinariesInfoCache(); const binaries = await getBinariesInfo({ force: true })
    return res.json({ ok: true, refresh, binaries })
  } catch (err) {
    return res.status(500).json({ error: { code: 'BINARY_REFRESH_FAILED', message: err.message || 'Could not refresh binaries.' } })
  }
})

export default router
