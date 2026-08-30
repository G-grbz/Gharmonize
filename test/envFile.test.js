import test from 'node:test'
import assert from 'node:assert/strict'
import { writeEnvFileSync } from '../modules/envFile.js'

function fakeFs({ renameError = null, firstWriteError = null } = {}) {
  const calls = []
  let writes = 0
  return {
    calls,
    mkdirSync(...args) { calls.push(['mkdirSync', ...args]) },
    writeFileSync(...args) {
      calls.push(['writeFileSync', ...args])
      writes += 1
      if (writes === 1 && firstWriteError) throw firstWriteError
    },
    renameSync(...args) {
      calls.push(['renameSync', ...args])
      if (renameError) throw renameError
    },
    chmodSync(...args) { calls.push(['chmodSync', ...args]) },
    rmSync(...args) { calls.push(['rmSync', ...args]) }
  }
}

test('env writer keeps atomic rename for ordinary files', () => {
  const fsImpl = fakeFs()
  writeEnvFileSync('/data/.env', 'A=1\n', { fsImpl })

  const writes = fsImpl.calls.filter(([name]) => name === 'writeFileSync')
  assert.equal(writes.length, 1)
  assert.match(writes[0][1], /^\/data\/\.gharmonize-env\./)
  assert.equal(writes[0][2], 'A=1\n')
  assert.deepEqual(fsImpl.calls.find(([name]) => name === 'renameSync')?.slice(2), ['/data/.env'])
  assert.equal(fsImpl.calls.some(([name]) => name === 'rmSync'), true)
})

test('env writer falls back to in-place write when rename hits a single-file bind mount', () => {
  const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' })
  const fsImpl = fakeFs({ renameError: busy })
  writeEnvFileSync('/usr/src/app/.env', 'ADMIN_PASSWORD_HASH=scrypt\n', { fsImpl })

  const writes = fsImpl.calls.filter(([name]) => name === 'writeFileSync')
  assert.equal(writes.length, 2)
  assert.equal(writes[1][1], '/usr/src/app/.env')
  assert.equal(writes[1][2], 'ADMIN_PASSWORD_HASH=scrypt\n')
  assert.deepEqual(writes[1][3], { encoding: 'utf8' })
  assert.equal(fsImpl.calls.some(([name]) => name === 'rmSync'), true)
})

test('env writer falls back to the mounted file when read-only root blocks temp creation', () => {
  const readOnly = Object.assign(new Error('read-only file system'), { code: 'EROFS' })
  const fsImpl = fakeFs({ firstWriteError: readOnly })
  writeEnvFileSync('/usr/src/app/.env', 'ADMIN_PASSWORD_HASH=scrypt\n', { fsImpl })

  const writes = fsImpl.calls.filter(([name]) => name === 'writeFileSync')
  assert.equal(writes.length, 2)
  assert.match(writes[0][1], /^\/usr\/src\/app\/\.gharmonize-env\./)
  assert.equal(writes[1][1], '/usr/src/app/.env')
  assert.equal(writes[1][2], 'ADMIN_PASSWORD_HASH=scrypt\n')
  assert.equal(fsImpl.calls.some(([name]) => name === 'renameSync'), false)
  assert.equal(fsImpl.calls.some(([name]) => name === 'rmSync'), false)
})

test('env writer does not hide unrelated temp-file failures', () => {
  const noSpace = Object.assign(new Error('no space left'), { code: 'ENOSPC' })
  const fsImpl = fakeFs({ firstWriteError: noSpace })

  assert.throws(
    () => writeEnvFileSync('/data/.env', 'A=1\n', { fsImpl }),
    error => error === noSpace
  )
  assert.equal(fsImpl.calls.filter(([name]) => name === 'writeFileSync').length, 1)
  assert.equal(fsImpl.calls.some(([name]) => name === 'renameSync'), false)
})

test('env writer does not hide unrelated rename failures', () => {
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  const fsImpl = fakeFs({ renameError: denied })

  assert.throws(
    () => writeEnvFileSync('/data/.env', 'A=1\n', { fsImpl }),
    error => error === denied
  )
  assert.equal(fsImpl.calls.filter(([name]) => name === 'writeFileSync').length, 1)
  assert.equal(fsImpl.calls.some(([name]) => name === 'rmSync'), true)
})
