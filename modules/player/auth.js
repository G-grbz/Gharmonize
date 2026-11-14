import crypto from 'node:crypto'
import { hashPassword, verifyPassword, parseCookieHeader } from '../security.js'
import { transaction } from './db.js'

export const PLAYER_SESSION_COOKIE = 'gharmonize_player_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const PAIRING_TTL_MS = 10 * 60 * 1000
const TOKEN_PREFIX = 'ghp_'
const TOUCH_INTERVAL_MS = 60 * 1000
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const USERNAME_RE = /^[\p{L}\p{N}._-]{2,32}$/u

export class PlayerAuthError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex')

export function validateUsername(username) {
  const value = String(username || '').trim()
  if (!USERNAME_RE.test(value)) {
    throw new PlayerAuthError('INVALID_USERNAME', 'Username must be 2-32 characters: letters, numbers, dot, dash or underscore.')
  }
  return value
}

export function validatePassword(password) {
  const value = String(password || '')
  if (value.length < 8) throw new PlayerAuthError('WEAK_PASSWORD', 'Password must be at least 8 characters long.')
  if (value.length > 256) throw new PlayerAuthError('WEAK_PASSWORD', 'Password is too long.')
  return value
}

export function publicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    disabled: Boolean(row.disabled),
    canDownload: row.role === 'admin' || Boolean(row.can_download),
    allLibraries: row.role === 'admin' || Boolean(row.all_libraries),
    createdAt: row.created_at
  }
}

// libraryAccess: 'all' | number[] (library ids) | undefined (keep / default)
function normalizeLibraryAccess(value) {
  if (value === undefined || value === null) return undefined
  if (value === 'all' || value === true) return 'all'
  if (!Array.isArray(value)) throw new PlayerAuthError('INVALID_LIBRARY_ACCESS', 'libraryAccess must be "all" or a list of library ids.')
  return [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
}

export function createAuthStore(db, { now = () => Date.now() } = {}) {
  const lastTouch = new Map()

  const stmt = {
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    countAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0"),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    listUsers: db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE'),
    insertUser: db.prepare('INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
    tokenByHash: db.prepare(`
      SELECT t.id AS token_id, t.kind, t.name AS token_name, t.expires_at, t.revoked_at, u.*
      FROM tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`),
    insertToken: db.prepare('INSERT INTO tokens (id, user_id, kind, name, platform, token_hash, created_at, last_ip, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    touchToken: db.prepare('UPDATE tokens SET last_used_at = ?, last_ip = ? WHERE id = ?'),
    revokeToken: db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    revokeUserTokens: db.prepare('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'),
    listTokens: db.prepare(`
      SELECT id, user_id, kind, name, platform, created_at, last_used_at, last_ip, expires_at
      FROM tokens WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY COALESCE(last_used_at, created_at) DESC`),
    purgeTokens: db.prepare('DELETE FROM tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?)'),
    insertPairing: db.prepare('INSERT INTO pairing_codes (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    pairingByHash: db.prepare('SELECT * FROM pairing_codes WHERE code_hash = ?'),
    usePairing: db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL'),
    purgePairing: db.prepare('DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL')
  }

  const defaultLibraryId = () => db.prepare('SELECT id FROM libraries WHERE is_default = 1').get()?.id || null

  function getLibraryIds(userId) {
    return db.prepare('SELECT library_id FROM user_libraries WHERE user_id = ? ORDER BY library_id').all(Number(userId)).map((r) => r.library_id)
  }

  // Applies download right + library grants. Downloads always land in the
  // Gharmonize download library, so a user who may download must see it.
  function applyPermissions(userId, { canDownload, libraryAccess } = {}) {
    const user = stmt.userById.get(Number(userId))
    if (canDownload !== undefined) db.prepare('UPDATE users SET can_download = ? WHERE id = ?').run(canDownload ? 1 : 0, user.id)
    const access = normalizeLibraryAccess(libraryAccess)
    if (access === 'all') {
      db.prepare('UPDATE users SET all_libraries = 1 WHERE id = ?').run(user.id)
      db.prepare('DELETE FROM user_libraries WHERE user_id = ?').run(user.id)
    } else if (Array.isArray(access)) {
      const known = new Set(db.prepare('SELECT id FROM libraries').all().map((r) => r.id))
      const unknown = access.filter((id) => !known.has(id))
      if (unknown.length) throw new PlayerAuthError('LIBRARY_NOT_FOUND', `Unknown library id(s): ${unknown.join(', ')}`, 404)
      db.prepare('UPDATE users SET all_libraries = 0 WHERE id = ?').run(user.id)
      db.prepare('DELETE FROM user_libraries WHERE user_id = ?').run(user.id)
      const ins = db.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)')
      for (const id of access) ins.run(user.id, id)
    }
    const fresh = stmt.userById.get(user.id)
    const def = defaultLibraryId()
    if (fresh.can_download && !fresh.all_libraries && def) {
      db.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)').run(user.id, def)
    }
  }

  function getUserDetails(id) {
    const user = publicUser(stmt.userById.get(Number(id)))
    if (!user) return null
    return { ...user, libraryIds: user.allLibraries ? null : getLibraryIds(user.id) }
  }

  function hasUsers() {
    return Number(stmt.countUsers.get().n) > 0
  }

  // New users see only the Gharmonize download library and cannot download,
  // unless the administrator grants more.
  function createUser({ username, displayName, password, role = 'user', canDownload = false, libraryAccess } = {}) {
    const name = validateUsername(username)
    const pass = validatePassword(password)
    const finalRole = role === 'admin' ? 'admin' : 'user'
    const access = normalizeLibraryAccess(libraryAccess)
    if (stmt.userByName.get(name)) throw new PlayerAuthError('USERNAME_TAKEN', 'This username is already in use.', 409)
    const display = String(displayName || '').trim().slice(0, 64) || name
    const passwordHash = hashPassword(pass, { enforcePolicy: false })
    return transaction(db, () => {
      const ts = now()
      const info = stmt.insertUser.run(name, display, passwordHash, finalRole, ts, ts)
      const id = Number(info.lastInsertRowid)
      const def = defaultLibraryId()
      applyPermissions(id, { canDownload: Boolean(canDownload), libraryAccess: access === undefined ? (def ? [def] : []) : access })
      return getUserDetails(id)
    })
  }

  function updateUser(id, { displayName, password, role, disabled, canDownload, libraryAccess } = {}) {
    const user = stmt.userById.get(Number(id))
    if (!user) throw new PlayerAuthError('USER_NOT_FOUND', 'User not found.', 404)
    const next = {
      display_name: displayName !== undefined ? (String(displayName).trim().slice(0, 64) || user.username) : user.display_name,
      role: role !== undefined ? (role === 'admin' ? 'admin' : 'user') : user.role,
      disabled: disabled !== undefined ? (disabled ? 1 : 0) : user.disabled,
      password_hash: password !== undefined ? hashPassword(validatePassword(password), { enforcePolicy: false }) : user.password_hash
    }
    const losesAdmin = user.role === 'admin' && !user.disabled && (next.role !== 'admin' || next.disabled)
    return transaction(db, () => {
      if (losesAdmin && Number(stmt.countAdmins.get().n) <= 1) {
        throw new PlayerAuthError('LAST_ADMIN', 'At least one active player administrator is required.', 409)
      }
      db.prepare('UPDATE users SET display_name = ?, role = ?, disabled = ?, password_hash = ?, updated_at = ? WHERE id = ?')
        .run(next.display_name, next.role, next.disabled, next.password_hash, now(), user.id)
      if (next.disabled || password !== undefined) stmt.revokeUserTokens.run(now(), user.id)
      applyPermissions(user.id, { canDownload, libraryAccess })
      return getUserDetails(user.id)
    })
  }

  function deleteUser(id) {
    const user = stmt.userById.get(Number(id))
    if (!user) throw new PlayerAuthError('USER_NOT_FOUND', 'User not found.', 404)
    transaction(db, () => {
      if (user.role === 'admin' && !user.disabled && Number(stmt.countAdmins.get().n) <= 1) {
        throw new PlayerAuthError('LAST_ADMIN', 'At least one active player administrator is required.', 409)
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id)
    })
  }

  function listUsers() {
    return stmt.listUsers.all().map((row) => getUserDetails(row.id))
  }

  function getUser(id) {
    return publicUser(stmt.userById.get(Number(id)))
  }

  function verifyCredentials(username, password) {
    const user = stmt.userByName.get(String(username || '').trim())
    // Always spend comparable work to avoid username probing via timing.
    const hash = user?.password_hash || 'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA'
    const ok = verifyPassword(String(password || ''), hash)
    if (!user || !ok || user.disabled) return null
    return publicUser(user)
  }

  function issueToken(userId, { kind = 'session', name = '', platform = '', ip = '' } = {}) {
    const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url')
    const id = crypto.randomBytes(12).toString('base64url')
    const ts = now()
    const expiresAt = kind === 'session' ? ts + SESSION_TTL_MS : null
    stmt.insertToken.run(id, Number(userId), kind, String(name || '').slice(0, 80), String(platform || '').slice(0, 40), sha256(raw), ts, String(ip || ''), expiresAt)
    return { token: raw, id, kind, expiresAt }
  }

  function resolveToken(raw, { ip = '' } = {}) {
    const value = String(raw || '')
    if (!value.startsWith(TOKEN_PREFIX) || value.length > 200) return null
    const row = stmt.tokenByHash.get(sha256(value))
    if (!row || row.revoked_at || row.disabled) return null
    const ts = now()
    if (row.expires_at && row.expires_at < ts) return null
    const last = lastTouch.get(row.token_id) || 0
    if (ts - last > TOUCH_INTERVAL_MS) {
      lastTouch.set(row.token_id, ts)
      stmt.touchToken.run(ts, String(ip || ''), row.token_id)
    }
    return { user: publicUser(row), token: { id: row.token_id, kind: row.kind, name: row.token_name } }
  }

  function revokeToken(tokenId, { userId = null } = {}) {
    if (userId != null) {
      const owned = db.prepare('SELECT 1 FROM tokens WHERE id = ? AND user_id = ?').get(String(tokenId), Number(userId))
      if (!owned) throw new PlayerAuthError('TOKEN_NOT_FOUND', 'Device not found.', 404)
    }
    lastTouch.delete(String(tokenId))
    return stmt.revokeToken.run(now(), String(tokenId)).changes > 0
  }

  function listTokens(userId) {
    return stmt.listTokens.all(Number(userId), now()).map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      platform: row.platform,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      lastIp: row.last_ip,
      expiresAt: row.expires_at
    }))
  }

  function createPairingCode(userId) {
    let code = ''
    for (let i = 0; i < 8; i++) code += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)]
    const ts = now()
    stmt.insertPairing.run(sha256(code), Number(userId), ts, ts + PAIRING_TTL_MS)
    return { code, expiresAt: ts + PAIRING_TTL_MS }
  }

  // Lets the page that shows a pairing QR notice when the phone used it.
  // Only the code's owner learns anything about it.
  function pairingStatus(code, userId) {
    const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const row = normalized.length === 8 ? stmt.pairingByHash.get(sha256(normalized)) : null
    if (!row || row.user_id !== Number(userId)) return null
    return { used: Boolean(row.used_at), expired: !row.used_at && row.expires_at < now() }
  }

  // kind 'device' (apps, no expiry) or 'session' (a browser opened from the QR).
  function redeemPairingCode(code, { name = '', platform = '', ip = '', kind = 'device' } = {}) {
    const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (normalized.length !== 8) throw new PlayerAuthError('INVALID_PAIRING_CODE', 'Invalid or expired pairing code.', 401)
    const hash = sha256(normalized)
    return transaction(db, () => {
      const row = stmt.pairingByHash.get(hash)
      if (!row || row.used_at || row.expires_at < now()) {
        throw new PlayerAuthError('INVALID_PAIRING_CODE', 'Invalid or expired pairing code.', 401)
      }
      const user = stmt.userById.get(row.user_id)
      if (!user || user.disabled) throw new PlayerAuthError('INVALID_PAIRING_CODE', 'Invalid or expired pairing code.', 401)
      stmt.usePairing.run(now(), hash)
      const issued = issueToken(user.id, { kind: kind === 'session' ? 'session' : 'device', name: name || 'Device', platform, ip })
      return { ...issued, user: publicUser(user) }
    })
  }

  function purgeExpired() {
    const ts = now()
    stmt.purgeTokens.run(ts - 7 * 24 * 60 * 60 * 1000, ts)
    stmt.purgePairing.run(ts)
  }

  return {
    hasUsers,
    getUserDetails,
    createUser,
    updateUser,
    deleteUser,
    listUsers,
    getUser,
    verifyCredentials,
    issueToken,
    resolveToken,
    revokeToken,
    listTokens,
    createPairingCode,
    pairingStatus,
    redeemPairingCode,
    purgeExpired
  }
}

export function readPlayerTokenFromRequest(req) {
  const header = String(req.get?.('authorization') || '')
  if (header.startsWith('Bearer ')) {
    const value = header.slice(7).trim()
    if (value.startsWith(TOKEN_PREFIX)) return value
  }
  return parseCookieHeader(req.get?.('cookie') || '').get(PLAYER_SESSION_COOKIE) || null
}
