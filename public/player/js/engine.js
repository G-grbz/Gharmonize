// Playback engine: queue, shuffle/repeat, near-gapless preloading, Media
// Session (lock screen / headset keys), play history, sleep timer, autoplay.

import { app, bus, store } from './app.js'
import { post, get, streamUrl, artworkUrl, absoluteUrl, previewStreamUrl } from './api.js'
import { t, toast } from './dom.js'
import { shuffleInPlace } from './random.js'

let seq = 0
const newUid = () => `q${Date.now().toString(36)}${(seq++).toString(36)}`

// ---- queue item factories ----------------------------------------------------

export function fromTrack(track, extra = {}) {
  if (!track?.id) return null
  return {
    uid: newUid(),
    type: 'library',
    id: Number(track.id),
    title: track.title || t('player.common.unknownTitle'),
    artist: track.artist || '',
    artistId: track.artistId || null,
    album: track.album || '',
    albumId: track.albumId || null,
    duration: Number(track.duration) || 0,
    artwork: track.artwork || (track.albumId ? `album/${track.albumId}` : `track/${track.id}`),
    favorite: Boolean(track.favorite),
    replayGain: track.replayGain || null,
    lossless: Boolean(track.lossless),
    codec: track.codec || null,
    bitrate: track.bitrate || null,
    sampleRate: track.sampleRate || null,
    bitDepth: track.bitDepth || null,
    genre: track.genre || null,
    hasLyrics: Boolean(track.hasLyrics),
    ...extra
  }
}

// Online items play from the library when owned, otherwise as a preview clip.
export function fromOnline(item, extra = {}) {
  if (!item) return null
  if (item.library?.trackId) {
    return fromTrack({ id: item.library.trackId, title: item.title, artist: item.artist, album: item.album, duration: item.duration, artwork: `track/${item.library.trackId}` }, extra)
  }
  if (!item.previewUrl) return null
  return {
    uid: newUid(),
    type: 'preview',
    id: `${item.provider}:${item.id}`,
    title: item.title,
    artist: item.artist || '',
    album: item.album || '',
    duration: 30,
    artworkUrl: item.artworkUrl || null,
    previewUrl: previewStreamUrl(item),
    online: item,
    ...extra
  }
}

export function itemArtwork(item, size = 256) {
  if (!item) return null
  if (item.type === 'preview') return item.artworkUrl
  return artworkUrl(item.artwork, size)
}

function serializeItem(item) {
  const { uid, ...rest } = item
  return rest
}

// ---- engine ----------------------------------------------------------------------

export class Engine {
  constructor() {
    this.a = this.makeAudio()
    this.b = this.makeAudio()
    this.audio = this.a
    this.queue = []
    this.ordered = null
    this.index = -1
    this.shuffle = false
    this.repeat = 'off'
    this.context = null
    this.volume = clamp01(store.get('volume', 0.8))
    this.muted = Boolean(store.get('muted', false))
    this.loading = false
    this.pendingStart = null
    this.errorStreak = 0
    this.retriedOriginal = new Set()
    this.played = { uid: null, seconds: 0, lastPos: null }
    this.sleep = { timer: null, until: null, endOfTrack: false }
    this.userId = null
    this.lastSave = 0
    this.lastPositionState = 0
    this.setupMediaSession()
    window.addEventListener('pagehide', () => { this.flushPlay(false, { beacon: true }); this.save() })
    bus.on('favorite', ({ type, id, favorite }) => {
      if (type !== 'track') return
      let changed = false
      for (const item of this.queue) if (item.type === 'library' && item.id === Number(id)) { item.favorite = favorite; changed = true }
      if (changed) bus.emit('player:track', this.current)
    })
  }

  makeAudio() {
    const audio = new Audio()
    audio.preload = 'auto'
    audio.crossOrigin = null
    audio.addEventListener('timeupdate', () => audio === this.audio && this.onTime())
    audio.addEventListener('play', () => audio === this.audio && this.emitState())
    audio.addEventListener('playing', () => {
      if (audio !== this.audio) return
      this.loading = false
      this.errorStreak = 0
      this.emitState()
      // Chromium (desktop MPRIS / Windows SMTC) only picks up artwork reliably
      // once the session is actually playing: publish it again then.
      if (this.current && this.msPlayingUid !== this.current.uid) {
        this.msPlayingUid = this.current.uid
        this.updateMediaSession()
      }
    })
    audio.addEventListener('pause', () => audio === this.audio && this.emitState())
    audio.addEventListener('waiting', () => { if (audio === this.audio) { this.loading = true; this.emitState() } })
    audio.addEventListener('canplay', () => { if (audio === this.audio) { this.loading = false; this.emitState() } })
    audio.addEventListener('seeking', () => { if (audio === this.audio) this.played.lastPos = null })
    audio.addEventListener('ended', () => audio === this.audio && this.onEnded())
    audio.addEventListener('error', () => audio === this.audio && audio.getAttribute('src') && this.onError())
    audio.addEventListener('loadedmetadata', () => {
      if (audio !== this.audio) return
      if (this.pendingStart != null) {
        const start = this.pendingStart
        this.pendingStart = null
        if (start > 1) try { audio.currentTime = start } catch {}
      }
      this.onTime()
    })
    return audio
  }

  get current() { return this.queue[this.index] || null }
  get playing() { return !this.audio.paused && !this.audio.ended }
  get position() { return this.audio.currentTime || (this.pendingStart ?? 0) }
  get duration() {
    const d = this.audio.duration
    if (Number.isFinite(d) && d > 0 && this.audio.getAttribute('src')) return d
    return this.current?.duration || 0
  }

  // ---- public API ----------------------------------------------------------

  play(items, startIndex = 0, { context = null, shuffle = null } = {}) {
    const list = items.filter(Boolean)
    if (!list.length) return
    if (shuffle !== null) this.shuffle = Boolean(shuffle)
    let start = Math.max(0, Math.min(startIndex, list.length - 1))
    this.ordered = list.slice()
    if (this.shuffle) {
      const first = list[start]
      const rest = list.filter((_, i) => i !== start)
      shuffleInPlace(rest)
      list.splice(0, list.length, first, ...rest)
      start = 0
    }
    this.queue = list
    this.context = context
    this.index = start
    this.retriedOriginal.clear()
    this.load(this.current, { autoplay: true })
    this.emitQueue()
    this.emitMode()
  }

  playNext(items) {
    const list = items.filter(Boolean)
    if (!list.length) return
    if (this.index < 0) return this.play(list, 0)
    this.queue.splice(this.index + 1, 0, ...list)
    if (this.ordered) {
      const pos = this.ordered.indexOf(this.current)
      this.ordered.splice(pos + 1, 0, ...list)
    }
    this.emitQueue()
    toast(list.length === 1 ? t('player.queue.playingNext', { title: list[0].title }) : t('player.queue.playingNextMany', { n: list.length }))
  }

  addToQueue(items) {
    const list = items.filter(Boolean)
    if (!list.length) return
    if (this.index < 0) return this.play(list, 0)
    // User-queued songs go before automatically added ones.
    let at = this.queue.findIndex((item, i) => i > this.index && item.auto)
    if (at === -1) at = this.queue.length
    this.queue.splice(at, 0, ...list)
    this.ordered?.push(...list)
    this.emitQueue()
    toast(list.length === 1 ? t('player.queue.added', { title: list[0].title }) : t('player.queue.addedMany', { n: list.length }))
  }

  jumpTo(index) {
    if (index < 0 || index >= this.queue.length) return
    this.index = index
    this.load(this.current, { autoplay: true })
    this.emitQueue()
  }

  removeAt(index) {
    if (index === this.index || index < 0 || index >= this.queue.length) return
    const [removed] = this.queue.splice(index, 1)
    if (this.ordered) this.ordered = this.ordered.filter((item) => item !== removed)
    if (index < this.index) this.index -= 1
    this.emitQueue()
  }

  move(from, to) {
    if (from === to || from < 0 || from >= this.queue.length) return
    const target = Math.max(0, Math.min(to, this.queue.length - 1))
    const current = this.current
    const [item] = this.queue.splice(from, 1)
    this.queue.splice(target, 0, item)
    this.index = this.queue.indexOf(current)
    this.emitQueue()
  }

  clearUpcoming() {
    this.queue = this.queue.slice(0, this.index + 1)
    if (this.ordered) this.ordered = this.ordered.filter((item) => this.queue.includes(item))
    this.emitQueue()
  }

  toggle() {
    if (!this.current) return
    if (!this.audio.getAttribute('src')) return this.load(this.current, { autoplay: true, startAt: this.pendingStart })
    if (this.audio.paused) this.resume()
    else this.audio.pause()
  }

  resume() {
    this.audio.play().catch((error) => {
      if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') this.onError()
      this.emitState()
    })
  }

  pause() { this.audio.pause() }

  next({ auto = false } = {}) {
    if (!this.queue.length) return
    if (this.index < this.queue.length - 1) {
      this.index += 1
      this.load(this.current, { autoplay: true })
      this.emitQueue()
      return
    }
    if (this.repeat === 'all') {
      this.index = 0
      this.load(this.current, { autoplay: true })
      this.emitQueue()
      return
    }
    if (auto && app.prefs.autoplay) {
      this.autoplayMore().then((added) => {
        if (added) { this.index += 1; this.load(this.current, { autoplay: true }); this.emitQueue() } else this.stopAtEnd()
      })
      return
    }
    if (auto) this.stopAtEnd()
  }

  prev() {
    if (!this.current) return
    if (this.position > 3 || this.index === 0) return this.seek(0)
    this.index -= 1
    this.load(this.current, { autoplay: true })
    this.emitQueue()
  }

  seek(seconds) {
    const target = Math.max(0, Math.min(Number(seconds) || 0, this.duration || Number(seconds) || 0))
    if (!this.audio.getAttribute('src')) { this.pendingStart = target; this.onTime(); return }
    try { this.audio.currentTime = target } catch {}
    this.onTime()
  }

  setVolume(value) {
    this.volume = clamp01(value)
    if (this.volume > 0 && this.muted) this.muted = false
    this.applyVolume()
    store.set('volume', this.volume)
    store.set('muted', this.muted)
    bus.emit('player:volume', { volume: this.volume, muted: this.muted })
  }

  toggleMute() {
    this.muted = !this.muted
    this.applyVolume()
    store.set('muted', this.muted)
    bus.emit('player:volume', { volume: this.volume, muted: this.muted })
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle
    const current = this.current
    if (this.shuffle) {
      this.ordered = this.queue.slice()
      const upcoming = this.queue.slice(this.index + 1)
      shuffleInPlace(upcoming)
      this.queue = [...this.queue.slice(0, this.index + 1), ...upcoming]
    } else if (this.ordered) {
      const present = new Set(this.queue)
      const restored = this.ordered.filter((item) => present.has(item))
      for (const item of this.queue) if (!restored.includes(item)) restored.push(item)
      this.queue = restored
      this.index = Math.max(0, this.queue.indexOf(current))
    }
    this.emitQueue()
    this.emitMode()
  }

  cycleRepeat() {
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off'
    this.emitMode()
    this.save()
  }

  setSleep(value) {
    clearTimeout(this.sleep.timer)
    this.sleep = { timer: null, until: null, endOfTrack: false }
    if (value === 'track') this.sleep.endOfTrack = true
    else if (Number(value) > 0) {
      const ms = Number(value) * 60_000
      this.sleep.until = Date.now() + ms
      this.sleep.timer = setTimeout(() => {
        this.fadeOutAndPause()
        this.sleep = { timer: null, until: null, endOfTrack: false }
        bus.emit('player:sleep', this.sleep)
      }, ms)
    }
    bus.emit('player:sleep', this.sleep)
  }

  // Reloads the current track (e.g. after a quality change) at the same spot.
  reloadCurrent() {
    const item = this.current
    if (!item || item.type !== 'library' || !this.audio.getAttribute('src')) return
    this.load(item, { autoplay: this.playing, startAt: this.position, keepHistory: true })
  }

  // ---- persistence ------------------------------------------------------------

  restore(userId) {
    this.userId = userId
    const saved = store.get(`queue.${userId}`)
    if (!saved || !Array.isArray(saved.queue) || !saved.queue.length) { this.emitAll(); return }
    this.queue = saved.queue.filter((item) => item && item.type === 'library').map((item) => ({ ...item, uid: newUid() }))
    this.index = Math.min(Math.max(Number(saved.index) || 0, 0), this.queue.length - 1)
    this.shuffle = Boolean(saved.shuffle)
    this.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off'
    this.context = saved.context || null
    this.pendingStart = Number(saved.position) || 0
    this.ordered = null
    this.updateMediaSession()
    this.emitAll()
  }

  save() {
    if (!this.userId) return
    this.lastSave = Date.now()
    const queue = this.queue.filter((item) => item.type === 'library')
    if (!queue.length) { store.remove(`queue.${this.userId}`); return }
    // Keep the saved queue bounded around the current position.
    const currentIdx = Math.max(0, queue.indexOf(this.current))
    const from = Math.max(0, currentIdx - 100)
    store.set(`queue.${this.userId}`, {
      queue: queue.slice(from, from + 500).map(serializeItem),
      index: currentIdx - from,
      position: Math.floor(this.position),
      shuffle: this.shuffle,
      repeat: this.repeat,
      context: this.context
    })
  }

  reset() {
    this.flushPlay(false)
    this.audio.pause()
    this.a.removeAttribute('src'); this.a.load()
    this.b.removeAttribute('src'); this.b.load()
    this.queue = []
    this.index = -1
    this.userId = null
    this.emitAll()
  }

  // ---- internals ----------------------------------------------------------------

  srcFor(item, quality = app.prefs.quality) {
    return item.type === 'preview' ? item.previewUrl : streamUrl(item.id, quality)
  }

  load(item, { autoplay = true, startAt = null, keepHistory = false, quality = null } = {}) {
    if (!item) return
    if (!keepHistory) this.flushPlay(false)
    const src = this.srcFor(item, quality || app.prefs.quality)
    const other = this.audio === this.a ? this.b : this.a
    const preloaded = other.dataset.uid === item.uid && other.getAttribute('src') === src && other.readyState >= 2 && startAt == null
    this.audio.pause()
    if (preloaded) {
      // Swap to the element that already buffered this track.
      this.audio.removeAttribute('src')
      this.audio.load()
      this.audio = other
      try { this.audio.currentTime = 0 } catch {}
    } else {
      if (other.getAttribute('src')) { other.removeAttribute('src'); other.load() }
      other.dataset.uid = ''
      this.audio.src = src
    }
    this.audio.dataset.uid = item.uid
    this.pendingStart = startAt != null && startAt > 0 ? startAt : null
    if (!keepHistory) this.played = { uid: item.uid, seconds: 0, lastPos: null }
    this.applyVolume()
    this.loading = true
    if (autoplay) this.resume()
    this.updateMediaSession()
    this.emitState()
    bus.emit('player:track', item)
    this.save()
  }

  applyVolume() {
    let factor = 1
    const item = this.current
    if (app.prefs.normalize && item?.replayGain) {
      const gain = Number(item.replayGain.track ?? item.replayGain.album)
      if (Number.isFinite(gain)) factor = Math.min(1, Math.pow(10, gain / 20))
    }
    for (const audio of [this.a, this.b]) {
      audio.volume = clamp01(this.volume * factor)
      audio.muted = this.muted
    }
  }

  onTime() {
    const pos = this.audio.currentTime || 0
    if (this.played.lastPos != null) {
      const delta = pos - this.played.lastPos
      if (delta > 0 && delta < 2.5 && !this.audio.paused) this.played.seconds += delta
    }
    this.played.lastPos = pos
    const duration = this.duration
    bus.emit('player:time', { position: this.audio.getAttribute('src') ? pos : (this.pendingStart || 0), duration, buffered: bufferedEnd(this.audio) })
    if (Date.now() - this.lastPositionState > 1000) {
      this.lastPositionState = Date.now()
      this.updatePositionState()
    }
    if (this.playing && Date.now() - this.lastSave > 10_000) this.save()
    if (app.prefs.preload && duration && duration - pos < 25) this.preloadNext()
  }

  preloadNext() {
    const next = this.repeat === 'one' ? null : this.queue[this.index + 1]
    if (!next) return
    const other = this.audio === this.a ? this.b : this.a
    if (other.dataset.uid === next.uid) return
    other.dataset.uid = next.uid
    other.preload = 'auto'
    other.src = this.srcFor(next)
    other.load()
  }

  onEnded() {
    this.flushPlay(true)
    if (this.sleep.endOfTrack) {
      this.sleep = { timer: null, until: null, endOfTrack: false }
      bus.emit('player:sleep', this.sleep)
      this.emitState()
      return
    }
    if (this.repeat === 'one') {
      this.played = { uid: this.current?.uid, seconds: 0, lastPos: null }
      this.seek(0)
      this.resume()
      return
    }
    this.next({ auto: true })
  }

  onError() {
    const item = this.current
    if (!item) return
    this.loading = false
    // A transcoding problem should not make the song unplayable.
    if (item.type === 'library' && app.prefs.quality !== 'original' && !this.retriedOriginal.has(item.uid)) {
      this.retriedOriginal.add(item.uid)
      this.load(item, { autoplay: true, startAt: this.audio.currentTime || null, keepHistory: true, quality: 'original' })
      return
    }
    this.errorStreak += 1
    toast(t('player.playback.error', { title: item.title }), { type: 'error' })
    this.emitState()
    if (this.errorStreak < 3 && this.index < this.queue.length - 1) setTimeout(() => this.next(), 1200)
  }

  stopAtEnd() {
    this.audio.pause()
    try { this.audio.currentTime = 0 } catch {}
    this.emitState()
  }

  fadeOutAndPause() {
    const audio = this.audio
    const start = audio.volume
    const steps = 20
    let i = 0
    const timer = setInterval(() => {
      i += 1
      audio.volume = clamp01(start * (1 - i / steps))
      if (i >= steps) {
        clearInterval(timer)
        audio.pause()
        this.applyVolume()
      }
    }, 150)
  }

  // Keeps the music going with similar songs from the library.
  async autoplayMore() {
    const seed = [...this.queue].reverse().find((item) => item.type === 'library')
    const known = new Set(this.queue.slice(-300).filter((i) => i.type === 'library').map((i) => i.id))
    const attempts = []
    if (seed?.genre) attempts.push({ sort: 'random', limit: 40, genre: seed.genre })
    if (seed?.artistId) attempts.push({ sort: 'random', limit: 40, artistId: seed.artistId })
    attempts.push({ sort: 'random', limit: 40 })
    for (const query of attempts) {
      try {
        const res = await get('/tracks', query)
        const fresh = (res.items || []).filter((track) => !known.has(track.id)).slice(0, 15)
        if (fresh.length) {
          this.queue.push(...fresh.map((track) => fromTrack(track, { auto: true })))
          this.ordered?.push(...this.queue.slice(-fresh.length))
          return true
        }
      } catch {}
    }
    return false
  }

  flushPlay(completed, { beacon = false } = {}) {
    const item = this.queue.find((q) => q.uid === this.played.uid)
    const seconds = this.played.seconds
    this.played = { uid: null, seconds: 0, lastPos: null }
    if (!item || item.type !== 'library') return
    if (!completed && seconds < 1) return
    const body = { trackId: item.id, playedMs: Math.round(seconds * 1000), completed: Boolean(completed), context: this.context?.label || '' }
    if (beacon && navigator.sendBeacon) {
      try { navigator.sendBeacon('/api/player/history', new Blob([JSON.stringify(body)], { type: 'application/json' })); return } catch {}
    }
    post('/history', body).catch(() => {})
  }

  // ---- media session --------------------------------------------------------------

  setupMediaSession() {
    const ms = navigator.mediaSession
    if (!ms) return
    const handlers = {
      play: () => this.toggle(),
      pause: () => this.pause(),
      stop: () => this.pause(),
      previoustrack: () => this.prev(),
      nexttrack: () => this.next(),
      seekbackward: (d) => this.seek(this.position - (d?.seekOffset || 10)),
      seekforward: (d) => this.seek(this.position + (d?.seekOffset || 10)),
      seekto: (d) => this.seek(d?.seekTime || 0)
    }
    for (const [action, fn] of Object.entries(handlers)) {
      try { ms.setActionHandler(action, fn) } catch {}
    }
  }

  updateMediaSession() {
    const ms = navigator.mediaSession
    const item = this.current
    if (!ms || !item || typeof MediaMetadata === 'undefined') return
    const publish = (artwork) => {
      if (this.current?.uid !== item.uid) return
      try { ms.metadata = new MediaMetadata({ title: item.title, artist: item.artist, album: item.album || '', artwork }) } catch {}
    }
    if (item.type === 'preview') return publish(item.artworkUrl ? [{ src: item.artworkUrl, sizes: '512x512' }] : [])
    const remote = absoluteUrl(artworkUrl(item.artwork, 512))
    const cached = this.artCache?.get(item.artwork)
    if (cached !== undefined) return publish(cached ? [{ src: cached, sizes: '512x512', type: 'image/jpeg' }] : [this.fallbackArt()])
    publish([{ src: remote, sizes: '512x512' }])
    // The desktop shell downloads the artwork on its own; an inline image
    // avoids cookie / timing problems so the cover always reaches MPRIS.
    this.artDataUrl(item.artwork).then((dataUrl) => publish(dataUrl ? [{ src: dataUrl, sizes: '512x512', type: 'image/jpeg' }] : [this.fallbackArt()]))
  }

  fallbackArt() {
    return { src: absoluteUrl('/src/logo.png'), sizes: '512x512', type: 'image/png' }
  }

  async artDataUrl(ref) {
    this.artCache ||= new Map()
    if (this.artCache.has(ref)) return this.artCache.get(ref)
    let value = null
    try {
      const res = await fetch(artworkUrl(ref, 512), { credentials: 'same-origin' })
      if (res.ok) {
        const blob = await res.blob()
        value = await new Promise((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result || '') || null)
          reader.onerror = () => resolve(null)
          reader.readAsDataURL(blob)
        })
      }
    } catch {}
    this.artCache.set(ref, value)
    if (this.artCache.size > 30) this.artCache.delete(this.artCache.keys().next().value)
    return value
  }

  updatePositionState() {
    const ms = navigator.mediaSession
    if (!ms?.setPositionState) return
    const duration = this.duration
    if (!Number.isFinite(duration) || duration <= 0) return
    try { ms.setPositionState({ duration, playbackRate: this.audio.playbackRate || 1, position: Math.min(this.position, duration) }) } catch {}
  }

  // ---- events -----------------------------------------------------------------------

  emitState() {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = this.current ? (this.playing ? 'playing' : 'paused') : 'none'
    bus.emit('player:state', { playing: this.playing, loading: this.loading && this.playing !== false && Boolean(this.audio.getAttribute('src')) })
  }

  emitQueue() {
    bus.emit('player:queue', { queue: this.queue, index: this.index })
    this.save()
  }

  emitMode() {
    bus.emit('player:mode', { shuffle: this.shuffle, repeat: this.repeat })
  }

  emitAll() {
    bus.emit('player:track', this.current)
    this.emitQueue()
    this.emitMode()
    this.emitState()
    bus.emit('player:volume', { volume: this.volume, muted: this.muted })
    bus.emit('player:time', { position: this.pendingStart || 0, duration: this.duration, buffered: 0 })
  }
}

function clamp01(n) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8
}

function bufferedEnd(audio) {
  try {
    const b = audio.buffered
    return b.length ? b.end(b.length - 1) : 0
  } catch { return 0 }
}
