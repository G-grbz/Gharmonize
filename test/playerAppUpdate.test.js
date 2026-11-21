import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from './fixtures/playerAudio.mjs'
import { openPlayerDatabase } from '../modules/player/db.js'
import { createAppUpdateWatch, isNewerVersion } from '../modules/player/appUpdate.js'

const quiet = { log() {}, debug() {}, warn() {} }

async function setup(t) {
  const root = tmpDir('app-update')
  const db = await openPlayerDatabase(path.join(root, 'data'))
  const user = db.prepare('INSERT INTO users (username, display_name, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)')
  const admin = Number(user.run('admin', 'Admin', 'x', 'admin', 0).lastInsertRowid)
  const listener = Number(user.run('listener', 'Listener', 'x', 'user', 0).lastInsertRowid)
  const retired = Number(user.run('old-admin', 'Old', 'x', 'admin', 1).lastInsertRowid)
  t.after(() => { try { db.close() } catch {} fs.rmSync(root, { recursive: true, force: true }) })
  const notes = (id) => db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id').all(id)
  return { db, admin, listener, retired, notes }
}

function github(calls, release) {
  return async (url) => {
    calls.push(url)
    if (release instanceof Error) throw release
    return { ok: true, status: 200, json: async () => release }
  }
}

test('versions compare numerically', () => {
  assert.equal(isNewerVersion('2.0.10', '2.0.9'), true)
  assert.equal(isNewerVersion('v2.1.0', '2.0.99'), true)
  assert.equal(isNewerVersion('2.0.1', '2.0.1'), false)
  assert.equal(isNewerVersion('2.0.0', '2.0.1'), false)
})

test('a new release is announced once, to active administrators only', async (t) => {
  const { db, admin, listener, retired, notes } = await setup(t)
  const calls = []
  let clock = 1_000_000
  const release = { tag_name: 'v2.1.0', html_url: 'https://github.com/G-grbz/Gharmonize/releases/tag/v2.1.0' }
  const watch = createAppUpdateWatch({ db, currentVersion: '2.0.1', fetchImpl: github(calls, release), now: () => clock, logger: quiet })

  const status = await watch.check()
  assert.equal(status.available, true)
  assert.equal(status.latest, '2.1.0')
  const [note] = notes(admin)
  assert.equal(note.kind, 'app-update')
  assert.equal(note.title, 'Gharmonize v2.1.0')
  assert.equal(note.link, release.html_url)
  assert.equal(JSON.parse(note.data).version, '2.1.0')
  assert.deepEqual(notes(listener), [], 'listeners are not told')
  assert.deepEqual(notes(retired), [], 'disabled administrators are not told')

  // GitHub is asked once a day; the same version is never announced twice.
  await watch.check()
  assert.equal(calls.length, 1)
  clock += 25 * 60 * 60 * 1000
  await watch.check()
  assert.equal(calls.length, 2)
  assert.equal(notes(admin).length, 1)
})

test('after updating, the old notice is read; failures and odd answers announce nothing', async (t) => {
  const { db, admin, notes } = await setup(t)
  const release = { tag_name: 'v2.1.0', html_url: 'https://evil.example/x' }
  await createAppUpdateWatch({ db, currentVersion: '2.0.1', fetchImpl: github([], release), logger: quiet }).check()
  assert.equal(notes(admin)[0].link, 'https://github.com/G-grbz/Gharmonize/releases/tag/v2.1.0', 'only GitHub release pages are linked')

  // Running the announced version now: the notice no longer counts as new.
  await createAppUpdateWatch({ db, currentVersion: '2.1.0', fetchImpl: github([], release), logger: quiet }).check()
  assert.ok(notes(admin)[0].read_at)
  assert.equal(notes(admin).length, 1)

  const { db: db2, admin: admin2, notes: notes2 } = await setup(t)
  await createAppUpdateWatch({ db: db2, currentVersion: '2.0.1', fetchImpl: github([], new Error('offline')), logger: quiet }).check()
  await createAppUpdateWatch({ db: db2, currentVersion: '2.0.1', fetchImpl: github([], { tag_name: 'nightly' }), logger: quiet }).check({ force: true })
  assert.deepEqual(notes2(admin2), [])
})
