import test from 'node:test'
import assert from 'node:assert/strict'
import { freshDeezerPreview, previewExpiresAt } from '../modules/player/online.js'

function fakeDeezer(preview) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return { ok: true, json: async () => ({ id: 1, preview }) }
  }
  return { calls, fetchImpl }
}

test('previewExpiresAt reads the signed expiry of a Deezer preview link', () => {
  assert.equal(previewExpiresAt('https://cdnt-preview.dzcdn.net/a.mp3?hdnea=exp=1794614562~acl=/x~hmac=y'), 1794614562000)
  assert.equal(previewExpiresAt('https://example.com/a.mp3'), 0)
})

test('freshDeezerPreview fetches the track and caches the link until shortly before it expires', async () => {
  const now = 1_800_000_000_000
  const link = `https://cdnt-preview.dzcdn.net/a.mp3?hdnea=exp=${now / 1000 + 900}~acl=/x`
  const { calls, fetchImpl } = fakeDeezer(link)
  assert.equal(await freshDeezerPreview('901001', { fetchImpl, now: () => now }), link)
  assert.match(calls[0], /\/track\/901001$/)
  assert.equal(await freshDeezerPreview('901001', { fetchImpl, now: () => now + 60_000 }), link)
  assert.equal(calls.length, 1)
  // Less than a minute left: ask Deezer again.
  await freshDeezerPreview('901001', { fetchImpl, now: () => now + 850_000 })
  assert.equal(calls.length, 2)
})

test('freshDeezerPreview only returns Deezer CDN links and rejects bad ids', async () => {
  const { calls, fetchImpl } = fakeDeezer('https://evil.example/a.mp3')
  assert.equal(await freshDeezerPreview('901002', { fetchImpl }), null)
  assert.equal(await freshDeezerPreview('../track/1', { fetchImpl }), null)
  assert.equal(await freshDeezerPreview('', { fetchImpl }), null)
  assert.equal(calls.length, 1)
})
