import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import NodeID3 from 'node-id3'

export const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
export const silentLogger = { log() {}, warn() {}, error() {}, debug() {} }

// ~1 s of silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz).
export function silentMp3(frames = 40) {
  const frame = Buffer.alloc(417)
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x00
  return Buffer.concat(Array.from({ length: frames }, () => frame))
}

export function age(file, ms = 60_000) {
  const old = new Date(Date.now() - ms)
  fs.utimesSync(file, old, old)
}

export function writeTrack(file, tags, { cover = false, fresh = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const id3 = { ...tags }
  if (cover) id3.image = { mime: 'image/png', type: { id: 3, name: 'front cover' }, description: 'cover', imageBuffer: PNG_1PX }
  fs.writeFileSync(file, NodeID3.write(id3, silentMp3()))
  if (!fresh) age(file)
  return file
}

export function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gh-player-${prefix}-`))
}

export async function waitFor(check, { timeoutMs = 5000, intervalMs = 20, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
