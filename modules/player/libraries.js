import fs from 'node:fs'
import { NOT_LINKED_ARTIST_SQL } from './artistCredits.js'
import path from 'node:path'
import { transaction, getSetting, setSetting } from './db.js'
import { canonicalExistingFolder, assertReadableFolder, assertWritableFolder, FolderPathError } from './folderPath.js'

export class LibraryError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

// Directories that must never be indexed as a music library.
const FORBIDDEN_TREES = ['/proc', '/sys', '/dev', '/etc', '/boot', '/bin', '/sbin', '/usr', '/lib', '/lib32', '/lib64', '/var/lib', '/root']

// Typed folder -> canonical folder rebuilt from directory listings (see
// folderPath.js), readable and outside system trees.
export function validateLibraryPath(rawPath, { platform = process.platform } = {}) {
  let real
  try {
    real = canonicalExistingFolder(rawPath, { platform })
    assertReadableFolder(real)
  } catch (error) {
    if (error instanceof FolderPathError) throw new LibraryError(libraryCode(error.code), error.message, error.status)
    throw error
  }
  if (platform !== 'win32') {
    const forbidden = real === '/'
      || FORBIDDEN_TREES.some((root) => isSameOrInside(real, root))
      // /run is runtime state, except removable media mounted below /run/media.
      || (isSameOrInside(real, '/run') && !isSameOrInside(real, '/run/media'))
    if (forbidden) throw new LibraryError('LIBRARY_PATH_FORBIDDEN', 'System folders cannot be used as a music library.', 403)
  } else if (/^[a-z]:\\?$/i.test(real)) {
    throw new LibraryError('LIBRARY_PATH_FORBIDDEN', 'A whole drive root cannot be used as a music library.', 403)
  }
  return real
}

// FOLDER_PATH_NOT_FOUND -> LIBRARY_PATH_NOT_FOUND, FOLDER_NOT_READABLE -> LIBRARY_PATH_NOT_READABLE …
function libraryCode(code) {
  return String(code).replace(/^FOLDER_(PATH_)?/, 'LIBRARY_PATH_')
}

function isSameOrInside(a, b) {
  const rel = path.relative(b, a)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function publicLibrary(row) {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    enabled: Boolean(row.enabled),
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    lastScanAt: row.last_scan_at,
    lastScanStatus: row.last_scan_status,
    lastScanError: row.last_scan_error,
    trackCount: row.track_count
  }
}

export function createLibraryStore(db, { defaultLibraryDir, now = () => Date.now() } = {}) {
  const stmt = {
    list: db.prepare('SELECT * FROM libraries ORDER BY is_default DESC, name COLLATE NOCASE'),
    byId: db.prepare('SELECT * FROM libraries WHERE id = ?'),
    defaultLib: db.prepare('SELECT * FROM libraries WHERE is_default = 1'),
    insert: db.prepare('INSERT INTO libraries (name, path, enabled, is_default, created_at) VALUES (?, ?, ?, ?, ?)')
  }

  // The Gharmonize download folder is always the default library. Its path
  // follows DATA_DIR, so it is refreshed on every start.
  function ensureDefaultLibrary() {
    if (!defaultLibraryDir) return null
    try { fs.mkdirSync(defaultLibraryDir, { recursive: true }) } catch {}
    const resolved = (() => { try { return fs.realpathSync(defaultLibraryDir) } catch { return path.resolve(defaultLibraryDir) } })()
    const current = stmt.defaultLib.get()
    if (current) {
      if (current.path !== resolved) {
        const clash = db.prepare('SELECT id FROM libraries WHERE path = ? AND id != ?').get(resolved, current.id)
        if (clash) db.prepare('DELETE FROM libraries WHERE id = ?').run(clash.id)
        db.prepare('UPDATE libraries SET path = ? WHERE id = ?').run(resolved, current.id)
      }
      return publicLibrary(stmt.byId.get(current.id))
    }
    const existing = db.prepare('SELECT id FROM libraries WHERE path = ?').get(resolved)
    if (existing) {
      db.prepare('UPDATE libraries SET is_default = 1 WHERE id = ?').run(existing.id)
      return publicLibrary(stmt.byId.get(existing.id))
    }
    const info = stmt.insert.run('Gharmonize Downloads', resolved, 1, 1, now())
    return publicLibrary(stmt.byId.get(Number(info.lastInsertRowid)))
  }

  function list() {
    return stmt.list.all().map(publicLibrary)
  }

  function get(id) {
    const row = stmt.byId.get(Number(id))
    return row ? publicLibrary(row) : null
  }

  function add({ name, path: rawPath, enabled = true }) {
    const real = validateLibraryPath(rawPath)
    for (const lib of stmt.list.all()) {
      if (isSameOrInside(real, lib.path) || isSameOrInside(lib.path, real)) {
        throw new LibraryError('LIBRARY_OVERLAP', `This folder overlaps with the library "${lib.name}".`, 409)
      }
    }
    const finalName = String(name || '').trim().slice(0, 80) || path.basename(real) || real
    const info = stmt.insert.run(finalName, real, enabled ? 1 : 0, 0, now())
    return get(Number(info.lastInsertRowid))
  }

  function update(id, { name, enabled } = {}) {
    const row = stmt.byId.get(Number(id))
    if (!row) throw new LibraryError('LIBRARY_NOT_FOUND', 'Library not found.', 404)
    const nextName = name !== undefined ? (String(name).trim().slice(0, 80) || row.name) : row.name
    const nextEnabled = enabled !== undefined ? (enabled ? 1 : 0) : row.enabled
    db.prepare('UPDATE libraries SET name = ?, enabled = ? WHERE id = ?').run(nextName, nextEnabled, row.id)
    return get(row.id)
  }

  function remove(id) {
    const row = stmt.byId.get(Number(id))
    if (!row) throw new LibraryError('LIBRARY_NOT_FOUND', 'Library not found.', 404)
    if (row.is_default) throw new LibraryError('LIBRARY_DEFAULT_LOCKED', 'The Gharmonize download library cannot be removed. Disable it instead.', 409)
    transaction(db, () => {
      db.prepare('DELETE FROM tracks_fts WHERE rowid IN (SELECT id FROM tracks WHERE library_id = ?)').run(row.id)
      db.prepare('DELETE FROM libraries WHERE id = ?').run(row.id)
      db.prepare('DELETE FROM albums WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = albums.id)').run()
      db.prepare(`DELETE FROM artists WHERE ${NOT_LINKED_ARTIST_SQL()}`).run()
    })
  }

  // Resolve a track's absolute file path, refusing anything that escapes its
  // library root (defence in depth against a tampered database row).
  function resolveTrackFile(track) {
    const lib = stmt.byId.get(Number(track.library_id))
    if (!lib || !lib.enabled) return null
    const abs = path.resolve(lib.path, track.rel_path)
    if (!isSameOrInside(abs, lib.path)) return null
    return abs
  }

  // ---- player download folder ------------------------------------------------
  // When the Gharmonize download library is switched off, player downloads can
  // go to a folder of the admin's choice instead. That folder is always (part
  // of) an enabled library, so finished downloads can be played.
  const DOWNLOAD_DIR_KEY = 'download_dir'

  function downloadFolder() {
    const dir = String(getSetting(db, DOWNLOAD_DIR_KEY, '') || '')
    const def = stmt.defaultLib.get()
    const library = dir ? stmt.list.all().find((lib) => isSameOrInside(dir, lib.path) && !lib.is_default) : null
    return {
      path: dir || null,
      defaultEnabled: def ? Boolean(def.enabled) : true,
      // Active only while the default library is off.
      active: Boolean(dir && def && !def.enabled),
      library: library ? publicLibrary(library) : null
    }
  }

  function setDownloadFolder(rawPath) {
    const real = validateLibraryPath(rawPath)
    try { assertWritableFolder(real) } catch (error) {
      if (error instanceof FolderPathError) throw new LibraryError('LIBRARY_PATH_NOT_WRITABLE', error.message, error.status)
      throw error
    }
    const def = stmt.defaultLib.get()
    if (def && (isSameOrInside(real, def.path) || isSameOrInside(def.path, real))) {
      throw new LibraryError('DOWNLOAD_DIR_IN_DEFAULT', 'Choose a folder outside the Gharmonize download folder.', 409)
    }
    let library = stmt.list.all().find((lib) => !lib.is_default && isSameOrInside(real, lib.path))
    let created = false
    if (library) {
      if (!library.enabled) db.prepare('UPDATE libraries SET enabled = 1 WHERE id = ?').run(library.id)
    } else {
      library = { id: add({ name: path.basename(real) || 'Player downloads', path: real }).id }
      created = true
    }
    setSetting(db, DOWNLOAD_DIR_KEY, real)
    return { ...downloadFolder(), created, libraryId: library.id }
  }

  function clearDownloadFolder() {
    setSetting(db, DOWNLOAD_DIR_KEY, '')
    return downloadFolder()
  }

  /** { dir, sourceRoot } while downloads must be moved, otherwise null. */
  function downloadTarget() {
    const info = downloadFolder()
    if (!info.active) return null
    const def = stmt.defaultLib.get()
    return { dir: info.path, sourceRoot: def.path }
  }

  function upgradeTarget({ libraryId, folder }, { checkWritable = false } = {}) {
    const lib = stmt.byId.get(Number(libraryId))
    const def = stmt.defaultLib.get()
    if (!lib?.enabled || !def || typeof folder !== 'string') {
      throw new LibraryError('UPGRADE_LIBRARY_UNAVAILABLE', 'The original library is unavailable.', 409)
    }
    const dir = path.resolve(lib.path, folder)
    try {
      if (!isSameOrInside(dir, lib.path) || fs.realpathSync(dir) !== dir || !fs.statSync(dir).isDirectory()) {
        throw new Error('Invalid upgrade folder.')
      }
    } catch {
      throw new LibraryError('UPGRADE_FOLDER_UNAVAILABLE', 'The original folder is unavailable.', 409)
    }
    if (checkWritable) {
      try { assertWritableFolder(dir) } catch (error) {
        throw new LibraryError('LIBRARY_PATH_NOT_WRITABLE', error.message, error.status)
      }
    }
    return { dir, sourceRoot: def.path }
  }

  return { ensureDefaultLibrary, list, get, add, update, remove, resolveTrackFile, downloadFolder, setDownloadFolder, clearDownloadFolder, downloadTarget, upgradeTarget }
}
