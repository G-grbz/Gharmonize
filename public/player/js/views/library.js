// Library browsing: playlists / albums / artists / songs, liked songs,
// listening history and genre pages.

import { app, bus, store } from '../app.js'
import { get } from '../api.js'
import { h, t, icon, clear, emptyState, fmtLong, plural } from '../dom.js'
import { albumCard, artistCard, playlistCard, trackList, infinite, actionBar, hero, playCollection, playTracks, createPlaylistFlow, shelf, trackCard, selectButton } from '../components.js'
import { saveButton } from '../playlistSave.js'

const TABS = ['playlists', 'albums', 'artists', 'tracks']
const SORTS = {
  albums: ['recent', 'alpha', 'artist', 'year', 'random'],
  artists: ['alpha', 'tracks', 'random'],
  tracks: ['recent', 'alpha', 'artist', 'random']
}

function libraryView(tabParam) {
  const tab = TABS.includes(tabParam) ? tabParam : store.get('libraryTab', 'playlists')
  store.set('libraryTab', tab)
  const root = h('div', { class: 'library' })
  const tabs = h('div', { class: 'chips' }, TABS.map((key) => h('a', { class: ['chip', key === tab && 'is-active'], href: `#/library/${key}`, text: t(`player.library.${key}`) })))
  const tools = h('div', { class: 'library__tools' })
  const content = h('div')
  root.append(h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: t('player.nav.library') }), tools), tabs, content)

  if (tab === 'playlists') {
    tools.append(h('button', { type: 'button', class: 'btn btn--outline', onclick: () => createPlaylistFlow().then((pl) => pl && app.nav(`/playlist/${pl.id}`)) }, icon('plus', { size: 18 }), t('player.playlist.create')))
    const gridEl = h('div', { class: 'card-grid' })
    const liked = h('a', { class: 'card card--liked', href: '#/liked' },
      h('div', { class: 'liked-art' }, icon('heartFill', { size: 42 })),
      h('div', { class: 'card__title', text: t('player.nav.liked') }),
      h('div', { class: 'card__sub', text: t('player.kind.playlist') }))
    gridEl.append(liked)
    for (const pl of app.playlists || []) gridEl.append(playlistCard(pl))
    content.append(gridEl)
    if (!(app.playlists || []).length) content.append(h('p', { class: 'muted', text: t('player.library.noPlaylists') }))
    return { node: root }
  }

  const sortKey = `librarySort.${tab}`
  const sort = store.get(sortKey, SORTS[tab][0])
  const select = h('select', { class: 'select', 'aria-label': t('player.library.sort') },
    SORTS[tab].map((s) => h('option', { value: s, selected: s === sort, text: t(`player.sort.${s}`) })))
  select.addEventListener('change', () => { store.set(sortKey, select.value); bus.emit('library:resort') ; window.dispatchEvent(new HashChangeEvent('hashchange')) })
  tools.append(select)

  if (tab === 'tracks') {
    const playAll = h('button', { type: 'button', class: 'btn btn--primary', onclick: async () => { const r = await get('/tracks', { sort: 'random', limit: 500 }); playTracks(r.items, 0, { label: t('player.library.tracks'), route: '/library/tracks' }) } }, icon('shuffle', { size: 18 }), t('player.library.shuffleAll'))
    tools.prepend(playAll)
    const holder = h('div')
    content.append(holder)
    let all = []
    const page = 200
    let offset = 0
    let done = false
    const sentinel = h('div', { class: 'sentinel' })
    content.append(sentinel)
    const load = async () => {
      if (done) return
      done = true
      const res = await get('/tracks', { sort, limit: page, offset })
      all = all.concat(res.items)
      offset += res.items.length
      clear(holder)
      if (!all.length) holder.append(emptyState('music', t('player.library.emptyTracks')))
      else holder.append(trackList(all, { context: { label: t('player.library.tracks'), route: '/library/tracks' } }))
      done = res.items.length < page
      if (!done) observer.observe(sentinel)
    }
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { observer.disconnect(); load() } }, { rootMargin: '800px' })
    load()
    return { node: root, cleanup: () => observer.disconnect() }
  }

  const gridEl = h('div', { class: 'card-grid' })
  content.append(gridEl)
  const path = tab === 'albums' ? '/albums' : '/artists'
  infinite(gridEl, async (offset, limit) => {
    const res = await get(path, { sort, limit, offset })
    if (!offset && !res.items.length) gridEl.replaceWith(emptyState(tab === 'albums' ? 'album' : 'user', t(`player.library.empty.${tab}`)))
    return res.items
  }, (item) => (tab === 'albums' ? albumCard(item) : artistCard(item)), { page: 60 })
  return { node: root }
}

async function likedView() {
  const res = await get('/tracks', { favorites: 1, limit: 500 })
  const tracks = res.items || []
  const total = tracks.reduce((s, tr) => s + (tr.duration || 0), 0)
  const art = h('div', { class: 'liked-art liked-art--hero' }, icon('heartFill', { size: 72 }))
  const root = h('div', { class: 'detail' },
    hero({ art, kind: t('player.kind.playlist'), title: t('player.nav.liked'), meta: [app.user?.displayName, plural(tracks.length, 'player.count.track', 'player.count.tracks'), total ? fmtLong(total) : null] }))
  document.getElementById('main')?.style.setProperty('--tint', '92 70 160')
  if (!tracks.length) {
    root.append(emptyState('heart', t('player.liked.emptyTitle'), t('player.liked.emptyText')))
    return { node: root, hero: true }
  }
  const context = { label: t('player.nav.liked'), route: '/liked' }
  root.append(actionBar({
    onPlay: () => playTracks(tracks, 0, context, { shuffle: false }),
    onShuffle: () => playTracks(tracks, Math.floor(Math.random() * tracks.length), context, { shuffle: true }),
    extra: [saveButton(() => ({ name: t('player.nav.liked'), trackIds: tracks.map((tr) => tr.id), count: tracks.length }), { cls: 'icon-btn--lg', size: 24 }), selectButton(() => root.querySelector('.tracklist'))]
  }),
    trackList(tracks, { context }))
  return { node: root, hero: true }
}

async function historyView() {
  const [recent, month, all] = await Promise.all([
    get('/history/recent', { limit: 50 }),
    get('/history/top', { days: 30, limit: 50 }),
    get('/history/top', { limit: 50 })
  ])
  const root = h('div', { class: 'history' }, h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: t('player.nav.history') })))
  if (!recent.items.length) {
    root.append(emptyState('history', t('player.history.emptyTitle'), t('player.history.emptyText')))
    return { node: root }
  }
  root.append(shelf({ title: t('player.home.recentlyPlayed'), items: recent.items, render: (tr, i) => trackCard(tr, recent.items, i, { label: t('player.nav.history'), route: '/history' }) }))
  if (month.items.length) root.append(h('section', { class: 'section' }, h('h2', { class: 'section-title', text: t('player.history.month') }), trackList(month.items, { showPlays: true, showAlbum: false, context: { label: t('player.history.month'), route: '/history' } })))
  if (all.items.length) root.append(h('section', { class: 'section' }, h('h2', { class: 'section-title', text: t('player.history.allTime') }), trackList(all.items, { showPlays: true, showAlbum: false, context: { label: t('player.history.allTime'), route: '/history' } })))
  return { node: root }
}

async function genreView(name) {
  const [tracks, albums] = await Promise.all([
    get('/tracks', { genre: name, sort: 'artist', limit: 500 }),
    get('/albums', { genre: name, sort: 'year', limit: 100 })
  ])
  const root = h('div', { class: 'detail' },
    hero({ art: h('div', { class: 'genre-art', text: name.slice(0, 2).toUpperCase() }), kind: t('player.kind.genre'), title: name, meta: [plural(tracks.items.length, 'player.count.track', 'player.count.tracks'), plural(albums.items.length, 'player.count.album', 'player.count.albums')] }))
  const context = { label: name, route: `/genre/${encodeURIComponent(name)}` }
  root.append(actionBar({ onPlay: () => playCollection('genre', name), onShuffle: () => playTracks(tracks.items, 0, context, { shuffle: true }), extra: [selectButton(() => root.querySelector('.tracklist'))] }))
  if (albums.items.length) root.append(shelf({ title: t('player.library.albums'), items: albums.items, render: albumCard }))
  if (tracks.items.length) root.append(h('section', { class: 'section' }, h('h2', { class: 'section-title', text: t('player.library.tracks') }), trackList(tracks.items, { context })))
  return { node: root, hero: true }
}

export async function render(name, params) {
  if (name === 'liked') return likedView()
  if (name === 'history') return historyView()
  if (name === 'genre') return genreView(params[0])
  return libraryView(params[0])
}
