// Moves finished player downloads from the Gharmonize download folder into
// the player's own download folder (used while the Gharmonize download library
// is switched off). The download core itself is untouched: it always writes to
// its output folder, and the bridge moves the result afterwards.

import fs from 'node:fs'
import path from 'node:path'
import { isSameOrInside } from './folderPath.js'

// Files that travel with a song (same name, different extension).
const SIDECAR_EXTENSIONS = ['.lrc']
// Folder artwork is copied (other songs of the album may still use it).
const FOLDER_ART = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png']

async function exists(file) {
  try { await fs.promises.access(file); return true } catch { return false }
}

async function move(from, to) {
  await fs.promises.mkdir(path.dirname(to), { recursive: true })
  try {
    await fs.promises.rename(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    // Different drive / volume: copy, then remove the original.
    await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL)
    await fs.promises.unlink(from)
  }
}

// "Song.mp3" -> "Song (2).mp3" … for a name that is already taken.
async function freeName(target) {
  if (!await exists(target)) return target
  const { dir, name, ext } = path.parse(target)
  for (let n = 2; n < 1000; n += 1) {
    const candidate = path.join(dir, `${name} (${n})${ext}`)
    if (!await exists(candidate)) return candidate
  }
  throw new Error('No free file name in the download folder.')
}

async function sameSize(a, b) {
  try {
    const [x, y] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)])
    return x.size === y.size
  } catch { return false }
}

// Save this plan before moving audio so indexing can resume with the same file.
export async function planUpgradeOutput(output, { dir, sourceRoot }) {
  const source = await fs.promises.realpath(output)
  const root = await fs.promises.realpath(sourceRoot)
  if (!isSameOrInside(source, root)) throw new Error('The output is outside the download folder.')
  const stat = await fs.promises.stat(source)
  if (!stat.isFile()) throw new Error('The output is not an audio file.')
  const file = path.dirname(source) === dir ? source : await freeName(path.join(dir, path.basename(source)))
  return { source, file, size: stat.size }
}

async function syncFile(file) {
  const handle = await fs.promises.open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}

export async function placeUpgradeOutput(plan, { dir, sourceRoot }, id, logger) {
  const { source, file, size } = plan
  if (path.dirname(file) !== dir || !isSameOrInside(source, sourceRoot)) {
    throw new Error('The upgrade folder changed while downloading.')
  }
  if (source === file) return file

  const staging = path.join(dir, `.gharmonize-${id}.partial`)
  try {
    if (!await exists(file)) {
      await fs.promises.copyFile(source, staging)
      await syncFile(staging)
      try {
        await fs.promises.link(staging, file)
      } catch (error) {
        if (!['ENOTSUP', 'ENOSYS', 'EPERM'].includes(error.code)) throw error
        await fs.promises.copyFile(staging, file, fs.constants.COPYFILE_EXCL)
        await syncFile(file)
      }
    }
    const placed = await fs.promises.lstat(file)
    if (!placed.isFile() || placed.size !== size) throw new Error('The placed audio file is incomplete.')
    const sourceInfo = path.parse(source)
    const targetInfo = path.parse(file)
    const copySidecar = async (from, to) => {
      try { await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL) } catch (error) {
        if (!['ENOENT', 'EEXIST'].includes(error.code)) logger.warn?.(`⚠️ [player] could not copy ${path.basename(from)}: ${error.message}`)
      }
    }
    for (const ext of SIDECAR_EXTENSIONS) {
      await copySidecar(path.join(sourceInfo.dir, sourceInfo.name + ext), path.join(dir, targetInfo.name + ext))
    }
    for (const art of FOLDER_ART) await copySidecar(path.join(sourceInfo.dir, art), path.join(dir, art))
    // Retain the core output until the placement is recoverable.
    if (process.platform !== 'win32') {
      const folder = await fs.promises.open(dir, 'r')
      try { await folder.sync() } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error
      } finally { await folder.close() }
    }
    await fs.promises.unlink(source).catch((error) => { if (error.code !== 'ENOENT') throw error })
    return file
  } finally {
    await fs.promises.unlink(staging).catch(() => {})
  }
}

/**
 * Moves `files` (absolute paths under `sourceRoot`) to the same relative
 * place under `targetDir`. Returns Map(originalPath -> newPath). Files outside
 * the source root keep only their file name.
 */
export async function relocateDownloads(files, { sourceRoot, targetDir, logger = console } = {}) {
  const moved = new Map()
  // source folder -> folders its songs were moved to
  const sourceDirs = new Map()
  const root = await fs.promises.realpath(sourceRoot).catch(() => path.resolve(sourceRoot))
  for (const original of files) {
    let real
    try { real = await fs.promises.realpath(original) } catch { continue }
    let rel = path.relative(root, real)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) rel = path.basename(real)
    let target = path.resolve(targetDir, rel)
    if (!isSameOrInside(target, targetDir)) target = path.join(targetDir, path.basename(real))
    // The same song downloaded again: keep the existing copy.
    if (await exists(target) && await sameSize(real, target)) {
      await fs.promises.unlink(real).catch(() => {})
    } else {
      target = await freeName(target)
      await move(real, target)
    }
    moved.set(original, target)
    const targets = sourceDirs.get(path.dirname(real)) || new Set()
    targets.add(path.dirname(target))
    sourceDirs.set(path.dirname(real), targets)

    const stem = path.join(path.dirname(real), path.parse(real).name)
    const targetStem = path.join(path.dirname(target), path.parse(target).name)
    for (const ext of SIDECAR_EXTENSIONS) {
      if (!await exists(stem + ext)) continue
      try {
        if (await exists(targetStem + ext)) await fs.promises.unlink(stem + ext)
        else await move(stem + ext, targetStem + ext)
      } catch (error) { logger.warn?.(`⚠️ [player] could not move ${path.basename(stem + ext)}: ${error?.message || error}`) }
    }
  }

  for (const [dir, targets] of sourceDirs) {
    // Copy folder artwork next to the moved songs.
    for (const art of FOLDER_ART) {
      const from = path.join(dir, art)
      if (!await exists(from)) continue
      for (const targetFolder of targets) {
        const to = path.join(targetFolder, art)
        if (!await exists(to)) await fs.promises.copyFile(from, to).catch(() => {})
      }
    }
    // Remove folders left empty below the source root (never the root itself).
    let current = dir
    while (isSameOrInside(current, root) && current !== root) {
      try { await fs.promises.rmdir(current) } catch { break }
      current = path.dirname(current)
    }
  }
  return moved
}
