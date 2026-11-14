import test from 'node:test'
import assert from 'node:assert/strict'
import { randomIndex, shuffleInPlace } from '../public/player/js/random.js'

// The DOM module registers menu listeners on import; no DOM is needed by the
// URL/code helpers under test. Keep those listeners on isolated EventTargets.
const previousDocument = globalThis.document
const previousWindow = globalThis.window
let cardArtworkUrl, pairCodeFromHash, pairLink
try {
  globalThis.document = new EventTarget()
  globalThis.window = new EventTarget()
  ;({ cardArtworkUrl } = await import('../public/player/js/dom.js'))
  ;({ pairCodeFromHash, pairLink } = await import('../public/player/js/pairing.js'))
} finally {
  if (previousDocument === undefined) delete globalThis.document
  else globalThis.document = previousDocument
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
}

test('browser random indices reject the incomplete bucket and stay in bounds', (t) => {
  const samples = [0xffffffff, 0, 1431655764, 1431655765, 2863311530, 4294967294]
  let calls = 0
  t.mock.method(globalThis.crypto, 'getRandomValues', (values) => { calls++; values[0] = samples.shift(); return values })
  assert.deepEqual(Array.from({ length: 5 }, () => randomIndex(3)), [0, 0, 1, 2, 2])
  assert.equal(calls, 6, 'the upper partial bucket is resampled')
  assert.equal(samples.length, 0)
  for (const size of [0, -1, 1.5, NaN, Infinity, 0x100000001]) assert.throws(() => randomIndex(size), RangeError)
})

test('browser random indices cover the single-item and full uint32 ranges', (t) => {
  t.mock.method(globalThis.crypto, 'getRandomValues', (values) => { values[0] = 0xffffffff; return values })
  assert.equal(randomIndex(1), 0)
  assert.equal(randomIndex(0x100000000), 0xffffffff)
})

test('browser shuffle preserves every queue entry, including empty and single-item queues', (t) => {
  t.mock.method(globalThis.crypto, 'getRandomValues', (values) => { values[0] = 0; return values })
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
  const shuffled = items.slice()
  assert.equal(shuffleInPlace(shuffled), shuffled)
  assert.deepEqual(shuffled, [items[1], items[2], items[3], items[0]])
  assert.deepEqual(new Set(shuffled), new Set(items))
  assert.deepEqual(shuffleInPlace([]), [])
  assert.deepEqual(shuffleInPlace([items[0]]), [items[0]])
})

test('cover resizing parses the CDN hostname and only changes image paths', () => {
  const source = 'https://cdn-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg?alt=/800x800-keep'
  assert.equal(cardArtworkUrl(source), 'https://cdn-images.dzcdn.net/images/cover/abc/500x500-000000-80-0-0.jpg?alt=/800x800-keep')
  for (const src of [
    'https://evil.example/.dzcdn.net/1000x1000-image.jpg',
    'https://cdn.dzcdn.net.evil.example/1000x1000-image.jpg',
    'https://cdn.dzcdn.net@evil.example/1000x1000-image.jpg',
    'https://evildzcdn.net/1000x1000-image.jpg',
    'http://cdn.dzcdn.net/1000x1000-image.jpg',
    '/api/player/artwork/track/42?size=256', null
  ]) assert.equal(cardArtworkUrl(src), src)
})

test('pairing links accept exactly one complete code without silently truncating input', () => {
  const code = 'ABCD2349'
  assert.equal(pairCodeFromHash(new URL(pairLink('https://music.example', code)).hash), code)
  assert.equal(pairCodeFromHash('#/pair?code=abcd-2349'), code)
  for (const hash of [
    '#/home?code=ABCD2349', '#/pair?code=ABCD234', '#/pair?code=ABCD2349extra',
    '#/pair?code=ABCD!2349', '#/pair?code=ABCD1234', '#/pair?code=ABCDIO23', '#/pair?', ''
  ]) assert.equal(pairCodeFromHash(hash), null, hash)
})
