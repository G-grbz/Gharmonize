// Shared application state and a tiny event bus. Views import `app` instead of
// threading context through every function.

class Bus {
  constructor() {
    this.map = new Map()
    this.groups = new Map()
    // Listeners added while a group is set (e.g. while building the chrome)
    // can be removed together when that part of the UI is rebuilt.
    this.currentGroup = null
  }
  on(event, fn) {
    if (!this.map.has(event)) this.map.set(event, new Set())
    this.map.get(event).add(fn)
    const off = () => this.off(event, fn)
    if (this.currentGroup) {
      if (!this.groups.has(this.currentGroup)) this.groups.set(this.currentGroup, [])
      this.groups.get(this.currentGroup).push(off)
    }
    return off
  }
  offGroup(group) {
    for (const off of this.groups.get(group) || []) off()
    this.groups.delete(group)
  }
  off(event, fn) { this.map.get(event)?.delete(fn) }
  emit(event, payload) {
    for (const fn of [...(this.map.get(event) || [])]) {
      try { fn(payload) } catch (error) { console.error(`[player] ${event} handler failed`, error) }
    }
  }
}

export const bus = new Bus()

const PREF_DEFAULTS = {
  quality: 'original',
  normalize: false,
  progressStyle: 'classic',
  autoplay: true,
  preload: true,
  homeFilter: 'all'
}

export const app = {
  status: null,
  user: null,
  me: null,
  playlists: [],
  providers: [],
  canDownload: false,
  player: null,
  downloads: null,
  nav: (path) => { window.location.hash = path.startsWith('#') ? path : `#${path}` },
  isAdmin() { return this.user?.role === 'admin' || Boolean(this.status?.gharmonizeAdmin) },
  isPlayerAdmin() { return this.user?.role === 'admin' },
  prefs: { ...PREF_DEFAULTS },
  setPref(key, value) {
    this.prefs[key] = value
    store.set('prefs', this.prefs)
    bus.emit('prefs', { key, value })
  }
}

// localStorage wrapper that never throws (private mode, blocked storage).
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`ghp.${key}`)
      return raw == null ? fallback : JSON.parse(raw)
    } catch { return fallback }
  },
  set(key, value) {
    try { localStorage.setItem(`ghp.${key}`, JSON.stringify(value)) } catch {}
  },
  remove(key) {
    try { localStorage.removeItem(`ghp.${key}`) } catch {}
  }
}

app.prefs = { ...PREF_DEFAULTS, ...(store.get('prefs', {}) || {}) }
