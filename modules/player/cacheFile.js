// Cache files that survive a power cut or crash. Without fsync a file can
// be renamed into place before its bytes reach the disk; after a sudden
// stop it is left empty, and an "it exists" check would then serve that
// empty file for good (seen as covers that never show).

import fs from 'node:fs'

/** Flushes a written file to the disk. */
export async function syncFile(file) {
  const handle = await fs.promises.open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}

/** Writes `data` to `tmp`, flushes it, then moves it to `file`. */
export async function writeFileDurable(file, tmp, data) {
  const handle = await fs.promises.open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.promises.rename(tmp, file)
}

/**
 * True when a cache file exists and has content. An empty one (left by a
 * crash) is removed so it is made again.
 */
export function usableCacheFile(file) {
  let st
  try { st = fs.statSync(file) } catch { return false }
  if (st.isFile() && st.size > 0) return true
  try { fs.rmSync(file, { force: true }) } catch {}
  return false
}
