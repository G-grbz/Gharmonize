// Home: greeting, quick access, personal mixes, library shelves balanced with
// online recommendation shelves, moods and genres.
//
// The page is kept in memory (keepAlive): going back to it is instant and it
// only refreshes quietly when the library changed or it got old.

import { app } from '../app.js'
import { get, artworkUrl } from '../api.js'
import { h, t, icon, clear, artwork, skeletonShelf, fmtNumber, fmtLong, emptyState } from '../dom.js'
import { shelf, trackCard, albumCard, artistCard, onlineCard, genreTile, moodTile, playCollection, playlistCard, mixCard } from '../components.js'
import { saveButton } from '../playlistSave.js'

const PERSONAL = /^(new-from-your-artists|missing-|fans-|radio-|genre-)/
// Library shelves that are about discovering music you have but rarely play:
// they also show under the "Discover" filter, mixed with online shelves.
const LOCAL_DISCOVERY = /^(because-|never-played|forgotten|discover-albums|artists$)/
const REFRESH_AFTER_MS = 5 * 60 * 1000

function greeting() {
  const hour = new Date().getHours()
  const key = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  return t(`player.home.greeting.${key}`, { name: app.user?.displayName || app.user?.username || '' })
}

function libraryShelf(s) {
  const title = t(`player.home.${s.title}`, s.titleVars || {})
  const context = { label: title, route: '/home' }
  const render = s.kind === 'tracks' ? (item, i) => trackCard(item, s.items, i, context)
    : s.kind === 'albums' ? albumCard
      : s.kind === 'artists' ? artistCard
        : null
  if (!render) return null
  const tools = s.kind === 'tracks' ? [saveButton(() => ({ name: title, trackIds: s.items.map((x) => x.id), count: s.items.length }))] : []
  const both = LOCAL_DISCOVERY.test(s.id)
  return shelf({ id: s.id, title, items: s.items, render, tools, cls: `shelf--library${both ? ' shelf--both' : ''}` })
}

function discoveryShelf(s) {
  const title = s.title || t(s.titleKey, s.titleVars || {})
  const subtitle = s.subtitleKey ? t(s.subtitleKey) : null
  const context = { label: title, route: '/home' }
  return shelf({ id: s.id, title, subtitle, items: s.items, render: (item, i) => onlineCard(item, s.items, i, context), cls: `shelf--online shelf--${s.source}` })
}

function quickTile({ title, art, href, onPlay }) {
  const play = h('button', { type: 'button', class: 'play-fab play-fab--sm', 'aria-label': t('player.common.play'), title: t('player.common.play') }, icon('play', { size: 18 }))
  play.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onPlay() })
  return h('a', { class: 'quick', href }, art, h('span', { class: 'quick__title', text: title }), play)
}

function quickGrid(home) {
  const tiles = []
  const liked = home.shelves.find((s) => s.id === 'liked')
  if (liked) tiles.push(quickTile({ title: t('player.nav.liked'), art: h('span', { class: 'quick__art quick__art--liked' }, icon('heartFill', { size: 22 })), href: '#/liked', onPlay: () => playCollection('liked') }))
  for (const pl of (app.playlists || []).filter((p) => p.trackCount).slice(0, 3)) {
    tiles.push(quickTile({ title: pl.name, art: artwork(artworkUrl(pl.artwork, 128), { cls: 'quick__art', placeholder: 'list', seed: pl.name }), href: `#/playlist/${pl.id}`, onPlay: () => playCollection('playlist', pl.id) }))
  }
  const albums = [...(home.shelves.find((s) => s.id === 'jump-back-in')?.items || []), ...(home.shelves.find((s) => s.id === 'recently-added')?.items || [])]
  const seen = new Set()
  for (const album of albums) {
    if (tiles.length >= 8) break
    if (seen.has(album.id)) continue
    seen.add(album.id)
    tiles.push(quickTile({ title: album.title, art: artwork(artworkUrl(album.artwork, 128), { cls: 'quick__art', placeholder: 'album', seed: album.title }), href: `#/album/${album.id}`, onPlay: () => playCollection('album', album.id) }))
  }
  return tiles.length ? h('div', { class: 'quick-grid' }, tiles) : null
}

export async function render() {
  const root = h('div', { class: 'home' })
  root.dataset.filter = app.prefs.homeFilter || 'all'
  let controller = new AbortController()
  let loadedAt = 0
  let discoveryAt = 0
  let lastDiscovery = null

  // Builds the whole page into `root`. The first time it is awaited (the
  // router shows a spinner); later refreshes swap the content when ready.
  async function build({ quiet = false } = {}) {
    const signal = controller.signal
    const home = await get('/home', null, { signal })
    const stats = home.stats || {}
    const fresh = document.createDocumentFragment()

    const chips = h('div', { class: 'chips', role: 'tablist' })
    for (const key of ['all', 'library', 'discover']) {
      const chip = h('button', { type: 'button', class: ['chip', root.dataset.filter === key && 'is-active'], role: 'tab', text: t(`player.home.filter.${key}`) })
      chip.addEventListener('click', () => {
        app.setPref('homeFilter', key)
        chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip))
        root.dataset.filter = key
      })
      chips.append(chip)
    }
    fresh.append(h('header', { class: 'home__head' },
      h('div', {},
        h('h1', { class: 'home__greeting', text: greeting() }),
        stats.tracks ? h('p', { class: 'home__stats', text: t('player.home.stats', { tracks: fmtNumber(stats.tracks), albums: fmtNumber(stats.albums), artists: fmtNumber(stats.artists), duration: fmtLong(stats.durationSeconds) }) }) : null),
      chips))

    if (!stats.tracks) {
      fresh.append(h('div', { class: 'welcome-card' },
        h('div', { class: 'welcome-card__icon' }, icon('sparkles', { size: 34 })),
        h('div', {},
          h('h2', { text: t('player.home.emptyTitle') }),
          h('p', { text: app.canDownload ? t('player.home.emptyTextDownload') : t('player.home.emptyText') }),
          h('a', { class: 'btn btn--primary', href: '#/search', text: t('player.home.emptyAction') }))))
    }
    const quick = quickGrid(home)
    if (quick) fresh.append(h('div', { class: 'lib-only' }, quick))

    const head = h('div', { class: 'home__shelves' })
    const flow = h('div', { class: 'home__shelves' })
    const tail = h('div', { class: 'home__shelves' })
    fresh.append(head, flow, tail)

    const libraryShelves = home.shelves.filter((s) => s.kind !== 'genres')
    const genres = home.shelves.find((s) => s.kind === 'genres')
    const firstTwo = libraryShelves.filter((s) => !LOCAL_DISCOVERY.test(s.id)).slice(0, 2)
    firstTwo.forEach((s) => head.append(libraryShelf(s)))
    const mixesSlot = h('div', { class: 'shelf--both' })
    head.firstChild ? head.firstChild.after(mixesSlot) : head.append(mixesSlot)
    const rest = libraryShelves.filter((s) => !firstTwo.includes(s))
    const localDiscovery = rest.filter((s) => LOCAL_DISCOVERY.test(s.id))
    const plainLibrary = rest.filter((s) => !LOCAL_DISCOVERY.test(s.id))

    // Library, online and "discover from your library" shelves take turns, so
    // neither side dominates the page.
    // Library shelves are built once and only moved when online shelves
    // arrive, instead of rebuilding hundreds of cards on every repaint.
    const builtLibrary = new Map()
    const libraryEl = (s) => {
      if (!builtLibrary.has(s)) builtLibrary.set(s, libraryShelf(s))
      return builtLibrary.get(s)
    }
    const paintFlow = (discovery = null) => {
      clear(flow)
      const online = discovery?.shelves || []
      const personal = online.filter((s) => PERSONAL.test(s.id))
      const global = online.filter((s) => !PERSONAL.test(s.id))
      const lanes = [localDiscovery, personal, plainLibrary, global]
      const n = Math.max(...lanes.map((l) => l.length))
      const add = (el) => { if (el) flow.append(el) }
      for (let i = 0; i < n; i++) {
        if (localDiscovery[i]) add(libraryEl(localDiscovery[i]))
        if (personal[i]) add(discoveryShelf(personal[i]))
        if (plainLibrary[i]) add(libraryEl(plainLibrary[i]))
        if (global[i]) add(discoveryShelf(global[i]))
      }
    }
    const discoveryOn = app.providers.length > 0
    paintFlow(lastDiscovery)
    let loader = null
    if (discoveryOn && !lastDiscovery) {
      loader = h('div', { class: 'online-only' }, skeletonShelf(), skeletonShelf())
      flow.prepend(loader)
    }

    if (stats.tracks) {
      get('/mixes', null, { signal }).then((res) => {
        const el = shelf({ id: 'mixes', title: t('player.home.mixes'), subtitle: t('player.home.mixesSub'), items: res.items, render: mixCard, cls: 'shelf--mixes' })
        if (el) mixesSlot.append(el)
      }).catch(() => {})
      get('/stats/listening', { range: 'week' }, { signal }).then((s) => {
        if (!s.plays) return
        const top = s.topArtists[0]
        tail.prepend(h('a', { class: 'stats-teaser lib-only', href: '#/stats' },
          h('span', { class: 'stats-teaser__icon' }, icon('chart', { size: 26 })),
          h('span', { class: 'stats-teaser__text' },
            h('b', { text: t('player.home.statsTeaser', { minutes: fmtNumber(s.minutes) }) }),
            h('span', { class: 'muted', text: top ? t('player.home.statsTeaserTop', { artist: top.name }) : t('player.stats.subtitle') })),
          icon('chevR', { size: 20 })))
      }).catch(() => {})
    }
    if (app.providers.includes('youtube')) {
      get('/discover/moods', null, { signal }).then((res) => {
        if (!res.items?.length) return
        tail.prepend(h('section', { class: 'shelf online-only' },
          h('div', { class: 'shelf__head' }, h('h2', { class: 'shelf__title', text: t('player.home.moods') })),
          h('div', { class: 'tile-grid tile-grid--moods' }, res.items.map((preset) => moodTile(preset)))))
      }).catch(() => {})
    }
    if (genres?.items?.length) {
      tail.append(h('section', { class: 'shelf lib-only' },
        h('div', { class: 'shelf__head' }, h('h2', { class: 'shelf__title', text: t('player.home.genres') })),
        h('div', { class: 'tile-grid' }, genres.items.map((g) => genreTile(g)))))
    }
    const shared = (app.playlists || []).filter((p) => !p.editable)
    if (shared.length) tail.append(shelf({ title: t('player.home.sharedPlaylists'), items: shared, render: playlistCard, cls: 'lib-only' }))
    if (!stats.tracks && !discoveryOn) fresh.append(emptyState('music', t('player.home.nothingTitle'), t('player.home.nothingText')))

    root.replaceChildren(fresh)
    loadedAt = Date.now()

    async function loadDiscovery(attempt = 0) {
      try {
        const data = await get('/discover', { lang: document.documentElement.lang || 'en' }, { signal })
        if (!data.enabled) { loader?.remove(); return }
        lastDiscovery = data
        discoveryAt = Date.now()
        paintFlow(data)
        if (data.partial && attempt < 2) setTimeout(() => { if (!signal.aborted) loadDiscovery(attempt + 1) }, 8000)
      } catch (error) {
        if (error?.name === 'AbortError') return
        loader?.remove()
      }
    }
    // Online shelves are cached server-side; ask again only when old.
    if (discoveryOn && (!lastDiscovery || Date.now() - discoveryAt > REFRESH_AFTER_MS || quiet)) loadDiscovery()
  }

  await build()

  return {
    node: root,
    keepAlive: true,
    onShow({ stale } = {}) {
      app.downloads?.repaintAll?.()
      if (stale || Date.now() - loadedAt > REFRESH_AFTER_MS) {
        controller.abort()
        controller = new AbortController()
        build({ quiet: true }).catch(() => {})
      }
    },
    onHide() {},
    cleanup() { controller.abort() }
  }
}
