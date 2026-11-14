import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpDir } from './fixtures/playerAudio.mjs'
import { createLyricsService } from '../modules/player/lyrics.js'
import { createPlayerApp } from '../modules/player/listener.js'
import { createAuthStore } from '../modules/player/auth.js'
import { openPlayerDatabase } from '../modules/player/db.js'

test('pairing codes sample each character with bounded crypto.randomInt', async (t) => {
  const db = await openPlayerDatabase(null, { fileName: ':memory:' })
  t.after(() => db.close())
  const auth = createAuthStore(db)
  const user = auth.createUser({ username: 'owner', password: 'Password123', role: 'admin' })
  const calls = []
  t.mock.method(crypto, 'randomInt', (max) => { calls.push(max); return calls.length % 2 ? 0 : max - 1 })
  const { code } = auth.createPairingCode(user.id)
  assert.equal(code, 'A9A9A9A9')
  assert.equal(calls.length, 8)
  assert.ok(calls.every((max) => max === 32))
  assert.equal(auth.redeemPairingCode(code).user.id, user.id)
})

test('queued Deezer work finishes in a process with no other active handles', () => {
  const output = execFileSync(process.execPath, ['test/fixtures/playerDeezerQueue.mjs'], { encoding: 'utf8', timeout: 5000 })
  assert.match(output, /DEEZER_QUEUE_COMPLETE/)
})

test('player static files are rate limited without consuming the API streaming budget', async (t) => {
  const app = createPlayerApp({ handle: (_req, res) => res.json({ ok: true }), assetLimit: 2 })
  const server = app.listen(0, '127.0.0.1')
  t.after(() => { server.closeAllConnections(); server.close() })
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  for (let i = 0; i < 2; i++) assert.equal((await fetch(`${base}/i18n.js`)).status, 200)
  const blocked = await fetch(`${base}/src/logo.png`)
  assert.equal(blocked.status, 429)
  assert.ok(blocked.headers.get('retry-after'))
  assert.equal((await fetch(`${base}/api/player/status`)).status, 200)
})

test('lyrics read the inspected descriptor even when its pathname is replaced', async (t) => {
  const root = tmpDir('lyrics-race')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const audio = path.join(root, 'song.mp3')
  const sidecar = path.join(root, 'song.lrc')
  fs.writeFileSync(sidecar, '[00:01]Original lyrics')
  const open = fs.promises.open.bind(fs.promises)
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args)
    if (args[0] === sidecar) {
      const stat = handle.stat.bind(handle)
      handle.stat = async () => {
        const info = await stat()
        fs.renameSync(sidecar, `${sidecar}.original`)
        fs.writeFileSync(sidecar, '[00:01]Replacement lyrics')
        return info
      }
    }
    return handle
  })
  const lyrics = createLyricsService({ libraries: { resolveTrackFile: () => audio }, getOnlineAllowed: () => false })
  const found = await lyrics.getLyrics({ id: 1, mtime_ms: 1 })
  assert.equal(found.lines[0].text, 'Original lyrics')
})

test('lyrics enforce the byte cap even if a sidecar grows after inspection', async (t) => {
  const root = tmpDir('lyrics-growth')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sidecar = path.join(root, 'song.lrc')
  fs.writeFileSync(sidecar, '[00:01]Small')
  fs.writeFileSync(path.join(root, 'song.txt'), 'Bounded fallback')
  const open = fs.promises.open.bind(fs.promises)
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args)
    if (args[0] === sidecar) {
      const stat = handle.stat.bind(handle)
      handle.stat = async () => { const info = await stat(); fs.appendFileSync(sidecar, Buffer.alloc(512 * 1024, 65)); return info }
    }
    return handle
  })
  const lyrics = createLyricsService({ libraries: { resolveTrackFile: () => path.join(root, 'song.mp3') }, getOnlineAllowed: () => false })
  const found = await lyrics.getLyrics({ id: 1, mtime_ms: 1 })
  assert.equal(found.plain, 'Bounded fallback')
})
