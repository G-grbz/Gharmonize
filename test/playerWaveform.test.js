import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpDir, silentLogger } from './fixtures/playerAudio.mjs'
import { createWaveformService, reduceWindows, WAVEFORM_BINS } from '../modules/player/waveform.js'

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0

test('reduceWindows keeps the loudest window per bin and scales to 0..100', () => {
  assert.deepEqual(reduceWindows([], 4), [0, 0, 0, 0])
  assert.deepEqual(reduceWindows([0, 0, 0, 0], 2), [0, 0])
  const out = reduceWindows([0.1, 0.5, 0.25, 0.25, 0, 0.05], 3)
  assert.equal(out.length, 3)
  assert.equal(out[0], 100)
  assert.ok(out[1] > 0 && out[1] < 100)
  assert.ok(out[2] > 0 && out[2] < out[1])
  // Fewer windows than bins still fills every bin.
  assert.equal(reduceWindows([0.2, 0.4], 6).filter((v) => v > 0).length, 6)
})

test('waveform follows the audio: silence low, tone high, cached on disk', { skip: !HAS_FFMPEG && 'ffmpeg not available' }, async (t) => {
  const root = tmpDir('waveform')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'quiet-loud.wav')
  // 2 s near-silence, then 2 s loud tone.
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-af', "volume='if(lt(t,2),0.01,0.9)':eval=frame", '-y', file])
  assert.equal(made.status, 0)
  const libraries = { resolveTrackFile: () => file }
  const service = createWaveformService({ cacheDir: path.join(root, 'cache'), libraries, logger: silentLogger })
  t.after(() => service.stop())

  const first = await service.getWaveform({ id: 1 })
  assert.equal(first.bins.length, WAVEFORM_BINS)
  const half = WAVEFORM_BINS / 2
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length
  assert.ok(avg(first.bins.slice(0, half - 4)) < 15, 'quiet half stays low')
  assert.ok(avg(first.bins.slice(half + 4)) > 85, 'loud half reaches the top')
  assert.equal(fs.readdirSync(service.dir).filter((f) => f.endsWith('.json')).length, 1)

  const again = await service.getWaveform({ id: 1 })
  assert.deepEqual(again.bins, first.bins)
  assert.equal(await createWaveformService({ cacheDir: path.join(root, 'cache2'), libraries: { resolveTrackFile: () => null }, logger: silentLogger }).getWaveform({ id: 2 }), null)
})
