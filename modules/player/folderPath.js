// Folder paths typed by an administrator (library folders, the player download
// folder) are never handed to the file system as typed. The path is rebuilt
// from the server's own directory listings, one segment at a time: every
// segment must match an entry that readdir returned for its parent, and the
// resulting path consists only of those listed names plus a fixed root. Only
// that rebuilt path is used for realpath/stat/access and later file work.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DRIVE_ROOTS = Object.freeze('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\`))
const POSIX_ROOT = '/'

export class FolderPathError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * Returns the existing folder named by `input` as a path built from directory
 * listings, or throws FolderPathError. Symbolic links are resolved afterwards.
 */
export function canonicalExistingFolder(input, { platform = process.platform, fsApi = fs } = {}) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new FolderPathError('FOLDER_PATH_REQUIRED', 'A folder path is required.')
  if (raw.includes('\0') || raw.length > 4096) throw new FolderPathError('FOLDER_PATH_INVALID', 'Invalid folder path.')
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (!pathApi.isAbsolute(raw)) throw new FolderPathError('FOLDER_PATH_NOT_ABSOLUTE', 'The folder path must be absolute.')
  const normalized = pathApi.resolve(raw)
  const parsed = pathApi.parse(normalized)

  let current
  if (platform === 'win32') {
    const letter = /^([a-z]):\\$/i.exec(parsed.root)?.[1]
    // Network shares (\\server\share) are not supported; map them to a drive letter.
    current = letter ? DRIVE_ROOTS.find((root) => root[0] === letter.toUpperCase()) : null
    if (!current) throw new FolderPathError('FOLDER_PATH_INVALID', 'Use a folder on a drive letter (for example D:\\Music).')
  } else {
    current = POSIX_ROOT
  }

  const caseInsensitive = platform === 'win32' || platform === 'darwin'
  const segments = normalized.slice(parsed.root.length).split(pathApi.sep).filter(Boolean)
  for (const segment of segments) {
    let entries
    try { entries = fsApi.readdirSync(current, { withFileTypes: true }) } catch {
      throw new FolderPathError('FOLDER_PATH_NOT_FOUND', 'The folder does not exist or one of its parent folders cannot be opened.', 404)
    }
    const folders = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    const match = folders.find((entry) => entry.name === segment)
      || (caseInsensitive ? folders.find((entry) => entry.name.toLowerCase() === segment.toLowerCase()) : null)
    if (!match) {
      if (entries.some((entry) => entry.name === segment)) throw new FolderPathError('FOLDER_PATH_NOT_DIRECTORY', 'The path is not a folder.')
      throw new FolderPathError('FOLDER_PATH_NOT_FOUND', 'The folder does not exist or is not reachable.', 404)
    }
    current = pathApi.join(current, match.name)
  }

  let real
  try { real = fsApi.realpathSync(current) } catch {
    throw new FolderPathError('FOLDER_PATH_NOT_FOUND', 'The folder does not exist or is not reachable.', 404)
  }
  let st
  try { st = fsApi.statSync(real) } catch {
    throw new FolderPathError('FOLDER_PATH_NOT_FOUND', 'The folder does not exist or is not reachable.', 404)
  }
  if (!st.isDirectory()) throw new FolderPathError('FOLDER_PATH_NOT_DIRECTORY', 'The path is not a folder.')
  return real
}

/** Throws unless Gharmonize can list and read the folder. */
export function assertReadableFolder(dir, { fsApi = fs } = {}) {
  try { fsApi.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK) } catch {
    throw new FolderPathError('FOLDER_NOT_READABLE', 'Gharmonize cannot read this folder.', 403)
  }
}

/**
 * Throws unless Gharmonize can create (and remove) files in the folder. A real
 * test file is written because access() is unreliable with Windows ACLs and
 * read-only mounts.
 */
export function assertWritableFolder(dir, { fsApi = fs } = {}) {
  try { fsApi.accessSync(dir, fs.constants.W_OK) } catch {
    throw new FolderPathError('FOLDER_NOT_WRITABLE', 'Gharmonize cannot write to this folder.', 403)
  }
  const probe = path.join(dir, `.gharmonize-write-test-${crypto.randomBytes(6).toString('hex')}`)
  try {
    fsApi.writeFileSync(probe, '', { flag: 'wx' })
  } catch {
    throw new FolderPathError('FOLDER_NOT_WRITABLE', 'Gharmonize cannot write to this folder.', 403)
  } finally {
    try { fsApi.unlinkSync(probe) } catch {}
  }
}

export function isSameOrInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
