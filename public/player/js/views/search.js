// Search: library results instantly, online results (Deezer / YouTube /
// Spotify) a moment later, a "download this link" shortcut, and browsing.

import { app } from '../app.js'
import { get, artworkUrl } from '../api.js'
import { h, t, icon, clear, artwork, skeletonShelf, emptyState, debounce, toastError, iconButton } from '../dom.js'
import { shelf, trackList, onlineTrackList, albumCard, artistCard, onlineCard, genreTile, moodTile, playTracks, playCollection, providerName, trackCard } from '../components.js'
import { loadSearchHistory, rememberQuery, rememberPick, forgetQuery, clearSearchHistory } from '../searchHistory.js'

// Picking a result (opening an album / artist / list) remembers it with the
// search text; songs are remembered when they start playing.
function picked(el, item, q) {
  el.addEventListener('click', () => rememberPick(item, q))
  return el
}

function linkKind(url) {
  if (/\/album\/|\/browse\/MPRE/i.test(url)) return 'album'
  if (/\/playlist[/?]|[?&]list=/i.test(url)) return 'playlist'
  return 'track'
}

function linkCard(url) {
  let host = ''
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { return null }
  const kind = linkKind(url)
  return h('div', { class: 'link-card' },
    h('div', { class: 'link-card__icon' }, icon('link', { size: 26 })),
    h('div', { class: 'link-card__text' },
      h('b', { text: t('player.search.linkTitle', { kind: t(`player.kind.${kind}`) }) }),
      h('span', { class: 'muted', text: host })),
    app.canDownload
      ? h('button', { type: 'button', class: 'btn btn--primary', onclick: () => app.downloads.request({ kind, url, title: url }) }, icon('download', { size: 18 }), t('player.downloads.download'))
      : h('span', { class: 'muted small', text: t('player.downloads.notAllowed') }))
}

// Nothing typed: what you picked from earlier searches (covers, like
// YouTube Music's "Recent searches"), the texts you searched for, then
// moods and genres to browse.
function browse(root, fillInput) {
  const recent = h('div', { class: 'search-recent' })
  root.append(recent)
  loadSearchHistory().then((history) => {
    if (!recent.isConnected) return
    paintHistory(recent, history, fillInput)
  }).catch(() => {})
  const moods = h('div')
  const genres = h('div')
  root.append(moods, genres)
  if (app.providers.includes('youtube')) {
    get('/discover/moods').then((res) => {
      if (res.items?.length) moods.append(h('section', { class: 'section' }, h('h2', { class: 'section-title', text: t('player.home.moods') }), h('div', { class: 'tile-grid tile-grid--moods' }, res.items.map(moodTile))))
    }).catch(() => {})
  }
  get('/genres', { limit: 60 }).then((res) => {
    if (res.items?.length) genres.append(h('section', { class: 'section' }, h('h2', { class: 'section-title', text: t('player.search.browseGenres') }), h('div', { class: 'tile-grid' }, res.items.map(genreTile))))
  }).catch(() => {})
}

function historyCard(entry) {
  if (entry.source === 'online') return onlineCard(entry.item, [entry.item], 0)
  if (entry.kind === 'track') return trackCard(entry.track, [entry.track], 0, null)
  if (entry.kind === 'album') return albumCard(entry.album)
  return artistCard(entry.artist)
}

function paintHistory(root, history, fillInput) {
  clear(root)
  const items = history.items || []
  const queries = history.queries || []
  if (!items.length && !queries.length) return
  const clearBtn = h('button', {
    type: 'button',
    class: 'link-btn',
    text: t('player.search.clearRecent'),
    onclick: () => clearSearchHistory().then(() => clear(root)).catch(toastError)
  })
  const row = shelf({
    title: t('player.search.recent'),
    items,
    cls: 'shelf--search-recent',
    tools: [clearBtn],
    render: (entry) => {
      const card = historyCard(entry)
      // Picking it again moves it to the front.
      card.addEventListener('click', () => rememberPick(entry.source === 'online'
        ? { source: 'online', online: entry.item }
        : { source: 'library', kind: entry.kind, id: (entry.track || entry.album || entry.artist).id }))
      return card
    }
  })
  root.append(row || h('div', { class: 'section-head' }, h('h2', { class: 'section-title', text: t('player.search.recent') }), clearBtn))
  if (!queries.length) return
  const list = h('ul', { class: 'search-history' })
  for (const { q } of queries.slice(0, 10)) {
    const line = h('li', { class: 'search-history__row' },
      h('a', { class: 'search-history__text', href: `#/search?q=${encodeURIComponent(q)}` },
        icon('history', { size: 22 }), h('span', { text: q })),
      iconButton('arrowUpLeft', t('player.search.useText'), () => fillInput(q), { cls: 'search-history__btn' }),
      iconButton('close', t('player.search.removeRecent'), () => forgetQuery(q).then(() => line.remove()).catch(toastError), { cls: 'search-history__btn search-history__remove' }))
    list.append(line)
  }
  root.append(list)
}

function topResult(local, q) {
  const needle = q.trim().toLowerCase()
  const artist = local.artists.find((a) => a.name.toLowerCase() === needle) || null
  const album = !artist && local.albums.find((a) => a.title.toLowerCase() === needle)
  const track = local.tracks[0]
  if (artist) {
    return picked(h('a', { class: 'top-result', href: `#/artist/${artist.id}` },
      artwork(artworkUrl(artist.artwork, 256), { round: true, cls: 'top-result__art', placeholder: 'user', seed: artist.name }),
      h('h3', { class: 'top-result__title', text: artist.name }),
      h('span', { class: 'pill', text: t('player.kind.artist') }),
      iconButton('play', t('player.common.play'), (e) => { e.preventDefault(); playCollection('artist', artist.id) }, { cls: 'play-fab top-result__play', size: 24 })),
    { source: 'library', kind: 'artist', id: artist.id }, q)
  }
  if (album) {
    return picked(h('a', { class: 'top-result', href: `#/album/${album.id}` },
      artwork(artworkUrl(album.artwork, 256), { cls: 'top-result__art', placeholder: 'album', seed: album.title }),
      h('h3', { class: 'top-result__title', text: album.title }),
      h('span', { class: 'muted' }, h('span', { class: 'pill', text: t('player.kind.album') }), ' ', album.artist),
      iconButton('play', t('player.common.play'), (e) => { e.preventDefault(); playCollection('album', album.id) }, { cls: 'play-fab top-result__play', size: 24 })),
    { source: 'library', kind: 'album', id: album.id }, q)
  }
  if (track) {
    const el = h('div', { class: 'top-result', tabindex: '0' },
      artwork(artworkUrl(track.artwork, 256), { cls: 'top-result__art', seed: track.album || track.title }),
      h('h3', { class: 'top-result__title', text: track.title }),
      h('span', { class: 'muted' }, h('span', { class: 'pill', text: t('player.kind.track') }), ' ', track.artist),
      iconButton('play', t('player.common.play'), () => playTracks(local.tracks, 0, { label: q, route: `/search?q=${encodeURIComponent(q)}` }), { cls: 'play-fab top-result__play', size: 24 }))
    el.addEventListener('dblclick', () => playTracks([track], 0, { label: q, route: `/search?q=${encodeURIComponent(q)}` }))
    return el
  }
  return null
}

export async function render(_name, _params, query) {
  const root = h('div', { class: 'search-view' })
  const body = h('div')
  const tabs = h('div', { class: 'chips' })
  let tab = 'all'
  for (const key of ['all', 'tracks', 'albums', 'artists', 'playlists', 'online']) {
    if ((key === 'online' || key === 'playlists') && !app.providers.length) continue
    const chip = h('button', { type: 'button', class: ['chip', key === tab && 'is-active'], text: t(`player.search.tab.${key}`) })
    chip.addEventListener('click', () => {
      tab = key
      tabs.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip))
      body.dataset.tab = key
    })
    tabs.append(chip)
  }
  body.dataset.tab = tab
  const mobileInput = h('input', { class: 'input input--search', type: 'search', placeholder: t('player.search.placeholder'), autocomplete: 'off' })
  root.append(h('div', { class: 'mobile-search' }, icon('search', { size: 20 }), mobileInput), body)
  mobileInput.addEventListener('input', debounce(() => history.replaceState(null, '', `#/search${mobileInput.value.trim() ? `?q=${encodeURIComponent(mobileInput.value.trim())}` : ''}`) || run(mobileInput.value.trim()), 250))

  let onlineController = null
  const onlineDebounced = debounce((q, slot) => loadOnline(q, slot), 550)

  async function loadOnline(q, slot) {
    onlineController?.abort()
    onlineController = new AbortController()
    const signal = onlineController.signal
    try {
      // Songs, albums and artists first; playlists and the artist's mixes
      // are asked afterwards so they never hold the main results back.
      const res = await get('/online/search', { q, kinds: 'track,album,artist', limit: 20 }, { signal })
      if (!slot.isConnected) return
      clear(slot)
      const context = { label: q, route: `/search?q=${encodeURIComponent(q)}` }
      const used = [...new Set([...(res.tracks || []), ...(res.albums || [])].map((x) => x.provider))].map(providerName).join(' · ')
      const mixSlot = h('div', { class: 'sec-mixes' })
      const playlistSlot = h('div', { class: 'sec-playlists' })
      let mixes = null
      let found = null
      const paintLists = () => {
        clear(mixSlot)
        clear(playlistSlot)
        if (mixes?.mixes?.length) mixSlot.append(shelf({ title: t('player.search.mixes', { artist: mixes.artist }), items: mixes.mixes, render: (item, i) => picked(onlineCard(item, mixes.mixes, i, context), { source: 'online', online: item }, q), cls: 'shelf--mixes-online' }))
        const seen = new Set()
        const lists = [...(mixes?.playlists || []), ...(found?.playlists || [])].filter((p) => {
          const key = p.url || `${p.provider}:${p.id}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        if (lists.length) playlistSlot.append(shelf({ title: t('player.search.onlinePlaylists'), items: lists, render: (item, i) => picked(onlineCard(item, lists, i, context), { source: 'online', online: item }, q) }))
      }
      const later = (promise, apply) => promise.then((value) => {
        if (!value || signal.aborted || !slot.isConnected) return
        apply(value)
        paintLists()
      }).catch(() => {})
      later(get('/online/search', { q, kinds: 'playlist', limit: 20 }, { signal }), (value) => { found = value })
      if (q.length >= 2) later(get('/online/artist-mixes', { name: q, lang: document.documentElement.lang || 'en' }, { signal }), (value) => { mixes = value })
      if (!res.tracks?.length && !res.albums?.length && !res.artists?.length) {
        slot.append(h('p', { class: 'muted', text: t('player.search.onlineNone') }), mixSlot, playlistSlot)
        return
      }
      slot.append(h('div', { class: 'section-head' },
        h('h2', { class: 'section-title' }, icon('globe', { size: 22 }), t('player.search.online')),
        used ? h('span', { class: 'muted small', text: used }) : null))
      if (res.tracks?.length) slot.append(h('div', { class: 'section sec-tracks' }, onlineTrackList(res.tracks.slice(0, 12), { context })))
      slot.append(mixSlot)
      if (res.albums?.length) slot.append(h('div', { class: 'sec-albums' }, shelf({ title: t('player.search.onlineAlbums'), items: res.albums, render: (item, i) => picked(onlineCard(item, res.albums, i), { source: 'online', online: item }, q) })))
      slot.append(playlistSlot)
      if (res.artists?.length) slot.append(h('div', { class: 'sec-artists' }, shelf({ title: t('player.search.onlineArtists'), items: res.artists, render: (item, i) => picked(onlineCard(item, res.artists, i), { source: 'online', online: item }, q) })))
      if (res.errors?.length) slot.append(h('p', { class: 'muted small', text: t('player.search.partialProviders', { list: res.errors.map((e) => providerName(e.provider)).join(', ') }) }))
    } catch (error) {
      if (error?.name === 'AbortError') return
      clear(slot)
      slot.append(h('p', { class: 'muted', text: t('player.search.onlineFailed') }))
      if (error?.status && error.status !== 409) toastError(error)
    }
  }

  let seq = 0
  async function run(q) {
    const mine = ++seq
    onlineController?.abort()
    onlineDebounced.cancel()
    if (mobileInput.value.trim() !== q && document.activeElement !== mobileInput) mobileInput.value = q
    clear(body)
    if (!q) {
      tabs.remove()
      browse(body, fillInput)
      return
    }
    root.insertBefore(tabs, body)
    if (/^https?:\/\//i.test(q)) {
      const card = linkCard(q)
      if (card) { body.append(card); return }
    }
    let local
    try { local = await get('/search', { q, limit: 50 }) } catch (error) { toastError(error); return }
    if (mine !== seq) return
    const context = { label: q, route: `/search?q=${encodeURIComponent(q)}` }
    const hasLocal = local.tracks.length || local.albums.length || local.artists.length
    if (hasLocal) {
      const top = topResult(local, q)
      body.append(h('div', { class: 'search-top sec-all' },
        top ? h('section', {}, h('h2', { class: 'section-title', text: t('player.search.top') }), top) : null,
        local.tracks.length ? h('section', { class: 'search-top__songs' }, h('h2', { class: 'section-title', text: t('player.search.songs') }), trackList(local.tracks.slice(0, 5), { context, showAlbum: false })) : null))
      if (local.tracks.length) body.append(h('section', { class: 'section sec-tracks-only' }, trackList(local.tracks, { context })))
      if (local.artists.length) body.append(h('div', { class: 'sec-artists' }, shelf({ title: t('player.library.artists'), items: local.artists, render: (a) => picked(artistCard(a), { source: 'library', kind: 'artist', id: a.id }, q) })))
      if (local.albums.length) body.append(h('div', { class: 'sec-albums' }, shelf({ title: t('player.library.albums'), items: local.albums, render: (a) => picked(albumCard(a), { source: 'library', kind: 'album', id: a.id }, q) })))
    } else {
      body.append(h('div', { class: 'sec-local-empty' }, emptyState('search', t('player.search.noLocal', { q }), app.providers.length ? t('player.search.noLocalOnline') : '')))
    }
    if (app.providers.length) {
      const slot = h('section', { class: 'online-results sec-online' }, skeletonShelf(5))
      body.append(slot)
      onlineDebounced(q, slot)
    }
  }

  // The arrow next to a past search puts its text in the box to edit it.
  function fillInput(q) {
    const input = window.matchMedia?.('(max-width: 760px)').matches || !document.getElementById('globalSearch')?.offsetParent
      ? mobileInput
      : document.getElementById('globalSearch')
    input.value = `${q} `
    input.focus()
    input.setSelectionRange?.(input.value.length, input.value.length)
  }
  // Enter = this is what I was looking for.
  mobileInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') rememberQuery(mobileInput.value) })
  run((query.get('q') || '').trim())
  const unsub = (await import('../app.js')).bus.on('route:query', ({ query: qs }) => run((qs.get('q') || '').trim()))
  return { node: root, cleanup: () => { unsub(); onlineController?.abort(); onlineDebounced.cancel() } }
}
