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
    this.source?.close()
    this.source = null
    this.byId.clear()
    this.urlToId.clear()
  }

  connect() {
    if (typeof EventSource === 'undefined') return
    const es = new EventSource('/api/player/downloads/events')
    this.source = es
    es.addEventListener('ready', () => { this.retryDelay = 2000 })
    es.addEventListener('download', (e) => {
      try { this.ingest(JSON.parse(e.data)) } catch {}
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
      const res = await get('/downloads', { active: 1, limit: 200 })
      for (const row of res.items || []) this.ingest(row, { silent: true })
      this.emitCount()
    } catch {}
  }

  get activeCount() {
    let n = 0
    for (const row of this.byId.values()) if (ACTIVE.has(row.status) && row.userId === app.user?.id) n++
    return n
  }

  emitCount() { bus.emit('downloads:count', this.activeCount) }

  ingest(row, { silent = false } = {}) {
    if (!row?.id) return
    const prev = this.byId.get(row.id)
    this.byId.set(row.id, row)
    for (const url of [row.sourceUrl, row.requestedUrl]) if (url) this.urlToId.set(url, row.id)
    this.paint(row)
    bus.emit('download', row)
    this.emitCount()
    if (silent || !prev || prev.status === row.status || row.userId !== app.user?.id) return
    if (row.status === 'completed') {
      toast(t('player.downloads.doneToast', { title: row.title || row.sourceUrl }), { type: 'success' })
      bus.emit('library:changed', row)
    } else if (row.status === 'failed') {
      toast(t('player.downloads.failedToast', { title: row.title || row.sourceUrl }), { type: 'error' })
    }
  }

  stateFor(item) {
    const id = item?.download?.id || this.urlToId.get(item?.url)
    return id ? this.byId.get(id) || item.download || null : item?.download || null
  }

  // Starts (or joins) a download for an online item.
  async request(item, { playlistId = null, force = false, quiet = false } = {}) {
    if (!app.canDownload) { toast(t('player.downloads.notAllowed'), { type: 'error' }); return null }
    const payload = {
      kind: ['album', 'playlist'].includes(item.kind) ? item.kind : 'track',
      url: item.url,
      title: item.title,
      artist: item.artist,
      album: item.album,
      artworkUrl: item.artworkUrl,
      isrc: item.isrc,
      duration: item.duration,
      trackCount: item.trackCount
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
    setLabel(t('player.downloads.download'))
    el.title = t('player.downloads.download')
    return
  }
  if (ACTIVE.has(row.status)) {
    el.classList.add('is-active')
    el.style.setProperty('--p', String(Math.round(row.progress || 0)))
    swapIcon('stop')
    const pct = `${Math.round(row.progress || 0)}%`
    setLabel(row.status === 'queued' ? t('player.downloads.status.queued') : pct)
    el.title = `${t(`player.downloads.status.${row.status}`)} · ${pct}`
  } else if (row.status === 'completed' || row.status === 'exists') {
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
export function downloadButton(item, { compact = true, onDone = null } = {}) {
  const el = h('button', {
    type: 'button',
    class: ['dl', compact ? 'dl--compact' : 'btn btn--outline'],
    dataset: { dlUrl: item.url || '', iconSize: compact ? '18' : '18' }
  }, h('span', { class: compact ? 'sr-only dl__label' : 'dl__label' }))
  const state = app.downloads.stateFor(item)
  if (state?.id) el.dataset.dlId = state.id
  renderDownloadBadge(el, state)
  el.addEventListener('click', async (e) => {
    e.stopPropagation()
    const current = app.downloads.stateFor(item)
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
