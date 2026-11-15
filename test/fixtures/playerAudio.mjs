import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { updateBuffer } from 'music-metadata'

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

function countPair(value) {
  const match = String(value ?? '').trim().match(/^(\d+)(?:\s*\/\s*(\d+))?$/)
  if (!match) return null
  const no = Number(match[1])
  if (!Number.isFinite(no) || no <= 0) return null
  const of = Number(match[2])
  return Number.isFinite(of) && of > 0 ? { no, of } : { no }
}

// Translate the compact fixture tags into a music-metadata patch.
function fixturePatch(tags) {
  const patch = {}
  if (tags.title) patch.title = tags.title
  if (tags.artist) patch.artist = tags.artist
  if (tags.album) patch.album = tags.album
  if (tags.albumartist) patch.albumartist = tags.albumartist
  if (tags.genre) patch.genre = tags.genre
  if (tags.year) patch.date = String(tags.year)
  const track = countPair(tags.trackNumber)
  if (track) patch.track = track
  if (tags.comment) patch.comment = { text: String(tags.comment) }
  const native = {}
  for (const item of tags.userDefinedText || []) native[`TXXX:${item.description}`] = item.value
  for (const item of tags.userDefinedUrl || []) native[`WXXX:${item.description}`] = item.url
  if (Object.keys(native).length) patch.native = native
  return patch
}

export async function writeTrack(file, tags, { cover = false, fresh = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const patch = fixturePatch(tags)
  if (cover) {
    patch.picture = [{
      format: 'image/png',
      type: 'Cover (front)',
      description: 'cover',
      data: cover === true ? PNG_1PX : cover
    }]
  }
  fs.writeFileSync(file, await updateBuffer(silentMp3(), patch))
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
