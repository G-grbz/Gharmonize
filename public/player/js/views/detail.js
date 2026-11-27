// Library detail pages: album, artist, playlist.

import { app } from '../app.js'
import { get, post, patch, del, artworkUrl } from '../api.js'
import { h, t, icon, iconButton, clear, artwork, fmtLong, fmtNumber, plural, contextMenu, modal, toast, toastError, confirmDialog, skeletonShelf, debounce, emptyState, fmtRelative, spinner } from '../dom.js'
import {
  hero, actionBar, trackList, onlineTrackList, shelf, albumCard, onlineCard, heartButton, playTracks, playCollection, queueCollection,
  playlistSubmenu, refreshPlaylists, primaryArtist, selectButton, providerName, artistBio,
  artistLinks
} from '../components.js'
import { saveButton } from '../playlistSave.js'
import { downloadButton } from '../downloads.js'
import { discographyCard } from '../discographyWizard.js'
import { randomIndex } from '../random.js'

// ---- album ------------------------------------------------------------------

async function albumView(id) {
  const album = await get(`/albums/${id}`)
  const src = artworkUrl(album.artwork, 512)
  const context = { label: album.title, route: `/album/${id}` }
  const discs = new Set(album.tracks.map((tr) => tr.discNo || 1)).size
  const root = h('div', { class: 'detail' },
    hero({
      art: artwork(src, { alt: album.title, placeholder: 'album', seed: album.title, lazy: false }),
      artSrc: src,
      kind: album.trackCount <= 3 ? t('player.kind.single') : t('player.kind.album'),
      title: album.title,
      meta: [
        album.artists?.length > 1
          ? h('span', { class: 'hero__artist' }, artwork(artworkUrl(`artist/${album.artists[0].id}`, 64), { round: true, cls: 'hero__avatar', placeholder: 'user', seed: album.artists[0].name }), h('span', {}, ...artistLinks(album)))
          : album.artistId ? h('a', { class: 'hero__artist', href: `#/artist/${album.artistId}` }, artwork(artworkUrl(`artist/${album.artistId}`, 64), { round: true, cls: 'hero__avatar', placeholder: 'user', seed: album.artist }), album.artist) : album.artist,
        album.year,
        plural(album.trackCount, 'player.count.track', 'player.count.tracks'),
        album.duration ? fmtLong(album.duration) : null,
        album.lossless ? h('span', { class: 'chip-mini chip-mini--accent', text: t('player.badge.lossless') }) : null
      ]
    }))
  const more = iconButton('more', t('player.common.more'), (e) => contextMenu([
    { label: t('player.menu.playNext'), icon: 'playNext', run: () => queueCollection('album', id, 'next') },
    { label: t('player.menu.addToQueue'), icon: 'queue', run: () => queueCollection('album', id, 'add') },
    { label: t('player.menu.addToPlaylist'), icon: 'playlistAdd', submenu: playlistSubmenu(async () => album.tracks.map((tr) => tr.id)) },
    album.artistId && { label: t('player.menu.goToArtist'), icon: 'user', run: () => app.nav(`/artist/${album.artistId}`) },
    app.providers.includes('deezer') && album.artist && { label: t('player.menu.moreOnline'), icon: 'globe', run: () => app.nav(`/online/artist?name=${encodeURIComponent(primaryArtist(album.artist))}`) }
  ], e.currentTarget), { cls: 'icon-btn--lg', size: 26 })
  root.append(actionBar({
    onPlay: () => playTracks(album.tracks, 0, context, { shuffle: false }),
    onShuffle: () => playTracks(album.tracks, randomIndex(Math.max(1, album.tracks.length)), context, { shuffle: true }),
    extra: [heartButton('album', album.id, album.favorite, { size: 26, cls: 'icon-btn--lg' }),
      saveButton(() => ({ name: album.title, trackIds: album.tracks.map((tr) => tr.id), count: album.tracks.length }), { cls: 'icon-btn--lg', size: 24 }),
      selectButton(() => root.querySelector('.tracklist')), more]
  }))
  if (discs > 1) {
    for (const disc of [...new Set(album.tracks.map((tr) => tr.discNo || 1))].sort((a, b) => a - b)) {
      const list = album.tracks.filter((tr) => (tr.discNo || 1) === disc)
      root.append(h('h3', { class: 'disc-head' }, icon('disc', { size: 18 }), t('player.album.disc', { n: disc })), trackList(list, { context, showAlbum: false, showArt: false, numbered: true }))
    }
  } else {
    root.append(trackList(album.tracks, { context, showAlbum: false, showArt: false, numbered: true }))
  }
  if (app.providers.includes('deezer')) {
    const slot = h('div', { class: 'album-missing-slot' })
    root.append(slot)
    loadAlbumMissing(id, album, slot)
  }
  const added = album.addedAt ? h('p', { class: 'muted small detail__foot', text: t('player.album.added', { when: fmtRelative(album.addedAt) }) }) : null
  if (added) root.append(added)
  if (album.artistId) {
    get('/albums', { artistId: album.artistId, sort: 'year', limit: 30 }).then((res) => {
      const others = res.items.filter((a) => a.id !== album.id)
      if (others.length) root.append(shelf({ title: t('player.album.moreBy', { artist: album.artist }), items: others, render: albumCard }))
    }).catch(() => {})
  }
  return { node: root, hero: true }
}

// Songs of this album that are not in the library yet, ready to download.
async function loadAlbumMissing(id, album, slot) {
  let data
  try { data = await get(`/albums/${id}/missing`) } catch { return }
  if (!slot.isConnected || !data?.found || !data.missing?.length) return
  const missing = data.missing
  const context = { label: album.title }
  const actions = h('div', { class: 'album-missing__actions' })
  if (app.canDownload) {
    const all = h('button', { type: 'button', class: 'btn btn--primary btn--sm' }, icon('download', { size: 16 }), t('player.album.downloadMissing', { n: missing.length }))
    all.addEventListener('click', async () => {
      all.disabled = true
      const wanted = missing.filter((item) => {
        const state = app.downloads.stateFor(item)
        return !item.library?.trackId && !(state && state.status !== 'failed' && state.status !== 'canceled')
      })
      if (!(await app.downloads.requestMany(wanted, { title: album.title, artworkUrl: data.album?.artworkUrl }))) all.disabled = false
    })
    actions.append(all)
  }
  if (data.album?.provider === 'deezer' && data.album.id) actions.append(h('a', { class: 'btn btn--ghost btn--sm', href: `#/online/album?provider=deezer&id=${encodeURIComponent(data.album.id)}`, text: t('player.album.openOnline') }))
  slot.append(h('section', { class: 'section album-missing' },
    h('div', { class: 'album-missing__head' },
      h('div', {},
        h('h2', { class: 'section-title', text: t('player.album.missingTitle') }),
        h('p', { class: 'muted small', text: t('player.album.missingText', { n: missing.length, total: data.total }) })),
      actions),
    onlineTrackList(missing, { context, showAlbum: false, numbered: false })))
}

// ---- artist -------------------------------------------------------------------

// One artist page for library and online: the library rows plus every row
// of the online page (popular, albums, singles & EPs, related). `online` is
// the /online/artist answer when the online page already loaded it.
export async function renderArtistPage(id, online = null) {
  return artistView(id, online)
}

async function artistView(id, preOnline = null) {
  const artist = await get(`/artists/${id}`)
  const src = artworkUrl(artist.artwork, 512)
  const context = { label: artist.name, route: `/artist/${id}` }
  const root = h('div', { class: 'detail detail--artist' },
    hero({
      art: artwork(src, { alt: artist.name, round: true, placeholder: 'user', seed: artist.name, lazy: false }),
      artSrc: src,
      round: true,
      kind: t('player.kind.artist'),
      title: artist.name,
      meta: [plural(artist.trackCount, 'player.count.track', 'player.count.tracks'), plural(artist.albumCount, 'player.count.album', 'player.count.albums')]
    }))
  const follow = h('button', { type: 'button', class: ['btn', 'btn--outline', 'btn--pill', artist.favorite && 'is-on'], text: artist.favorite ? t('player.artist.following') : t('player.artist.follow') })
  follow.addEventListener('click', async () => {
    const next = !follow.classList.contains('is-on')
    const { toggleFavorite } = await import('../components.js')
    const value = await toggleFavorite('artist', artist.id, next)
    follow.classList.toggle('is-on', value)
    follow.textContent = value ? t('player.artist.following') : t('player.artist.follow')
  })
  root.append(actionBar({
    onPlay: () => playCollection('artist', artist.id, { shuffle: false, context }),
    onShuffle: () => playCollection('artist', artist.id, { shuffle: true, context }),
    extra: [follow, iconButton('more', t('player.common.more'), (e) => contextMenu([
      { label: t('player.menu.playNext'), icon: 'playNext', run: () => queueCollection('artist', id, 'next') },
      { label: t('player.menu.addToQueue'), icon: 'queue', run: () => queueCollection('artist', id, 'add') }
    ], e.currentTarget), { cls: 'icon-btn--lg', size: 26 })]
  }))

  if (artist.topTracks.length) {
    const popular = h('section', { class: 'section' }, h('h2', { class: 'section-title', text: t('player.artist.popular') }))
    let expanded = false
    const holder = h('div')
    const toggleBtn = h('button', { type: 'button', class: 'link-btn' })
    const paint = () => {
      clear(holder)
      holder.append(trackList(artist.topTracks.slice(0, expanded ? 10 : 5), { context, showAlbum: true, showPlays: true }))
      toggleBtn.textContent = expanded ? t('player.common.showLess') : t('player.common.showMore')
    }
    toggleBtn.addEventListener('click', () => { expanded = !expanded; paint() })
    paint()
    popular.append(holder)
    if (artist.topTracks.length > 5) popular.append(toggleBtn)
    root.append(popular)
  }
  if (artist.albums.length) root.append(shelf({ title: t('player.artist.discography'), items: artist.albums, render: albumCard }))
  // Online rows sit between the discography and the (long) song list; the
  // related artists close the page.
  const online = app.providers.includes('deezer') || preOnline
  const slot = online ? h('div', { class: 'online-artist-slot' }, preOnline ? null : skeletonShelf(5)) : null
  const relatedSlot = online ? h('div', { class: 'online-artist-slot' }) : null
  if (slot) root.append(slot)
  // Biography in the free space of the hero (filled once found).
  const bioSlot = app.providers.length || preOnline ? h('div', { class: 'hero__bio', hidden: true }) : null
  if (bioSlot) root.querySelector('.hero')?.append(bioSlot)
  if (artist.trackCount) root.append(artistAllSongs(artist, context))
  if (artist.singles.length) root.append(h('section', { class: 'section' }, h('h2', { class: 'section-title', text: t('player.artist.singles') }), trackList(artist.singles, { context, showAlbum: false })))
  if (artist.appearsOn.length) root.append(shelf({ title: t('player.artist.appearsOn'), items: artist.appearsOn, render: albumCard }))
  if (relatedSlot) root.append(relatedSlot)
  if (online) {
    const heroMeta = root.querySelector('.hero__meta')
    if (preOnline) paintOnlineArtist(preOnline, artist.name, slot, relatedSlot, heroMeta, bioSlot)
    else loadOnlineArtist(artist.name, slot, relatedSlot, heroMeta, bioSlot)
  } else if (bioSlot) artistBio(bioSlot, { name: artist.name })
  return { node: root, hero: true }
}

// Every song of the artist in the library, with sorting and multi-select
// (play, queue, add to a playlist, like) like album and playlist pages.
const ARTIST_SORTS = ['album', 'alpha', 'recent', 'plays']
function artistAllSongs(artist, context) {
  const sort = h('select', { class: 'select select--sm', 'aria-label': t('player.library.sort') },
    ARTIST_SORTS.map((key) => h('option', { value: key, text: t(`player.artist.sort.${key}`), selected: key === (app.prefs.artistSongsSort || 'album') })))
  const listSlot = h('div', { class: 'artist-all__list' }, spinner(24))
  const libraryTools = h('div', { class: 'artist-all__tools' }, sort, selectButton(() => listSlot.querySelector('.tracklist')))
  // Library | Online: every song of the artist on Deezer, missing ones
  // can be picked and downloaded.
  const withOnline = app.providers.includes('deezer')
  const onlineSlot = h('div', { class: 'artist-all__list', hidden: true })
  const onlineTools = h('div', { class: 'artist-all__tools', hidden: true })
  const tabs = withOnline ? h('div', { class: 'chips artist-all__tabs' }) : null
  const section = h('section', { class: 'section artist-all' },
    h('div', { class: 'section-head' },
      h('h2', { class: 'section-title' }, t('player.artist.allSongs'), h('span', { class: 'muted artist-all__count', text: ` · ${artist.trackCount}` })),
      libraryTools, onlineTools),
    tabs,
    listSlot, onlineSlot)
  let seq = 0
  const load = async () => {
    const mine = ++seq
    try {
      const res = await get(`/artists/${artist.id}/tracks`, { sort: sort.value, limit: 500 })
      if (mine !== seq) return
      listSlot.replaceChildren(res.items.length
        ? trackList(res.items, { context, showAlbum: true, showPlays: sort.value === 'plays' })
        : emptyState('music', t('player.artist.noSongs')))
    } catch (error) {
      if (mine === seq) { listSlot.replaceChildren(); toastError(error) }
    }
  }
  sort.addEventListener('change', () => { app.setPref('artistSongsSort', sort.value); load() })
  load()
  if (tabs) {
    let onlineLoaded = false
    const show = (online) => {
      tabs.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', (c.dataset.tab === 'online') === online))
      listSlot.hidden = online
      libraryTools.hidden = online
      onlineSlot.hidden = !online
      onlineTools.hidden = !online
      if (online && !onlineLoaded) { onlineLoaded = true; loadArtistOnlineSongs(artist.name, onlineSlot, onlineTools) }
    }
    for (const [key, label] of [['library', t('player.artist.tabLibrary')], ['online', t('player.artist.tabOnline')]]) {
      tabs.append(h('button', { type: 'button', class: ['chip', key === 'library' && 'is-active'], dataset: { tab: key }, text: label, onclick: () => show(key === 'online') }))
    }
  }
  return section
}

// The artist's songs on Deezer, newest release first; songs not in the
// library get a checkbox, "select missing" ticks them all and one button
// downloads the picked ones.
async function loadArtistOnlineSongs(name, slot, tools) {
  slot.replaceChildren(spinner(24))
  let data
  try {
    data = await get('/online/artist/tracks', { name })
  } catch (error) {
    slot.replaceChildren(emptyState('globe', t('player.artist.onlineSongsFailed')))
    if (error?.status && error.status !== 404) toastError(error)
    return
  }
  if (!slot.isConnected) return
  const tracks = data.tracks || []
  if (!tracks.length) { slot.replaceChildren(emptyState('globe', t('player.artist.onlineSongsNone'))); return }
  const picked = new Set()
  const boxes = new Map()
  const summary = h('span', { class: 'muted small', text: t('player.artist.onlineSongsCount', { n: tracks.length, missing: data.missing || 0 }) })
  const downloadBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm', disabled: true })
  const selectMissing = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: t('player.artist.selectMissing') })
  const canPick = (item) => app.canDownload && !item.library && !(app.downloads.stateFor(item) && !['failed', 'canceled'].includes(app.downloads.stateFor(item).status))
  const refresh = () => {
    downloadBtn.textContent = t('player.artist.downloadPicked', { n: picked.size })
    downloadBtn.disabled = !picked.size
    selectMissing.textContent = picked.size ? t('player.artist.clearPicked') : t('player.artist.selectMissing')
  }
  selectMissing.addEventListener('click', () => {
    const clearing = picked.size > 0
    picked.clear()
    for (const [item, box] of boxes) {
      box.checked = !clearing && canPick(item)
      if (box.checked) picked.add(item)
    }
    refresh()
  })
  // One request for the whole selection: songs over the queue limit wait
  // on the server and follow as earlier ones finish.
  downloadBtn.addEventListener('click', async () => {
    downloadBtn.disabled = true
    const wanted = [...picked].filter(canPick)
    const group = await app.downloads.requestMany(wanted, { title: t('player.downloads.group.artistSongs', { name }) })
    if (!group) { refresh(); return }
    for (const item of wanted) {
      const box = boxes.get(item)
      if (box) { box.checked = false; box.disabled = true }
    }
    picked.clear()
    refresh()
  })
  tools.replaceChildren(summary, app.canDownload ? selectMissing : null, app.canDownload ? downloadBtn : null)
  refresh()
  const context = { label: name, route: `/online/artist?name=${encodeURIComponent(name)}` }
  slot.replaceChildren(onlineTrackList(tracks, {
    context,
    showAlbum: true,
    action: app.canDownload
      ? (item) => {
          if (item.library) return null
          const box = h('input', { type: 'checkbox', class: 'artist-all__pick', 'aria-label': t('player.artist.pickSong'), disabled: !canPick(item) })
          box.addEventListener('click', (e) => e.stopPropagation())
          box.addEventListener('change', () => { if (box.checked) picked.add(item); else picked.delete(item); refresh() })
          boxes.set(item, box)
          return h('span', { class: 'artist-all__pickwrap' }, box, downloadButton(item))
        }
      : null
  }))
}

async function loadOnlineArtist(name, slot, relatedSlot, heroMeta, bioSlot) {
  try {
    const data = await get('/online/artist', { name })
    if (!slot.isConnected) return
    paintOnlineArtist(data, name, slot, relatedSlot, heroMeta, bioSlot)
  } catch {
    slot.remove()
    relatedSlot.remove()
    if (bioSlot?.isConnected) artistBio(bioSlot, { name })
  }
}

function paintOnlineArtist(data, name, slot, relatedSlot, heroMeta, bioSlot) {
  clear(slot)
  clear(relatedSlot)
  if (bioSlot) artistBio(bioSlot, { name, deezerId: data.artist.provider === 'deezer' ? data.artist.id : null })
  const provider = providerName(data.artist.provider)
  const titled = (key) => `${t(key)} · ${provider}`
  const context = { label: name }
  if (data.artist.fans && heroMeta) heroMeta.append(h('span', { class: 'dot', text: '•' }), t('player.online.fans', { n: fmtNumber(data.artist.fans) }))
  const top = data.topTracks.slice(0, 10)
  // Only when something is missing: a library artist page needs no "complete" note.
  const card = discographyCard(data, { name, quietWhenComplete: true })
  if (card) slot.append(card)
  if (top.length) slot.append(h('section', { class: 'section' }, h('h2', { class: 'section-title', text: titled('player.artist.popular') }), onlineTrackList(top, { context })))
  if (data.albums.length) slot.append(shelf({ title: titled('player.artist.albums'), items: data.albums, render: (item, i) => onlineCard(item, data.albums, i) }))
  if (data.singles.length) slot.append(shelf({ title: titled('player.artist.singlesEps'), items: data.singles, render: (item, i) => onlineCard(item, data.singles, i) }))
  if (data.related.length) relatedSlot.append(shelf({ title: t('player.artist.related'), items: data.related, render: (item, i) => onlineCard(item, data.related, i) }))
}

// ---- playlist -------------------------------------------------------------------

function editPlaylist(pl) {
  return modal({
    title: t('player.playlist.edit'),
    build: (close) => {
      const name = h('input', { class: 'input', type: 'text', value: pl.name, maxlength: 120, required: true })
      const desc = h('textarea', { class: 'input', rows: 3, maxlength: 1000 })
      desc.value = pl.description || ''
      const pub = h('input', { type: 'checkbox', checked: pl.isPublic })
      const form = h('form', { class: 'stack' },
        h('label', { class: 'field' }, h('span', { class: 'field__label', text: t('player.playlist.name') }), name),
        h('label', { class: 'field' }, h('span', { class: 'field__label', text: t('player.playlist.description') }), desc),
        h('label', { class: 'check' }, pub, h('span', {}, h('b', { text: t('player.playlist.public') }), h('small', { class: 'muted', text: t('player.playlist.publicHint') }))),
        h('div', { class: 'modal__actions' },
          h('button', { type: 'button', class: 'btn btn--ghost', text: t('player.common.cancel'), onclick: () => close(null) }),
          h('button', { type: 'submit', class: 'btn btn--primary', text: t('player.common.save') })))
      form.addEventListener('submit', async (e) => {
        e.preventDefault()
        try {
          const updated = await patch(`/playlists/${pl.id}`, { name: name.value.trim(), description: desc.value, isPublic: pub.checked })
          await refreshPlaylists()
          close(updated)
        } catch (error) { toastError(error) }
      })
      return form
    }
  })
}

// "Goes well with this playlist": library songs are added right away, new
// ones are downloaded and join the playlist when the download finishes.
function playlistSuggestions(pl, onAdded) {
  const list = h('div', { class: 'pl-suggest__list' })
  let round = 0
  const refresh = iconButton('refresh', t('player.playlist.suggestRefresh'), () => { round += 1; load() }, { cls: 'ctl', size: 18 })
  const section = h('section', { class: 'section pl-suggest', hidden: true },
    h('div', { class: 'shelf__head' },
      h('div', { class: 'shelf__titles' },
        h('h2', { class: 'section-title', text: t('player.playlist.suggestTitle') }),
        h('p', { class: 'shelf__subtitle', text: t(app.canDownload ? 'player.playlist.suggestHintDownload' : 'player.playlist.suggestHint') })),
      refresh),
    list)

  function addButton(item, row) {
    const owned = item.library?.trackId
    if (!owned && !app.canDownload) return null
    const btn = iconButton('plus', t('player.playlist.suggestAdd'), async (e) => {
      e.stopPropagation()
      btn.disabled = true
      try {
        if (owned) {
          await post(`/playlists/${pl.id}/tracks`, { trackIds: [owned] })
          toast(t('player.playlist.suggestAdded', { title: item.title }), { type: 'success' })
          row.remove()
          await onAdded?.()
          refreshPlaylists().catch(() => {})
        } else {
          const res = await app.downloads.request(item, { playlistId: pl.id, quiet: true })
          if (!res) { btn.disabled = false; return }
          toast(t('player.playlist.suggestDownloading', { title: item.title }))
          btn.replaceWith(downloadButton(item))
        }
      } catch (error) { btn.disabled = false; toastError(error) }
    }, { cls: 'pl-suggest__add', size: 18 })
    return btn
  }

  async function load() {
    refresh.disabled = true
    try {
      const res = await get(`/playlists/${pl.id}/suggestions`, { round })
      clear(list)
      section.hidden = !res.items?.length
      if (res.items?.length) list.append(onlineTrackList(res.items, { context: { label: pl.name }, showAlbum: false, numbered: false, action: addButton }))
    } catch { section.hidden = true }
    refresh.disabled = false
  }
  load()
  return section
}

function playlistFinder(pl, onAdded) {
  const input = h('input', { class: 'input input--search', type: 'search', placeholder: t('player.playlist.findPlaceholder') })
  const results = h('div', { class: 'finder__results' })
  const run = debounce(async () => {
    const q = input.value.trim()
    clear(results)
    if (!q) return
    try {
      const res = await get('/search', { q, limit: 10 })
      for (const tr of res.tracks) {
        const add = h('button', { type: 'button', class: 'btn btn--outline btn--sm', text: t('player.common.add') })
        add.addEventListener('click', async () => {
          add.disabled = true
          try { await post(`/playlists/${pl.id}/tracks`, { trackIds: [tr.id] }); add.textContent = '✓'; await refreshPlaylists(); onAdded() } catch (error) { toastError(error); add.disabled = false }
        })
        results.append(h('div', { class: 'finder__row' },
          artwork(artworkUrl(tr.artwork, 64), { cls: 'tl-art', seed: tr.album || tr.title }),
          h('span', { class: 'tl-text' }, h('span', { class: 'tl-name', text: tr.title }), h('span', { class: 'tl-artist', text: tr.artist })),
          h('span', { class: 'muted small', text: tr.album || '' }),
          add))
      }
      if (!res.tracks.length) results.append(h('p', { class: 'muted small', text: t('player.search.noLocal', { q }) }))
    } catch (error) { toastError(error) }
  }, 250)
  input.addEventListener('input', run)
  return h('section', { class: 'finder' }, h('h2', { class: 'section-title', text: t('player.playlist.findTitle') }), h('label', { class: 'finder__box' }, icon('search', { size: 18 }), input), results)
}

async function playlistView(id) {
  const pl = await get(`/playlists/${id}`)
  const src = pl.trackCount ? artworkUrl(pl.artwork, 512) : null
  const context = { label: pl.name, route: `/playlist/${id}` }
  const root = h('div', { class: 'detail' },
    hero({
      art: artwork(src, { alt: pl.name, placeholder: 'list', seed: pl.name, lazy: false }),
      artSrc: src,
      kind: pl.isPublic ? t('player.playlist.publicKind') : t('player.kind.playlist'),
      title: pl.name,
      description: pl.description || null,
      meta: [pl.owner?.displayName, plural(pl.trackCount, 'player.count.track', 'player.count.tracks'), pl.duration ? fmtLong(pl.duration) : null]
    }))
  const listHolder = h('div')
  const reload = async () => {
    try {
      const fresh = await get(`/playlists/${id}`)
      pl.tracks = fresh.tracks
      paintList()
    } catch (error) { toastError(error) }
  }
  const paintList = () => {
    clear(listHolder)
    if (pl.tracks.length) listHolder.append(trackList(pl.tracks, { context, playlist: pl, onChanged: reload }))
    else listHolder.append(emptyState('list', t('player.playlist.emptyTitle'), pl.editable ? t('player.playlist.emptyText') : ''))
  }
  const extra = [selectButton(() => listHolder.querySelector('.tracklist'))]
  if (!pl.editable && pl.tracks.length) extra.push(saveButton(() => ({ name: pl.name, trackIds: pl.tracks.map((tr) => tr.id), count: pl.tracks.length }), { cls: 'icon-btn--lg', size: 24 }))
  if (pl.editable) {
    extra.push(iconButton('edit', t('player.playlist.edit'), async () => { const up = await editPlaylist(pl); if (up) window.dispatchEvent(new HashChangeEvent('hashchange')) }, { cls: 'icon-btn--lg', size: 24 }))
    extra.push(iconButton('more', t('player.common.more'), (e) => contextMenu([
      { label: t('player.menu.addToQueue'), icon: 'queue', run: () => queueCollection('playlist', id, 'add') },
      { label: pl.isPublic ? t('player.playlist.makePrivate') : t('player.playlist.makePublic'), icon: pl.isPublic ? 'lock' : 'users', run: async () => { try { await patch(`/playlists/${id}`, { isPublic: !pl.isPublic }); await refreshPlaylists(); window.dispatchEvent(new HashChangeEvent('hashchange')) } catch (error) { toastError(error) } } },
      'sep',
      { label: t('player.playlist.delete'), icon: 'trash', danger: true, run: async () => {
        if (!await confirmDialog({ title: t('player.playlist.delete'), message: t('player.playlist.deleteConfirm', { name: pl.name }), confirmLabel: t('player.common.delete'), danger: true })) return
        try { await del(`/playlists/${id}`); await refreshPlaylists(); toast(t('player.playlist.deleted')); app.nav('/library/playlists') } catch (error) { toastError(error) }
      } }
    ], e.currentTarget), { cls: 'icon-btn--lg', size: 26 }))
  } else {
    extra.push(iconButton('more', t('player.common.more'), (e) => contextMenu([
      { label: t('player.menu.addToQueue'), icon: 'queue', run: () => queueCollection('playlist', id, 'add') }
    ], e.currentTarget), { cls: 'icon-btn--lg', size: 26 }))
  }
  // Native append() writes a missing banner (null) as the text "null".
  const banner = followBanner(pl, reload)
  root.append(actionBar({
    onPlay: () => playTracks(pl.tracks, 0, context, { shuffle: false }),
    onShuffle: () => playTracks(pl.tracks, randomIndex(Math.max(1, pl.tracks.length)), context, { shuffle: true }),
    extra
  }), ...(banner ? [banner] : []), listHolder)
  paintList()
  if (pl.editable) root.append(playlistSuggestions(pl, reload), playlistFinder(pl, reload))
  return { node: root, hero: true }
}

// A playlist that follows an online list: where it comes from, last check,
// "sync now" and "stop following" (the playlist itself stays).
function followBanner(pl, reload) {
  const f = pl.follow
  if (!f) return null
  const when = h('span')
  const paintWhen = (row) => {
    when.textContent = row.lastSyncAt ? t('player.follow.lastSync', { when: fmtRelative(row.lastSyncAt) }) : t('player.follow.never')
  }
  paintWhen(f)
  const syncBtn = h('button', { type: 'button', class: 'btn btn--outline btn--sm', text: t('player.follow.syncNow') })
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true
    try {
      const row = await post(`/follows/playlists/${f.id}/sync`)
      paintWhen(row)
      toast(row.lastAdded ? t('player.follow.synced', { n: row.lastAdded }) : t('player.follow.upToDate'))
      await reload()
    } catch (error) { toastError(error) } finally { syncBtn.disabled = false }
  })
  const stopBtn = h('button', { type: 'button', class: 'link-btn', text: t('player.follow.stop') })
  stopBtn.addEventListener('click', async () => {
    try {
      await del(`/follows/playlists/${f.id}`)
      toast(t('player.follow.stopped'))
      banner.remove()
    } catch (error) { toastError(error) }
  })
  const banner = h('div', { class: 'online-banner follow-banner' }, icon('refresh', { size: 22 }),
    h('div', {}, h('b', { text: t('player.follow.banner', { provider: providerName(f.provider) }) }), when, h('span', { text: t('player.follow.hint') })),
    h('div', { class: 'follow-banner__actions' }, syncBtn, stopBtn))
  return banner
}

export async function render(name, params) {
  const id = Number(params[0])
  if (name === 'album') return albumView(id)
  if (name === 'artist') return artistView(id)
  return playlistView(id)
}
