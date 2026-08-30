import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const DIRECT_WRITE_PARENT_ERRORS = new Set(['EROFS', 'EACCES', 'EPERM'])

export function writeEnvFileSync(targetPath, contents, { fsImpl = fs } = {}) {
  const envDir = path.dirname(targetPath)
  fsImpl.mkdirSync(envDir, { recursive: true, mode: 0o700 })
  const tmpPath = path.join(envDir, `.gharmonize-env.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  let tmpCreated = false

  try {
    try {
      fsImpl.writeFileSync(tmpPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      tmpCreated = true
    } catch (error) {
      if (!DIRECT_WRITE_PARENT_ERRORS.has(error?.code)) throw error

      // A read-only container root (or a non-writable parent directory) can
      // prevent creation of a sibling temp file even when targetPath itself is
      // a writable single-file bind mount. In that case write through the
      // mounted file directly. If the target is not writable either, this call
      // still fails normally and the real filesystem error is preserved.
      fsImpl.writeFileSync(targetPath, contents, { encoding: 'utf8' })
      try { fsImpl.chmodSync(targetPath, 0o600) } catch {}
      return
    }

    try {
      fsImpl.renameSync(tmpPath, targetPath)
    } catch (error) {
      if (error?.code !== 'EBUSY') throw error

      // Docker/Podman single-file bind mounts cannot be replaced with rename(2).
      // The mount target itself can still be writable, so update its contents in
      // place. Ordinary files retain the atomic temp-file + rename path above.
      fsImpl.writeFileSync(targetPath, contents, { encoding: 'utf8' })
    }
    try { fsImpl.chmodSync(targetPath, 0o600) } catch {}
  } finally {
    if (tmpCreated) {
      try { fsImpl.rmSync(tmpPath, { force: true }) } catch {}
    }
  }
}
