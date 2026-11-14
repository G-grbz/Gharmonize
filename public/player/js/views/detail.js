// Library detail pages: album, artist, playlist.

import { app } from '../app.js'
import { get, post, patch, del, artworkUrl } from '../api.js'
import { h, t, icon, iconButton, clear, artwork, fmtLong, plural, contextMenu, modal, toast, toastError, confirmDialog, skeletonShelf, debounce, emptyState, fmtRelative } from '../dom.js'
import {
  hero, actionBar, trackList, onlineTrackList, shelf, albumCard, onlineCard, heartButton, playTracks, playCollection, queueCollection,
  playlistSubmenu, refreshPlaylists, primaryArtist, selectButton
} from '../components.js'
import { saveButton } from '../playlistSave.js'

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
        album.artistId ? h('a', { class: 'hero__artist', href: `#/artist/${album.artistId}` }, artwork(artworkUrl(`artist/${album.artistId}`, 64), { round: true, cls: 'hero__avatar', placeholder: 'user', seed: album.artist }), album.artist) : album.artist,
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
    onShuffle: () => playTracks(album.tracks, Math.floor(Math.random() * album.tracks.length), context, { shuffle: true }),
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

// ---- artist -------------------------------------------------------------------

async function artistView(id) {
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
      { label: t('player.menu.addToQueue'), icon: 'queue', run: () => queueCollection('artist', id, 'add') },
      app.providers.includes('deezer') && { label: t('player.menu.moreOnline'), icon: 'globe', run: () => app.nav(`/online/artist?name=${encodeURIComponent(artist.name)}`) }
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
  if (artist.singles.length) root.append(h('section', { class: 'section' }, h('h2', { class: 'section-title', text: t('player.artist.singles') }), trackList(artist.singles, { context, showAlbum: false })))
  if (artist.appearsOn.length) root.append(shelf({ title: t('player.artist.appearsOn'), items: artist.appearsOn, render: albumCard }))

  if (app.providers.includes('deezer')) {
    const slot = h('div', { class: 'online-artist-slot' }, skeletonShelf(5))
    root.append(slot)
    loadOnlineArtist(artist.name, slot)
  }
  return { node: root, hero: true }
}

async function loadOnlineArtist(name, slot) {
  try {
    const data = await get('/online/artist', { name })
    if (!slot.isConnected) return
    clear(slot)
    const missingAlbums = data.albums.filter((a) => !a.library)
    const missingTop = data.topTracks.filter((tr) => !tr.library)
    if (missingAlbums.length || missingTop.length) {
      slot.append(h('div', { class: 'online-banner' },
        icon('sparkles', { size: 22 }),
        h('div', {},
          h('b', { text: t('player.artist.completeTitle') }),
          h('span', { text: t('player.artist.completeText', { albums: data.missingAlbums, tracks: missingTop.length }) })),
        h('a', { class: 'btn btn--outline btn--sm', href: `#/online/artist?id=${data.artist.id}`, text: t('player.artist.openOnline') })))
    }
    if (missingTop.length) slot.append(h('section', { class: 'section' }, h('h2', { class: 'section-title', text: t('player.artist.popularMissing') }), onlineTrackList(missingTop.slice(0, 10), { context: { label: name } })))
    if (missingAlbums.length) slot.append(shelf({ title: t('player.artist.missingAlbums'), items: missingAlbums, render: (item, i) => onlineCard(item, missingAlbums, i) }))
    if (data.related.length) slot.append(shelf({ title: t('player.artist.related'), items: data.related, render: (item, i) => onlineCard(item, data.related, i) }))
  } catch {
    slot.remove()
  }
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
  root.append(actionBar({
    onPlay: () => playTracks(pl.tracks, 0, context, { shuffle: false }),
    onShuffle: () => playTracks(pl.tracks, Math.floor(Math.random() * Math.max(1, pl.tracks.length)), context, { shuffle: true }),
    extra
  }), listHolder)
  paintList()
  if (pl.editable) root.append(playlistFinder(pl, reload))
  return { node: root, hero: true }
}

export async function render(name, params) {
  const id = Number(params[0])
  if (name === 'album') return albumView(id)
  if (name === 'artist') return artistView(id)
  return playlistView(id)
}
