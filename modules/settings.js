import express from 'express'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { initializeDynamicBinaries } from './binaries.js'
import { rateLimit } from './rateLimit.js'
import { normalizeTrustedExecutableSetting } from './safeProcess.js'
import { getBinariesInfo, clearBinariesInfoCache } from './binariesInfo.js'
import { writeEnvFileSync } from './envFile.js'
import {
  decryptSecret,
  deriveSessionSecret,
  encryptSecret,
  hashPassword,
  normalizeDeezerArl,
  parseSafeYtDlpExtra,
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
const TEMP_ACCESS_COOKIE = 'gharmonize_temp_access'
const ACCESS_REQUEST_CLIENT_COOKIE = 'gharmonize_access_client'
const ACCESS_REVISION_KEY = 'GHARMONIZE_ACCESS_REVISION'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const ACCESS_REQUEST_RESULT_TTL_MS = 5 * 60 * 1000
const ACCESS_REJECTION_COOLDOWN_MS = 15 * 60 * 1000
const ACCESS_REJECTION_IP_COOLDOWN_MS = 15 * 60 * 1000
const ACCESS_REQUEST_CLIENT_TTL_MS = 180 * 24 * 60 * 60 * 1000
const MAX_ACCESS_REQUESTS = 200
const ACTIVE_ACCESS_GRANTS_PATH = path.join(process.env.DATA_DIR || process.cwd(), 'temporary-access-grants.json')
const MAX_TEMP_ACCESS_MS = 5 * 365 * 24 * 60 * 60 * 1000
const SENSITIVE_KEYS = new Set(['SPOTIFY_CLIENT_SECRET', 'DEEZER_ARL', 'HOMEPAGE_WIDGET_KEY'])
const EXECUTABLE_SETTING_KEYS = new Set(['YTDLP_BIN', 'FFMPEG_BIN'])
let sessionGeneration = 1
const loginAttempts = new Map()
const accessRequests = new Map()
const accessRejections = new Map()
const accessIpRejections = new Map()
const activeAccessGrants = new Map()

const ALLOWED_KEYS = [
  'SPOTIFY_CLIENT_ID','SPOTIFY_CLIENT_SECRET','DEEZER_ARL','SPOTIFY_MARKET','SPOTIFY_FALLBACK_MARKETS',
  'YT_USE_MUSIC','PREFER_SPOTIFY_TAGS','TITLE_CLEAN_PIPE','YTDLP_UA','YTDLP_COOKIES',
  'YTDLP_COOKIES_FROM_BROWSER','YTDLP_EXTRA','YT_STRIP_COOKIES','YT_DEFAULT_REGION','YT_LANG','YTM_AUTH_USER',
  'YT_ACCEPT_LANGUAGE','YT_FORCE_IPV4','YT_403_WORKAROUNDS','ENRICH_SPOTIFY_FOR_YT','MEDIA_COMMENT',
  'YTDLP_BIN','FFMPEG_BIN','GHARMONIZE_FFMPEG_CHANNEL','TRUST_PROXY','TRUSTED_PROXY_CIDRS',
  'UPLOAD_MAX_BYTES','TRACK_EXTRACTOR_SHELL_INTEGRATION','FRONTEND_UI','YOUTUBE_QUICK_ADD_LIMIT',
  'YTLIVE_MUSIC_TITLE','YTLIVE_MUSIC_SUBTITLE','SPOTIFY_DEBUG_MARKET','CLEAN_SUFFIXES','CLEAN_PHRASES',
  'CLEAN_PARENS','PREVIEW_MAX_ENTRIES','AUTOMIX_ALL_TIMEOUT_MS','AUTOMIX_PAGE_TIMEOUT_MS',
  'PLAYLIST_ALL_TIMEOUT_MS','PLAYLIST_PAGE_TIMEOUT_MS','PLAYLIST_META_TIMEOUT_MS',
  'PLAYLIST_META_FALLBACK_TIMEOUT_MS','YT_UI_FORCE_COOKIES','YT_SEARCH_RESULTS','YT_SEARCH_TIMEOUT_MS',
  'YT_SEARCH_STAGGER_MS','HOMEPAGE_WIDGET_KEY',
  'GHARMONIZE_ACCESS_MODE','GHARMONIZE_TEMP_ACCESS_ENABLED','GHARMONIZE_TEMP_ACCESS_HOURS',
  'GHARMONIZE_TEMP_ACCESS_DAYS','GHARMONIZE_TEMP_ACCESS_MONTHS','GHARMONIZE_TEMP_ACCESS_YEARS'
]

function applyAllowedEnvValue(key, value) {
  const normalized = String(value ?? '')
  switch (key) {
    case 'SPOTIFY_CLIENT_ID': process.env.SPOTIFY_CLIENT_ID = value; return;
    case 'SPOTIFY_CLIENT_SECRET': process.env.SPOTIFY_CLIENT_SECRET = value; return;
    case 'DEEZER_ARL': process.env.DEEZER_ARL = value; return;
    case 'SPOTIFY_MARKET': process.env.SPOTIFY_MARKET = value; return;
    case 'SPOTIFY_FALLBACK_MARKETS': process.env.SPOTIFY_FALLBACK_MARKETS = value; return;
    case 'YT_USE_MUSIC': process.env.YT_USE_MUSIC = value; return;
    case 'PREFER_SPOTIFY_TAGS': process.env.PREFER_SPOTIFY_TAGS = value; return;
    case 'TITLE_CLEAN_PIPE': process.env.TITLE_CLEAN_PIPE = value; return;
    case 'YTDLP_UA': process.env.YTDLP_UA = value; return;
    case 'YTDLP_COOKIES': process.env.YTDLP_COOKIES = value; return;
    case 'YTDLP_COOKIES_FROM_BROWSER': process.env.YTDLP_COOKIES_FROM_BROWSER = value; return;
    case 'YTDLP_EXTRA': process.env.YTDLP_EXTRA = value; return;
    case 'YT_STRIP_COOKIES': process.env.YT_STRIP_COOKIES = value; return;
    case 'YT_DEFAULT_REGION': process.env.YT_DEFAULT_REGION = value; return;
    case 'YT_LANG': process.env.YT_LANG = value; return;
    case 'YTM_AUTH_USER': process.env.YTM_AUTH_USER = value; return;
    case 'YT_ACCEPT_LANGUAGE': process.env.YT_ACCEPT_LANGUAGE = value; return;
    case 'YT_FORCE_IPV4': process.env.YT_FORCE_IPV4 = value; return;
    case 'YT_403_WORKAROUNDS': process.env.YT_403_WORKAROUNDS = value; return;
    case 'ENRICH_SPOTIFY_FOR_YT': process.env.ENRICH_SPOTIFY_FOR_YT = value; return;
    case 'MEDIA_COMMENT': process.env.MEDIA_COMMENT = value; return;
    case 'YTDLP_BIN': {
      const executable = normalizeTrustedExecutableSetting(normalized, 'yt-dlp')
      if (executable) process.env.YTDLP_BIN = executable
      else delete process.env.YTDLP_BIN
      return
    }
    case 'FFMPEG_BIN': {
      const executable = normalizeTrustedExecutableSetting(normalized, 'ffmpeg')
      if (executable) process.env.FFMPEG_BIN = executable
      else delete process.env.FFMPEG_BIN
      return
    }
    case 'GHARMONIZE_FFMPEG_CHANNEL': process.env.GHARMONIZE_FFMPEG_CHANNEL = value; return;
    case 'TRUST_PROXY': process.env.TRUST_PROXY = value; return;
    case 'TRUSTED_PROXY_CIDRS': process.env.TRUSTED_PROXY_CIDRS = value; return;
    case 'UPLOAD_MAX_BYTES': process.env.UPLOAD_MAX_BYTES = value; return;
    case 'TRACK_EXTRACTOR_SHELL_INTEGRATION': process.env.TRACK_EXTRACTOR_SHELL_INTEGRATION = value; return;
    case 'FRONTEND_UI': process.env.FRONTEND_UI = value; return;
    case 'YOUTUBE_QUICK_ADD_LIMIT': process.env.YOUTUBE_QUICK_ADD_LIMIT = value; return;
    case 'YTLIVE_MUSIC_TITLE': process.env.YTLIVE_MUSIC_TITLE = value; return;
    case 'YTLIVE_MUSIC_SUBTITLE': process.env.YTLIVE_MUSIC_SUBTITLE = value; return;
    case 'SPOTIFY_DEBUG_MARKET': process.env.SPOTIFY_DEBUG_MARKET = value; return;
    case 'CLEAN_SUFFIXES': process.env.CLEAN_SUFFIXES = value; return;
    case 'CLEAN_PHRASES': process.env.CLEAN_PHRASES = value; return;
    case 'CLEAN_PARENS': process.env.CLEAN_PARENS = value; return;
    case 'PREVIEW_MAX_ENTRIES': process.env.PREVIEW_MAX_ENTRIES = value; return;
    case 'AUTOMIX_ALL_TIMEOUT_MS': process.env.AUTOMIX_ALL_TIMEOUT_MS = value; return;
    case 'AUTOMIX_PAGE_TIMEOUT_MS': process.env.AUTOMIX_PAGE_TIMEOUT_MS = value; return;
    case 'PLAYLIST_ALL_TIMEOUT_MS': process.env.PLAYLIST_ALL_TIMEOUT_MS = value; return;
    case 'PLAYLIST_PAGE_TIMEOUT_MS': process.env.PLAYLIST_PAGE_TIMEOUT_MS = value; return;
    case 'PLAYLIST_META_TIMEOUT_MS': process.env.PLAYLIST_META_TIMEOUT_MS = value; return;
    case 'PLAYLIST_META_FALLBACK_TIMEOUT_MS': process.env.PLAYLIST_META_FALLBACK_TIMEOUT_MS = value; return;
    case 'YT_UI_FORCE_COOKIES': process.env.YT_UI_FORCE_COOKIES = value; return;
    case 'YT_SEARCH_RESULTS': process.env.YT_SEARCH_RESULTS = value; return;
    case 'YT_SEARCH_TIMEOUT_MS': process.env.YT_SEARCH_TIMEOUT_MS = value; return;
    case 'YT_SEARCH_STAGGER_MS': process.env.YT_SEARCH_STAGGER_MS = value; return;
    case 'HOMEPAGE_WIDGET_KEY': process.env.HOMEPAGE_WIDGET_KEY = value; return;
    case 'GHARMONIZE_ACCESS_MODE': process.env.GHARMONIZE_ACCESS_MODE = value; return;
    case 'GHARMONIZE_TEMP_ACCESS_ENABLED': process.env.GHARMONIZE_TEMP_ACCESS_ENABLED = value; return;
    case 'GHARMONIZE_TEMP_ACCESS_HOURS': process.env.GHARMONIZE_TEMP_ACCESS_HOURS = value; return;
    case 'GHARMONIZE_TEMP_ACCESS_DAYS': process.env.GHARMONIZE_TEMP_ACCESS_DAYS = value; return;
    case 'GHARMONIZE_TEMP_ACCESS_MONTHS': process.env.GHARMONIZE_TEMP_ACCESS_MONTHS = value; return;
    case 'GHARMONIZE_TEMP_ACCESS_YEARS': process.env.GHARMONIZE_TEMP_ACCESS_YEARS = value; return;
    default: return;
  }
}

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

  let existing = []
  try {
    existing = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
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
  const contents = clean.join('\n').trim() + '\n'
  writeEnvFileSync(ENV_PATH, contents)
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

  const ytdlpExtra = String(raw.get('YTDLP_EXTRA') || process.env.YTDLP_EXTRA || '').trim()
  if (ytdlpExtra) {
    try {
      parseSafeYtDlpExtra(ytdlpExtra)
    } catch (error) {
      updates.YTDLP_EXTRA = ''
      process.env.YTDLP_EXTRA = ''
      changed = true
      console.warn(`[yt-dlp] Cleared invalid YTDLP_EXTRA setting: ${error?.message || error}`)
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

  let accessRevision = String(raw.get(ACCESS_REVISION_KEY) || process.env[ACCESS_REVISION_KEY] || '').trim()
  if (!/^[a-f0-9]{32}$/.test(accessRevision)) {
    accessRevision = crypto.randomBytes(16).toString('hex')
    updates[ACCESS_REVISION_KEY] = accessRevision
    changed = true
  }

  if (changed) writeEnv(updates, ['ADMIN_PASSWORD', 'ADMIN_PASSWORD_HASH', ACCESS_REVISION_KEY])
  if (passwordHash) process.env.ADMIN_PASSWORD_HASH = passwordHash
  process.env.ADMIN_PASSWORD = ''
  process.env[ACCESS_REVISION_KEY] = accessRevision
}

migrateSecurityState()

function getAdminPasswordHash() {
  return getEnv('ADMIN_PASSWORD_HASH')
}

function setAdminPasswordSync(newPass) {
  const hash = hashPassword(newPass)
  const accessRevision = crypto.randomBytes(16).toString('hex')
  writeEnv(
    { ADMIN_PASSWORD_HASH: hash, ADMIN_PASSWORD: '', [ACCESS_REVISION_KEY]: accessRevision },
    ['ADMIN_PASSWORD_HASH', 'ADMIN_PASSWORD', ACCESS_REVISION_KEY]
  )
  process.env.ADMIN_PASSWORD_HASH = hash
  process.env.ADMIN_PASSWORD = ''
  process.env[ACCESS_REVISION_KEY] = accessRevision
  sessionGeneration += 1
  accessRequests.clear()
  accessRejections.clear()
  accessIpRejections.clear()
  clearActiveAccessGrants()
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
  return parseCookieHeader(req.get('cookie') || '').get(SESSION_COOKIE) || null
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

function normalizeClientIp(req) {
  const raw = String(req.ip || req.socket?.remoteAddress || 'unknown').trim()
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

function hashClientIp(ip) {
  return crypto.createHash('sha256').update(String(ip || '')).digest('base64url')
}

function getAccessRevision() {
  const value = String(process.env[ACCESS_REVISION_KEY] || getEnv(ACCESS_REVISION_KEY) || '').trim()
  return /^[a-f0-9]{32}$/.test(value) ? value : 'invalid'
}

function persistActiveAccessGrants() {
  const payload = {
    version: 1,
    accessRevision: getAccessRevision(),
    grants: [...activeAccessGrants.values()].map((grant) => ({
      id: grant.id,
      ip: grant.ip,
      ipHash: grant.ipHash,
      userAgent: grant.userAgent,
      createdAt: grant.createdAt,
      approvedAt: grant.approvedAt,
      expiresAt: grant.expiresAt,
      accessRevision: grant.accessRevision
    }))
  }
  try {
    fs.mkdirSync(path.dirname(ACTIVE_ACCESS_GRANTS_PATH), { recursive: true })
    const tempPath = `${ACTIVE_ACCESS_GRANTS_PATH}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}
`, { mode: 0o600 })
    fs.renameSync(tempPath, ACTIVE_ACCESS_GRANTS_PATH)
    try { fs.chmodSync(ACTIVE_ACCESS_GRANTS_PATH, 0o600) } catch {}
  } catch (error) {
    console.warn('[access] Could not persist temporary access grants:', error?.message || error)
  }
}

function loadActiveAccessGrants() {
  activeAccessGrants.clear()
  let payload = null
  try {
    payload = JSON.parse(fs.readFileSync(ACTIVE_ACCESS_GRANTS_PATH, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[access] Could not read temporary access grants:', error?.message || error)
    return
  }
  if (!payload || payload.version !== 1 || payload.accessRevision !== getAccessRevision() || !Array.isArray(payload.grants)) {
    persistActiveAccessGrants()
    return
  }
  const now = Date.now()
  for (const raw of payload.grants.slice(0, MAX_ACCESS_REQUESTS)) {
    const id = String(raw?.id || '')
    const ip = String(raw?.ip || '')
    const expiresAt = Number(raw?.expiresAt || 0)
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(id) || !ip || !Number.isFinite(expiresAt) || expiresAt <= now) continue
    const ipHash = hashClientIp(ip)
    activeAccessGrants.set(id, {
      id,
      ip,
      ipHash,
      userAgent: String(raw?.userAgent || '').slice(0, 180),
      createdAt: Number(raw?.createdAt || raw?.approvedAt || now),
      approvedAt: Number(raw?.approvedAt || raw?.createdAt || now),
      expiresAt,
      accessRevision: getAccessRevision()
    })
  }
  persistActiveAccessGrants()
}

function clearActiveAccessGrants() {
  activeAccessGrants.clear()
  persistActiveAccessGrants()
}

loadActiveAccessGrants()

function parseBoundedInteger(value, fallback, min, max) {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function getAccessConfig() {
  const mode = getEnv('GHARMONIZE_ACCESS_MODE') === 'admin' ? 'admin' : 'none'
  const tempEnabled = mode === 'admin' && ['1', 'true', 'yes', 'on'].includes(String(getEnv('GHARMONIZE_TEMP_ACCESS_ENABLED')).toLowerCase())
  const duration = {
    hours: parseBoundedInteger(getEnv('GHARMONIZE_TEMP_ACCESS_HOURS'), 1, 0, 23),
    days: parseBoundedInteger(getEnv('GHARMONIZE_TEMP_ACCESS_DAYS'), 0, 0, 365),
    months: parseBoundedInteger(getEnv('GHARMONIZE_TEMP_ACCESS_MONTHS'), 0, 0, 11),
    years: parseBoundedInteger(getEnv('GHARMONIZE_TEMP_ACCESS_YEARS'), 0, 0, 5)
  }
  const totalHours = duration.hours + (duration.days * 24) + (duration.months * 30 * 24) + (duration.years * 365 * 24)
  const durationMs = Math.min(MAX_TEMP_ACCESS_MS, totalHours * 60 * 60 * 1000)
  return { mode, tempEnabled, duration, durationMs }
}

function clearTemporaryAccessCookie(res) {
  res.clearCookie(TEMP_ACCESS_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' })
}

function setTemporaryAccessCookie(req, res, expiresAt, grantId) {
  const now = Date.now()
  const maxAge = Math.max(1, Math.min(MAX_TEMP_ACCESS_MS, Number(expiresAt) - now))
  const token = sign({
    iat: now,
    exp: Number(expiresAt),
    role: 'temporary',
    ar: getAccessRevision(),
    gid: String(grantId || ''),
    ip: hashClientIp(normalizeClientIp(req))
  })
  res.cookie(TEMP_ACCESS_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: Boolean(req.secure),
    path: '/',
    maxAge
  })
}

function verifyTemporaryAccess(req) {
  const token = parseCookieHeader(req.get('cookie') || '').get(TEMP_ACCESS_COOKIE) || null
  if (!token || typeof token !== 'string' || !token.includes('.')) return null
  const [payload, mac] = token.split('.')
  const expected = crypto.createHmac('sha256', deriveSessionSecret()).update(payload).digest('base64url')
  const macBuf = Buffer.from(mac || '', 'utf8')
  const expBuf = Buffer.from(expected, 'utf8')
  if (macBuf.length !== expBuf.length || !crypto.timingSafeEqual(macBuf, expBuf)) return null
  let obj = null
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch {}
  if (!obj || obj.role !== 'temporary') return null
  if (obj.ar !== getAccessRevision()) return null
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(obj.gid || ''))) return null
  if (!Number.isFinite(obj.exp) || Date.now() >= obj.exp) return null
  const currentIpHash = hashClientIp(normalizeClientIp(req))
  if (obj.ip !== currentIpHash) return null
  const grant = activeAccessGrants.get(obj.gid)
  if (!grant || grant.accessRevision !== getAccessRevision()) return null
  if (grant.ipHash !== currentIpHash || Number(grant.expiresAt) !== Number(obj.exp) || Date.now() >= Number(grant.expiresAt)) return null
  return { ...obj, grantId: grant.id }
}

function signAccessClientId(id) {
  const value = String(id || '')
  const mac = crypto.createHmac('sha256', deriveSessionSecret())
    .update(`access-client:${value}`)
    .digest('base64url')
  return `${value}.${mac}`
}

function verifyAccessClientIdCookie(req) {
  const raw = parseCookieHeader(req.get('cookie') || '').get(ACCESS_REQUEST_CLIENT_COOKIE) || ''
  const [id, mac] = String(raw).split('.')
  if (!/^[A-Za-z0-9_-]{32}$/.test(id || '') || !/^[A-Za-z0-9_-]{43}$/.test(mac || '')) return null
  const expected = signAccessClientId(id).split('.')[1]
  const macBuf = Buffer.from(mac, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (macBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(macBuf, expectedBuf)) return null
  return id
}

function getOrCreateAccessRequesterKey(req, res) {
  let id = verifyAccessClientIdCookie(req)
  if (!id) {
    id = crypto.randomBytes(24).toString('base64url')
    res.cookie(ACCESS_REQUEST_CLIENT_COOKIE, signAccessClientId(id), {
      httpOnly: true,
      sameSite: 'strict',
      secure: Boolean(req.secure),
      path: '/',
      maxAge: ACCESS_REQUEST_CLIENT_TTL_MS
    })
  }
  return crypto.createHmac('sha256', deriveSessionSecret())
    .update(`access-requester:${id}:${normalizeClientIp(req)}`)
    .digest('base64url')
}

function getAccessRequesterKey(req) {
  const id = verifyAccessClientIdCookie(req)
  if (!id) return null
  return crypto.createHmac('sha256', deriveSessionSecret())
    .update(`access-requester:${id}:${normalizeClientIp(req)}`)
    .digest('base64url')
}

function cleanupAccessRequests() {
  const now = Date.now()
  let grantsChanged = false
  for (const [id, row] of accessRequests) {
    const terminalAt = Number(row.updatedAt || row.createdAt || 0)
    // Pending requests intentionally remain visible until an administrator
    // explicitly approves/rejects them (or the process/access policy is reset).
    if (row.status !== 'pending' && now - terminalAt > ACCESS_REQUEST_RESULT_TTL_MS) {
      accessRequests.delete(id)
    }
  }
  for (const [id, grant] of activeAccessGrants) {
    if (!Number.isFinite(Number(grant.expiresAt)) || Number(grant.expiresAt) <= now || grant.accessRevision !== getAccessRevision()) {
      activeAccessGrants.delete(id)
      grantsChanged = true
    }
  }
  if (grantsChanged) persistActiveAccessGrants()
  for (const [key, retryAt] of accessRejections) {
    if (!Number.isFinite(retryAt) || retryAt <= now) accessRejections.delete(key)
  }
  for (const [key, retryAt] of accessIpRejections) {
    if (!Number.isFinite(retryAt) || retryAt <= now) accessIpRejections.delete(key)
  }
}

function publicAccessRequest(row) {
  return {
    id: row.id,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    status: row.status
  }
}

function publicAccessGrant(grant) {
  return {
    id: grant.id,
    ip: grant.ip,
    userAgent: grant.userAgent,
    createdAt: grant.createdAt,
    approvedAt: grant.approvedAt,
    expiresAt: grant.expiresAt,
    status: 'approved'
  }
}

function currentAccessState(req) {
  const config = getAccessConfig()
  const admin = verify(getTokenFromReq(req))
  const temporary = config.tempEnabled ? verifyTemporaryAccess(req) : null
  if (config.mode === 'none') {
    return { config, authorized: true, role: admin ? 'admin' : 'none', admin, temporary: null, expiresAt: null }
  }
  if (admin) {
    return { config, authorized: true, role: 'admin', admin, temporary: null, expiresAt: null }
  }
  if (temporary) {
    return { config, authorized: true, role: 'temporary', admin: null, temporary, expiresAt: temporary.exp }
  }
  return { config, authorized: false, role: 'none', admin: null, temporary: null, expiresAt: null }
}

export function appAccessMiddleware(req, res, next) {
  const pathName = String(req.path || '')
  const bypass = pathName === '/api/auth/login'
    || pathName === '/api/auth/logout'
    || pathName === '/api/access/status'
    || pathName === '/api/access/request'
    || /^\/api\/access\/request\/[A-Za-z0-9_-]{20,64}$/.test(pathName)
    || pathName === '/api/access/logout'
    || pathName === '/api/homepage'
  if (bypass) return next()

  const state = currentAccessState(req)
  if (state.config.mode === 'none' || state.authorized) {
    if (state.admin) req.adminAuth = state.admin
    if (state.temporary) req.temporaryAccess = state.temporary
    return next()
  }
  res.set('Cache-Control', 'no-store')
  return res.status(401).json({
    error: {
      code: 'APP_ACCESS_REQUIRED',
      message: 'Gharmonize access authorization is required.'
    },
    access: {
      mode: state.config.mode,
      temporaryRequestsEnabled: state.config.tempEnabled
    }
  })
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

// Public gate status. It exposes only the access mode and authorization state, never admin settings.
router.get('/access/status', rateLimit(120, 60_000), (req, res) => {
  cleanupAccessRequests()
  const state = currentAccessState(req)
  res.set('Cache-Control', 'no-store')
  res.json({
    mode: state.config.mode,
    authorized: state.authorized,
    role: state.role,
    expiresAt: state.expiresAt,
    temporaryRequestsEnabled: state.config.tempEnabled,
    temporaryDuration: state.config.duration
  })
})

router.post('/access/request', rateLimit(6, 60_000), express.json(), (req, res) => {
  cleanupAccessRequests()
  const config = getAccessConfig()
  if (config.mode !== 'admin' || !config.tempEnabled || config.durationMs < 60 * 60 * 1000) {
    return res.status(403).json({ error: { code: 'TEMP_ACCESS_DISABLED', message: 'Temporary access requests are disabled.' } })
  }

  const ip = normalizeClientIp(req)
  const userAgent = String(req.get('user-agent') || '').replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, 180)
  const requesterKey = getOrCreateAccessRequesterKey(req, res)
  const ipKey = hashClientIp(ip)
  const now = Date.now()
  const retryAt = Math.max(
    Number(accessRejections.get(requesterKey) || 0),
    Number(accessIpRejections.get(ipKey) || 0)
  )

  const activeGrantForIp = [...activeAccessGrants.values()].find((grant) =>
    grant.ipHash === ipKey && Number(grant.expiresAt) > now
  )
  if (activeGrantForIp) {
    return res.status(409).json({
      error: {
        code: 'ACCESS_IP_ALREADY_AUTHORIZED',
        message: 'This IP address already has active temporary access.'
      },
      expiresAt: activeGrantForIp.expiresAt
    })
  }

  if (retryAt > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((retryAt - now) / 1000))
    res.set('Retry-After', String(retryAfterSeconds))
    return res.status(429).json({
      error: {
        code: 'ACCESS_REQUEST_COOLDOWN',
        message: 'A rejected access request cannot be submitted again yet.'
      },
      retryAt,
      retryAfterMs: retryAt - now
    })
  }

  // One observed IP may have only one pending request at a time. Repeated clicks
  // from the same browser reuse its request; a second browser/device on the same
  // IP is rejected until the existing request is decided.
  const existingForIp = [...accessRequests.values()].find((row) =>
    row.status === 'pending' && hashClientIp(row.ip) === ipKey
  )
  if (existingForIp) {
    if (existingForIp.requesterKey === requesterKey) {
      return res.status(202).json({
        id: existingForIp.id,
        status: 'pending',
        createdAt: existingForIp.createdAt
      })
    }
    return res.status(409).json({
      error: {
        code: 'ACCESS_REQUEST_IP_PENDING',
        message: 'This IP address already has a pending access request.'
      }
    })
  }

  if (accessRequests.size >= MAX_ACCESS_REQUESTS) {
    return res.status(503).json({ error: { code: 'ACCESS_REQUEST_CAPACITY', message: 'Too many pending access requests.' } })
  }

  const id = crypto.randomBytes(24).toString('base64url')
  accessRequests.set(id, {
    id,
    ip,
    userAgent,
    requesterKey,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    expiresAt: null,
    retryAt: null
  })
  res.status(202).json({ id, status: 'pending', createdAt: now })
})

router.get('/access/request/:id', rateLimit(120, 60_000), (req, res) => {
  cleanupAccessRequests()
  const id = String(req.params?.id || '')
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) return res.status(404).json({ error: { code: 'ACCESS_REQUEST_NOT_FOUND', message: 'Access request not found.' } })
  const row = accessRequests.get(id)
  const requesterKey = getAccessRequesterKey(req)
  if (!row || !requesterKey || row.requesterKey !== requesterKey) return res.status(404).json({ error: { code: 'ACCESS_REQUEST_NOT_FOUND', message: 'Access request not found.' } })

  res.set('Cache-Control', 'no-store')
  if (row.status === 'approved' && Number(row.expiresAt) > Date.now()) {
    const grant = activeAccessGrants.get(String(row.grantId || ''))
    if (grant && Number(grant.expiresAt) === Number(row.expiresAt)) {
      setTemporaryAccessCookie(req, res, row.expiresAt, row.grantId)
      return res.json({ status: 'approved', authorized: true, expiresAt: row.expiresAt })
    }
    row.status = 'expired'
  }
  if (row.status === 'approved') row.status = 'expired'
  return res.json({
    status: row.status,
    authorized: false,
    retryAt: row.status === 'rejected' ? Number(row.retryAt || 0) || null : null
  })
})

router.post('/access/logout', rateLimit(30, 60_000), (_req, res) => {
  clearTemporaryAccessCookie(res)
  res.json({ ok: true })
})

router.get('/access/requests', authMiddleware, rateLimit(120, 60_000), (_req, res) => {
  cleanupAccessRequests()
  const config = getAccessConfig()
  const requests = [...accessRequests.values()]
    .filter((row) => row.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, 50)
    .map(publicAccessRequest)
  const active = [...activeAccessGrants.values()]
    .sort((a, b) => b.approvedAt - a.approvedAt)
    .slice(0, 100)
    .map(publicAccessGrant)
  res.set('Cache-Control', 'no-store')
  res.json({ requests, active, temporaryDuration: config.duration })
})

router.post('/access/requests/:id/decision', authMiddleware, rateLimit(60, 60_000), express.json(), (req, res) => {
  cleanupAccessRequests()
  const id = String(req.params?.id || '')
  const decision = String(req.body?.decision || '')
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) return res.status(404).json({ error: { code: 'ACCESS_REQUEST_NOT_FOUND', message: 'Access request not found.' } })
  if (decision !== 'approve' && decision !== 'reject') return res.status(400).json({ error: { code: 'INVALID_ACCESS_DECISION', message: 'Decision must be approve or reject.' } })
  const row = accessRequests.get(id)
  if (!row || row.status !== 'pending') return res.status(404).json({ error: { code: 'ACCESS_REQUEST_NOT_FOUND', message: 'Access request not found.' } })

  const config = getAccessConfig()
  if (decision === 'approve') {
    if (config.mode !== 'admin' || !config.tempEnabled || config.durationMs < 60 * 60 * 1000) {
      return res.status(409).json({ error: { code: 'TEMP_ACCESS_DISABLED', message: 'Temporary access is no longer enabled.' } })
    }
    row.status = 'approved'
    row.expiresAt = Date.now() + config.durationMs
    row.retryAt = null
    row.grantId = crypto.randomBytes(24).toString('base64url')
    const grant = {
      id: row.grantId,
      ip: row.ip,
      ipHash: hashClientIp(row.ip),
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      approvedAt: Date.now(),
      expiresAt: row.expiresAt,
      accessRevision: getAccessRevision()
    }
    activeAccessGrants.set(grant.id, grant)
    persistActiveAccessGrants()
    accessRejections.delete(row.requesterKey)
    accessIpRejections.delete(grant.ipHash)
  } else {
    row.status = 'rejected'
    row.expiresAt = null
    row.retryAt = Date.now() + ACCESS_REJECTION_COOLDOWN_MS
    accessRejections.set(row.requesterKey, row.retryAt)
    accessIpRejections.set(hashClientIp(row.ip), Date.now() + ACCESS_REJECTION_IP_COOLDOWN_MS)
  }
  row.updatedAt = Date.now()
  res.json({
    ok: true,
    status: row.status,
    expiresAt: row.expiresAt,
    retryAt: row.retryAt
  })
})

router.post('/access/grants/:id/revoke', authMiddleware, rateLimit(60, 60_000), (req, res) => {
  cleanupAccessRequests()
  const id = String(req.params?.id || '')
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) {
    return res.status(404).json({ error: { code: 'ACCESS_GRANT_NOT_FOUND', message: 'Temporary access grant not found.' } })
  }
  const grant = activeAccessGrants.get(id)
  if (!grant) {
    return res.status(404).json({ error: { code: 'ACCESS_GRANT_NOT_FOUND', message: 'Temporary access grant not found.' } })
  }
  activeAccessGrants.delete(id)
  persistActiveAccessGrants()
  res.json({ ok: true, revoked: true, id })
})

// Custom Gharmonize rateLimit middleware is applied on this route.
router.post('/auth/login', rateLimit(10, 60_000), express.json(), (req, res) => {
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

// Custom Gharmonize rateLimit middleware is applied on this route.
router.post('/auth/logout', rateLimit(30, 60_000), (_req, res) => { clearSessionCookie(res); res.json({ ok: true }) })

router.get('/ui-config', (_req, res) => {
  const frontendUi = getEnv('FRONTEND_UI') === 'ytlive' ? 'ytlive' : 'classic'
  const quickAddRaw = Number(getEnv('YOUTUBE_QUICK_ADD_LIMIT') || 25)
  const quickAddLimit = Number.isFinite(quickAddRaw) && quickAddRaw > 0 ? Math.min(100, Math.max(1, Math.round(quickAddRaw))) : 25
  res.json({ frontendUi, quickAddLimit, musicTitle: getEnv('YTLIVE_MUSIC_TITLE') || 'Gharmonize Music', musicSubtitle: getEnv('YTLIVE_MUSIC_SUBTITLE') })
})

// Custom Gharmonize rateLimit middleware is applied on this route.
router.get('/auth/verify', authMiddleware, rateLimit(120, 60_000), (_req, res) => res.json({ valid: true, message: 'Session is valid' }))

// Custom Gharmonize rateLimit middleware is applied on this route.
router.get('/settings', authMiddleware, rateLimit(60, 60_000), (_req, res) => {
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

// Custom Gharmonize rateLimit middleware is applied on this route.
router.post('/settings', authMiddleware, rateLimit(30, 60_000), express.json(), (req, res) => {
  const incoming = (req.body && req.body.settings) || {}; const env = parseEnv(); const updates = {}
  for (const k of ALLOWED_KEYS) {
    if (!(k in incoming)) continue
    const v = incoming[k]
    if (SENSITIVE_KEYS.has(k)) { updates[k] = (!v || v === '••••••••') ? (env.get(k) || '') : String(v); continue }
    if (k === 'GHARMONIZE_FFMPEG_CHANNEL') { updates[k] = String(v || '').trim().toLowerCase() === 'master' ? 'master' : 'stable'; continue }
    if (k === 'TRUST_PROXY') { updates[k] = ['1','true','yes','on'].includes(String(v ?? '').trim().toLowerCase()) ? '1' : '0'; continue }
    if (typeof v !== 'undefined' && v !== null) updates[k] = String(v)
  }
  try {
    if (Object.prototype.hasOwnProperty.call(updates, 'GHARMONIZE_ACCESS_MODE')) {
      updates.GHARMONIZE_ACCESS_MODE = String(updates.GHARMONIZE_ACCESS_MODE || '').trim().toLowerCase() === 'admin' ? 'admin' : 'none'
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'GHARMONIZE_TEMP_ACCESS_ENABLED')) {
      updates.GHARMONIZE_TEMP_ACCESS_ENABLED = ['1', 'true', 'yes', 'on'].includes(String(updates.GHARMONIZE_TEMP_ACCESS_ENABLED || '').trim().toLowerCase()) ? '1' : '0'
    }
    const durationLimits = {
      GHARMONIZE_TEMP_ACCESS_HOURS: 23,
      GHARMONIZE_TEMP_ACCESS_DAYS: 365,
      GHARMONIZE_TEMP_ACCESS_MONTHS: 11,
      GHARMONIZE_TEMP_ACCESS_YEARS: 5
    }
    for (const [key, max] of Object.entries(durationLimits)) {
      if (!Object.prototype.hasOwnProperty.call(updates, key)) continue
      const raw = String(updates[key] ?? '').trim()
      if (!/^\d+$/.test(raw) || Number(raw) < 0 || Number(raw) > max) {
        throw new Error(`${key} must be an integer between 0 and ${max}.`)
      }
      updates[key] = String(Number(raw))
    }

    const effectiveMode = Object.prototype.hasOwnProperty.call(updates, 'GHARMONIZE_ACCESS_MODE')
      ? updates.GHARMONIZE_ACCESS_MODE
      : (getEnv('GHARMONIZE_ACCESS_MODE') === 'admin' ? 'admin' : 'none')
    if (effectiveMode === 'none') updates.GHARMONIZE_TEMP_ACCESS_ENABLED = '0'

    const effectiveTempEnabled = Object.prototype.hasOwnProperty.call(updates, 'GHARMONIZE_TEMP_ACCESS_ENABLED')
      ? updates.GHARMONIZE_TEMP_ACCESS_ENABLED === '1'
      : ['1', 'true', 'yes', 'on'].includes(String(getEnv('GHARMONIZE_TEMP_ACCESS_ENABLED')).toLowerCase())
    if (effectiveMode === 'admin' && effectiveTempEnabled) {
      const valueFor = (key, fallback) => Number(Object.prototype.hasOwnProperty.call(updates, key) ? updates[key] : (getEnv(key) || fallback))
      const totalHours = valueFor('GHARMONIZE_TEMP_ACCESS_HOURS', 1)
        + valueFor('GHARMONIZE_TEMP_ACCESS_DAYS', 0) * 24
        + valueFor('GHARMONIZE_TEMP_ACCESS_MONTHS', 0) * 30 * 24
        + valueFor('GHARMONIZE_TEMP_ACCESS_YEARS', 0) * 365 * 24
      if (!Number.isFinite(totalHours) || totalHours < 1) throw new Error('Temporary access duration must be at least 1 hour.')
      if (totalHours * 60 * 60 * 1000 > MAX_TEMP_ACCESS_MS) throw new Error('Temporary access duration cannot exceed 5 years.')
    }

    for (const key of EXECUTABLE_SETTING_KEYS) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        updates[key] = normalizeTrustedExecutableSetting(updates[key], key === 'YTDLP_BIN' ? 'yt-dlp' : 'ffmpeg')
      }
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'YTDLP_EXTRA')) {
      parseSafeYtDlpExtra(updates.YTDLP_EXTRA)
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'DEEZER_ARL')) {
      updates.DEEZER_ARL = normalizeDeezerArl(updates.DEEZER_ARL)
    }
  } catch (error) {
    return res.status(400).json({
      error: {
        code: 'INVALID_ADVANCED_SETTING',
        message: error?.message || 'Invalid executable setting'
      }
    })
  }
  const accessBefore = getAccessConfig()
  const accessBeforeValues = {
    GHARMONIZE_ACCESS_MODE: accessBefore.mode,
    GHARMONIZE_TEMP_ACCESS_ENABLED: accessBefore.tempEnabled ? '1' : '0',
    GHARMONIZE_TEMP_ACCESS_HOURS: String(accessBefore.duration.hours),
    GHARMONIZE_TEMP_ACCESS_DAYS: String(accessBefore.duration.days),
    GHARMONIZE_TEMP_ACCESS_MONTHS: String(accessBefore.duration.months),
    GHARMONIZE_TEMP_ACCESS_YEARS: String(accessBefore.duration.years)
  }
  const accessKeysChanged = Object.entries(accessBeforeValues).some(([key, beforeValue]) =>
    Object.prototype.hasOwnProperty.call(updates, key) && String(updates[key]) !== beforeValue
  )

  const nextAccessRevision = accessKeysChanged ? crypto.randomBytes(16).toString('hex') : null
  if (nextAccessRevision) {
    writeEnv({ ...updates, [ACCESS_REVISION_KEY]: nextAccessRevision }, [ACCESS_REVISION_KEY])
  } else {
    writeEnv(updates)
  }
  for (const [k, v] of Object.entries(updates)) applyAllowedEnvValue(k, v)
  if (nextAccessRevision) {
    process.env[ACCESS_REVISION_KEY] = nextAccessRevision
    accessRequests.clear()
    accessRejections.clear()
    accessIpRejections.clear()
    clearActiveAccessGrants()
  }
  process.emit('gharmonize:settings-updated', { updates })
  res.json({ ok: true, appliedInMemory: true })
})

// Custom Gharmonize rateLimit middleware is applied on this route.
router.post('/auth/change-password', authMiddleware, rateLimit(10, 60_000), express.json(), (req, res) => {
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
// Custom Gharmonize rateLimit middleware is applied on this route.
router.post('/settings/homepage-widget-key', authMiddleware, rateLimit(10, 60_000), express.json(), (req, res) => {
  const { rotate = true, reveal = false } = req.body || {}; const env = parseEnv(); const existing = (env.get('HOMEPAGE_WIDGET_KEY') || '').trim()
  if (!rotate && existing) return res.json({ ok: true, rotated: false, key: reveal ? existing : undefined })
  const next = generateHomepageWidgetKey(); writeEnv({ HOMEPAGE_WIDGET_KEY: next }, ['HOMEPAGE_WIDGET_KEY']); process.env.HOMEPAGE_WIDGET_KEY = next
  res.json({ ok: true, rotated: true, key: reveal ? next : undefined })
})

// Custom Gharmonize rateLimit middleware is applied on this route.
router.post('/settings/refresh-binaries', authMiddleware, rateLimit(5, 60_000), async (_req, res) => {
  try {
    const refresh = await initializeDynamicBinaries({ force: true }); clearBinariesInfoCache(); const binaries = await getBinariesInfo({ force: true })
    return res.json({ ok: true, refresh, binaries })
  } catch (err) {
    return res.status(500).json({ error: { code: 'BINARY_REFRESH_FAILED', message: err.message || 'Could not refresh binaries.' } })
  }
})

export default router
