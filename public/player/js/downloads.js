// Download bridge client: requests, live progress (SSE) and DOM badges.
// Any element with data-dl-url / data-dl-id is kept in sync automatically.

import { app, bus } from './app.js'
import { get, post } from './api.js'
import { t, toast, toastError, icon, h } from './dom.js'

const ACTIVE = new Set(['queued', 'resolving', 'downloading', 'indexing'])

export class DownloadTracker {
  constructor() {
    this.byId = new Map()
    this.urlToId = new Map()
    // Download groups (many songs at once) and the links still waiting in
    // them (over the queue limit, not requested yet): link → group id.
    this.groups = new Map()
    this.waiting = new Map()
    this.source = null
    this.retryTimer = null
    this.retryDelay = 2000
  }

  start() {
    this.stop()
    this.refresh()
    this.connect()
  }

  stop() {
    clearTimeout(this.retryTimer)
    clearTimeout(this.batch?.timer)
    this.batch = null
    this.source?.close()
    this.source = null
    this.byId.clear()
    this.urlToId.clear()
    this.groups.clear()
    this.waiting.clear()
  }

  connect() {
    if (typeof EventSource === 'undefined') return
    const es = new EventSource('/api/player/downloads/events')
    this.source = es
    es.addEventListener('ready', () => {
      if (this.retryDelay > 2000) this.invalidateOwned()
      this.retryDelay = 2000
    })
    es.addEventListener('library-removed', () => this.invalidateOwned())
    es.addEventListener('download', (e) => {
      try { this.ingest(JSON.parse(e.data)) } catch {}
    })
    es.addEventListener('group', (e) => {
      try { this.ingestGroup(JSON.parse(e.data)) } catch {}
    })
    es.addEventListener('error', () => {
      es.close()
      if (this.source !== es) return
      this.source = null
      clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => { if (app.user) { this.refresh(); this.connect() } }, this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, 60_000)
    })
  }

  async refresh() {
    try {
      const [res, groups] = await Promise.all([get('/downloads', { active: 1, limit: 500 }), get('/downloads/groups', { active: 1 }).catch(() => ({ items: [] }))])
      for (const row of res.items || []) this.ingest(row, { silent: true })
      for (const group of groups.items || []) this.ingestGroup(group, { silent: true })
      this.emitCount()
    } catch {}
  }

  invalidateOwned() {
    for (const [id, row] of this.byId) {
      if (row.status === 'completed' || row.status === 'exists') this.byId.delete(id)
    }
    for (const [url, id] of this.urlToId) if (!this.byId.has(id)) this.urlToId.delete(url)
    bus.emit('library:changed')
  }

  get activeCount() {
    let n = 0
    for (const row of this.byId.values()) if (ACTIVE.has(row.status) && row.userId === app.user?.id) n++
    for (const [url, groupId] of this.waiting) if (!this.urlToId.has(url) && this.groups.get(groupId)?.userId === app.user?.id) n++
    return n
  }

  emitCount() { bus.emit('downloads:count', this.activeCount) }

  ingest(row, { silent = false } = {}) {
    if (!row?.id) return
    const prev = this.byId.get(row.id)
    this.byId.set(row.id, row)
    for (const url of [row.sourceUrl, row.requestedUrl]) if (url) { this.urlToId.set(url, row.id); this.waiting.delete(url) }
    this.paint(row)
    bus.emit('download', row)
    this.emitCount()
    if (silent || !prev || prev.status === row.status || row.userId !== app.user?.id) return
    // Songs of a group: one message when the whole group is done.
    if (row.groupId && this.groups.has(row.groupId)) {
      if (row.status === 'completed') this.libraryChanged()
      return
    }
    if (row.status === 'completed' || row.status === 'failed') this.finished(row)
  }

  ingestGroup(group, { silent = false } = {}) {
    if (!group?.id) return
    const prev = this.groups.get(group.id)
    this.groups.set(group.id, group)
    if (group.pendingUrls) {
      for (const [url, id] of this.waiting) if (id === group.id) this.waiting.delete(url)
      for (const url of group.pendingUrls) if (!this.urlToId.has(url)) this.waiting.set(url, group.id)
    }
    // Nothing waits any more: the links left over (canceled) go back to idle.
    if (!group.counts?.waiting || group.status === 'canceled') {
      for (const [url, id] of this.waiting) {
        if (id !== group.id) continue
        this.waiting.delete(url)
        this.paintUrl(url)
      }
    }
    bus.emit('download-group', group)
    this.emitCount()
    if (silent || !prev?.active || group.active || group.userId !== app.user?.id) return
    const c = group.counts || {}
    const name = group.title || t('player.downloads.group.untitled')
    if (group.status === 'canceled') return
    toast(c.failed ? t('player.downloads.group.doneFailed', { name, done: c.done, failed: c.failed }) : t('player.downloads.group.done', { name, done: c.done }),
      { type: c.failed ? 'error' : 'success', action: { label: t('player.downloads.group.show'), run: () => app.nav('/downloads') } })
  }

  // Many songs at once: one request and one message. Songs over the queue
  // limit wait on the server and are queued as earlier ones finish.
  async requestMany(items, { title = null, artworkUrl = null, playlistId = null, quiet = false } = {}) {
    if (!app.canDownload) { toast(t('player.downloads.notAllowed'), { type: 'error' }); return null }
    const list = (items || []).filter((item) => item?.url).map((item) => ({
      kind: ['album', 'playlist'].includes(item.kind) ? item.kind : 'track',
      url: item.url,
      title: item.title,
      artist: item.artist,
      album: item.album,
      artworkUrl: item.artworkUrl,
      isrc: item.isrc,
      duration: item.duration,
      trackCount: item.trackCount,
      only: Array.isArray(item.only) && item.only.length ? item.only : undefined
    }))
    if (!list.length) return null
    try {
      const group = await post('/downloads/groups', { items: list, title, artworkUrl, playlistId })
      this.ingestGroup(group, { silent: true })
      for (const url of group.pendingUrls || []) this.paintUrl(url)
      if (!quiet) {
        toast(t('player.downloads.group.queued', { n: list.length }), { type: 'success', action: { label: t('player.downloads.group.show'), run: () => app.nav('/downloads') } })
      }
      return group
    } catch (error) {
      toastError(error)
      return null
    }
  }

  async cancelGroup(id) {
    try { this.ingestGroup(await post(`/downloads/groups/${encodeURIComponent(id)}/cancel`)) } catch (error) { toastError(error) }
  }

  async retryGroup(id) {
    try { this.ingestGroup(await post(`/downloads/groups/${encodeURIComponent(id)}/retry`)) } catch (error) { toastError(error) }
  }

  // Repaints the badges of one link (e.g. a waiting song that was canceled).
  paintUrl(url) {
    const state = this.stateFor({ url })
    for (const el of document.querySelectorAll(`[data-dl-url="${cssEscape(url)}"]`)) renderDownloadBadge(el, state)
  }

  // A selection, an album or a playlist finishes song by song: one message
  // for the whole batch (when the queue is empty, or a progress note every
  // 30 s while it runs) and the library refreshed at most every 5 s,
  // instead of a message and a refresh per song.
  finished(row) {
    const batch = this.batch ||= { done: [], failed: [], startedAt: Date.now(), timer: null }
    ;(row.status === 'completed' ? batch.done : batch.failed).push(row.title || row.sourceUrl)
    if (row.status === 'completed') this.libraryChanged()
    clearTimeout(batch.timer)
    const wait = this.activeCount ? Math.max(0, 30_000 - (Date.now() - batch.startedAt)) : 700
    batch.timer = setTimeout(() => this.flushBatch(), wait)
  }

  flushBatch() {
    const batch = this.batch
    if (!batch) return
    clearTimeout(batch.timer)
    this.batch = null
    const left = this.activeCount
    const rest = left ? ` · ${t('player.downloads.leftToast', { n: left })}` : ''
    if (batch.done.length === 1 && !left) toast(t('player.downloads.doneToast', { title: batch.done[0] }), { type: 'success' })
    else if (batch.done.length) toast(t('player.downloads.doneManyToast', { n: batch.done.length }) + rest, { type: 'success' })
    if (batch.failed.length === 1) toast(t('player.downloads.failedToast', { title: batch.failed[0] }), { type: 'error' })
    else if (batch.failed.length) toast(t('player.downloads.failedManyToast', { n: batch.failed.length }), { type: 'error' })
  }

  // library:changed right away, then at most once every 5 s.
  libraryChanged() {
    if (this.libraryTimer) { this.libraryPending = true; return }
    bus.emit('library:changed')
    this.libraryTimer = setTimeout(() => {
      this.libraryTimer = null
      if (this.libraryPending) { this.libraryPending = false; this.libraryChanged() }
    }, 5000)
  }

  stateFor(item) {
    const id = item?.download?.id || this.urlToId.get(item?.url)
    const row = id ? this.byId.get(id) || item.download || null : item?.download || null
    if (!row && item?.url && this.waiting.has(item.url)) {
      return { id: null, status: 'queued', phase: 'waiting', progress: 0, groupId: this.waiting.get(item.url), waiting: true }
    }
    return (row?.status === 'completed' || row?.status === 'exists') && !row.trackIds?.length ? null : row
  }

  // Starts (or joins) a download for an online item.
  async request(item, { playlistId = null, force = false, quiet = false } = {}) {
    if (!app.canDownload) { toast(t('player.downloads.notAllowed'), { type: 'error' }); return null }
    // A whole album (an album card): the server leaves out the songs the
    // library already has.
    const payload = {
      kind: ['album', 'playlist'].includes(item.kind) ? item.kind : 'track',
      url: item.url,
      title: item.title,
      artist: item.artist,
      album: item.album,
      artworkUrl: item.artworkUrl,
      isrc: item.isrc,
      duration: item.duration,
      trackCount: item.trackCount,
      // Albums / playlists partly in the library: only the missing songs.
      only: Array.isArray(item.only) && item.only.length ? item.only : undefined
    }
    try {
      const row = await post('/downloads', { item: payload, playlistId, force })
      if (item.url) this.urlToId.set(item.url, row.id)
      this.ingest(row, { silent: true })
      if (row.status === 'exists') {
        if (!quiet) toast(t('player.downloads.alreadyOwned', { title: item.title }), { type: 'success' })
        bus.emit('library:changed', row)
      } else if (!quiet) {
        toast(t('player.downloads.queuedToast', { title: item.title }))
      }
      return row
    } catch (error) {
      toastError(error)
      return null
    }
  }

  async cancel(id) {
    try { this.ingest(await post(`/downloads/${encodeURIComponent(id)}/cancel`)) } catch (error) { toastError(error) }
  }

  async retry(id) {
    try { this.ingest(await post(`/downloads/${encodeURIComponent(id)}/retry`)) } catch (error) { toastError(error) }
  }

  // Re-applies every known download state (e.g. to a page shown again from memory).
  repaintAll() { for (const row of this.byId.values()) this.paint(row) }

  // Updates every badge bound to this download.
  paint(row) {
    const selectors = [`[data-dl-id="${cssEscape(row.id)}"]`]
    for (const url of [row.sourceUrl, row.requestedUrl]) if (url) selectors.push(`[data-dl-url="${cssEscape(url)}"]`)
    for (const el of document.querySelectorAll(selectors.join(','))) {
      el.dataset.dlId = row.id
      renderDownloadBadge(el, row)
    }
  }
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, '\\$&')
}

// Fills a download button/badge element according to the record state.
export function renderDownloadBadge(el, row) {
  el.classList.remove('is-active', 'is-done', 'is-failed')
  el.style.removeProperty('--p')
  const label = el.querySelector('.dl__label')
  const setLabel = (text) => { if (label) label.textContent = text }
  const swapIcon = (name) => {
    const old = el.querySelector('svg.icon')
    const next = icon(name, { size: Number(el.dataset.iconSize) || 18 })
    if (old) old.replaceWith(next)
    else el.prepend(next)
  }
  if (!row) {
    swapIcon('download')
    setLabel(el.dataset.idleLabel || t('player.downloads.download'))
    el.title = el.dataset.idleLabel || t('player.downloads.download')
    return
  }
  if (ACTIVE.has(row.status)) {
    el.classList.add('is-active')
    el.style.setProperty('--p', String(Math.round(row.progress || 0)))
    swapIcon('stop')
    const pct = `${Math.round(row.progress || 0)}%`
    setLabel(row.status === 'queued' ? t('player.downloads.status.queued') : pct)
    el.title = row.waiting ? t('player.downloads.group.waitingSong') : `${t(`player.downloads.status.${row.status}`)} · ${pct}`
  } else if ((row.status === 'completed' || row.status === 'exists') && row.trackIds?.length) {
    el.classList.add('is-done')
    swapIcon('check')
    setLabel(t('player.downloads.inLibrary'))
    el.title = t('player.downloads.inLibrary')
  } else if (row.status === 'failed') {
    el.classList.add('is-failed')
    swapIcon('refresh')
    setLabel(t('player.downloads.retry'))
    el.title = row.error?.message || t('player.downloads.status.failed')
  } else {
    swapIcon('download')
    setLabel(t('player.downloads.download'))
    el.title = t('player.downloads.download')
  }
}

// A download control for an online item: click starts / cancels / retries.
export function downloadButton(item, { compact = true, onDone = null, idleLabel = null } = {}) {
  const el = h('button', {
    type: 'button',
    class: ['dl', compact ? 'dl--compact' : 'btn btn--outline'],
    dataset: { dlUrl: item.url || '', iconSize: compact ? '18' : '18', ...(idleLabel ? { idleLabel } : {}) }
  }, h('span', { class: compact ? 'sr-only dl__label' : 'dl__label' }))
  const state = app.downloads.stateFor(item)
  if (state?.id) el.dataset.dlId = state.id
  renderDownloadBadge(el, state)
  el.addEventListener('click', async (e) => {
    e.stopPropagation()
    const current = app.downloads.stateFor(item)
    if (current?.waiting) return
    if (current && ACTIVE.has(current.status)) return app.downloads.cancel(current.id)
    if (current && current.status === 'failed') return app.downloads.retry(current.id)
    if (current && (current.status === 'completed' || current.status === 'exists')) return onDone?.(current)
    el.disabled = true
    const row = await app.downloads.request(item)
    el.disabled = false
    if (row) {
      el.dataset.dlId = row.id
      renderDownloadBadge(el, row)
    }
  })
  return el
}

export { ACTIVE as ACTIVE_DOWNLOAD_STATUSES }
