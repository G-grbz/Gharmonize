// Reusable UI pieces: cards, shelves, track lists, menus and play helpers.

import { app, bus } from './app.js'
import { get, put, del, post, artworkUrl } from './api.js'
import { h, append, t, icon, iconButton, artwork, fmtTime, fmtNumber, contextMenu, toast, toastError, modal, promptDialog, hueOf, clear, plural } from './dom.js'
import { fromTrack, fromOnline, adoptDownload } from './engine.js'
import { downloadButton } from './downloads.js'
import { saveButton, saveToPlaylistDialog } from './playlistSave.js'

const coarse = () => window.matchMedia?.('(pointer: coarse)').matches

// ---- play helpers ---------------------------------------------------------------

export function playTracks(tracks, index = 0, context = null, opts = {}) {
  const items = tracks.map((track) => fromTrack(track)).filter(Boolean)
  if (!items.length) return toast(t('player.playback.nothing'))
  app.player.play(items, Math.min(index, items.length - 1), { context, ...opts })
}

export function playOnline(items, index = 0, context = null) {
  const target = items[index]
  const queue = []
  let start = 0
  items.forEach((item, i) => {
    const q = fromOnline(item)
    if (!q) return
    if (i === index) start = queue.length
    queue.push(q)
  })
  if (!fromOnline(target)) {
    if (target && app.canDownload && target.kind === 'track') {
      toast(t('player.online.notPlayable', { title: target.title }), { action: { label: t('player.downloads.download'), run: () => app.downloads.request(target) } })
    } else toast(t('player.online.noPreview'))
    return
  }
  app.player.play(queue, start, { context })
}

export async function playCollection(kind, id, { shuffle = null, context = null } = {}) {
  try {
    let tracks = []
    let label = context
    if (kind === 'album') { const a = await get(`/albums/${id}`); tracks = a.tracks; label ||= { label: a.title, route: `/album/${id}` } }
    else if (kind === 'playlist') { const p = await get(`/playlists/${id}`); tracks = p.tracks; label ||= { label: p.name, route: `/playlist/${id}` } }
    else if (kind === 'artist') { const r = await get('/tracks', { artistId: id, sort: 'artist', limit: 500 }); tracks = r.items; label ||= { label: tracks[0]?.artist || '', route: `/artist/${id}` } }
    else if (kind === 'genre') { const r = await get('/tracks', { genre: id, sort: 'random', limit: 300 }); tracks = r.items; label ||= { label: id, route: `/genre/${encodeURIComponent(id)}` } }
    else if (kind === 'liked') { const r = await get('/tracks', { favorites: 1, limit: 500 }); tracks = r.items; label ||= { label: t('player.nav.liked'), route: '/liked' } }
    else if (kind === 'mix') { const m = await get(`/mixes/${encodeURIComponent(id)}`); tracks = m.tracks; label ||= { label: mixTitle(m), route: `/mix/${id}` } }
    if (!tracks.length) return toast(t('player.playback.nothing'))
    playTracks(tracks, 0, label, { shuffle })
  } catch (error) { toastError(error) }
}

export async function queueCollection(kind, id, mode = 'add') {
  try {
    let tracks = []
    if (kind === 'album') tracks = (await get(`/albums/${id}`)).tracks
    else if (kind === 'playlist') tracks = (await get(`/playlists/${id}`)).tracks
    else if (kind === 'artist') tracks = (await get('/tracks', { artistId: id, sort: 'artist', limit: 500 })).items
    const items = tracks.map((tr) => fromTrack(tr))
    if (mode === 'next') app.player.playNext(items)
    else app.player.addToQueue(items)
  } catch (error) { toastError(error) }
}

export async function toggleFavorite(type, id, value) {
  try {
    if (value) await put(`/favorites/${type}/${id}`)
    else await del(`/favorites/${type}/${id}`)
    bus.emit('favorite', { type, id: Number(id), favorite: value })
    toast(value ? t('player.favorite.added') : t('player.favorite.removed'))
    return value
  } catch (error) { toastError(error); return !value }
}

export function heartButton(type, id, initial, { size = 20, cls = '' } = {}) {
  let value = Boolean(initial)
  const btn = iconButton(value ? 'heartFill' : 'heart', value ? t('player.favorite.remove') : t('player.favorite.add'), async () => {
    value = await toggleFavorite(type, id, !value)
    paint()
  }, { cls: `heart ${cls}`, size })
  const paint = () => {
    btn.classList.toggle('is-on', value)
    btn.title = value ? t('player.favorite.remove') : t('player.favorite.add')
    btn.setAttribute('aria-label', btn.title)
    const old = btn.querySelector('svg')
    old.replaceWith(icon(value ? 'heartFill' : 'heart', { size }))
  }
  btn.classList.toggle('is-on', value)
  const off = bus.on('favorite', (e) => {
    if (!btn.isConnected) return off()
    if (e.type === type && e.id === Number(id) && e.favorite !== value) { value = e.favorite; paint() }
  })
  return btn
}

// ---- playlists --------------------------------------------------------------------

export async function refreshPlaylists() {
  try {
    app.playlists = (await get('/playlists')).items || []
    bus.emit('playlists', app.playlists)
  } catch {}
  return app.playlists
}

export async function createPlaylistFlow(trackIds = []) {
  const name = await promptDialog({ title: t('player.playlist.create'), label: t('player.playlist.name'), placeholder: t('player.playlist.namePlaceholder'), confirmLabel: t('player.common.create') })
  if (!name) return null
  try {
    const pl = await post('/playlists', { name, trackIds })
    await refreshPlaylists()
    toast(t('player.playlist.created', { name: pl.name }), { type: 'success' })
    return pl
  } catch (error) { toastError(error); return null }
}

async function addToPlaylist(playlist, trackIds) {
  try {
    await post(`/playlists/${playlist.id}/tracks`, { trackIds })
    await refreshPlaylists()
    toast(t('player.playlist.addedTo', { name: playlist.name }), { type: 'success' })
  } catch (error) { toastError(error) }
}

export function playlistSubmenu(getTrackIds, { onlineItem = null } = {}) {
  return async () => {
    const editable = (app.playlists || []).filter((p) => p.editable)
    const items = [{ label: t('player.playlist.new'), icon: 'plus', run: async () => {
      if (onlineItem) {
        const pl = await createPlaylistFlow([])
        if (pl) app.downloads.request(onlineItem, { playlistId: pl.id })
        return
      }
      createPlaylistFlow(await getTrackIds())
    } }]
    if (editable.length) items.push('sep')
    for (const pl of editable.slice(0, 40)) {
      items.push({ label: pl.name, icon: 'list', run: async () => {
        if (onlineItem) return app.downloads.request(onlineItem, { playlistId: pl.id })
        addToPlaylist(pl, await getTrackIds())
      } })
    }
    return items
  }
}

// ---- menus --------------------------------------------------------------------------

export function trackMenu(track, at, { playlist = null, entryId = null, onRemoved = null } = {}) {
  const item = () => fromTrack(track)
  contextMenu([
    { label: t('player.menu.playNext'), icon: 'playNext', run: () => app.player.playNext([item()]) },
    { label: t('player.menu.addToQueue'), icon: 'queue', run: () => app.player.addToQueue([item()]) },
    { label: t('player.menu.addToPlaylist'), icon: 'playlistAdd', submenu: playlistSubmenu(async () => [track.id]) },
    'sep',
    track.albumId && { label: t('player.menu.goToAlbum'), icon: 'album', run: () => app.nav(`/album/${track.albumId}`) },
    track.artistId && { label: t('player.menu.goToArtist'), icon: 'user', run: () => app.nav(`/artist/${track.artistId}`) },
    { label: track.favorite ? t('player.favorite.remove') : t('player.favorite.add'), icon: track.favorite ? 'heartFill' : 'heart', run: async () => { track.favorite = await toggleFavorite('track', track.id, !track.favorite) } },
    track.artist && app.providers.includes('deezer') && { label: t('player.menu.moreOnline'), icon: 'globe', run: () => app.nav(`/online/artist?name=${encodeURIComponent(primaryArtist(track.artist))}`) },
    playlist?.editable && entryId && 'sep',
    playlist?.editable && entryId && { label: t('player.playlist.removeTrack'), icon: 'trash', danger: true, run: async () => {
      try { await del(`/playlists/${playlist.id}/tracks/${entryId}`); await refreshPlaylists(); onRemoved?.() } catch (error) { toastError(error) }
    } },
    'sep',
    { label: t('player.menu.info'), icon: 'info', run: () => trackInfo(track) }
  ], at)
}

export function onlineMenu(item, at) {
  const owned = adoptDownload(item)
  contextMenu([
    owned && { label: t('player.menu.playFromLibrary'), icon: 'play', run: () => playOnline([item], 0) },
    !owned && item.previewUrl && { label: t('player.menu.preview'), icon: 'play', run: () => playOnline([item], 0) },
    owned && { label: t('player.menu.playNext'), icon: 'playNext', run: () => app.player.playNext([fromOnline(item)]) },
    owned && { label: t('player.menu.addToQueue'), icon: 'queue', run: () => app.player.addToQueue([fromOnline(item)]) },
    !owned && app.canDownload && ['track', 'album', 'playlist'].includes(item.kind) && { label: t('player.downloads.download'), icon: 'download', run: () => app.downloads.request(item) },
    item.kind === 'track' && (owned || app.canDownload) && { label: owned ? t('player.menu.addToPlaylist') : t('player.menu.downloadToPlaylist'), icon: 'playlistAdd', submenu: owned ? playlistSubmenu(async () => [owned]) : playlistSubmenu(null, { onlineItem: item }) },
    'sep',
    item.providerIds?.deezerAlbum && { label: t('player.menu.goToAlbum'), icon: 'album', run: () => app.nav(`/online/album?provider=deezer&id=${item.providerIds.deezerAlbum}`) },
    item.library?.albumId && { label: t('player.menu.openInLibrary'), icon: 'library', run: () => app.nav(`/album/${item.library.albumId}`) },
    (item.providerIds?.deezerArtist || item.artist) && item.kind !== 'artist' && app.providers.includes('deezer') && { label: t('player.menu.goToArtist'), icon: 'user', run: () => app.nav(item.providerIds?.deezerArtist ? `/online/artist?id=${item.providerIds.deezerArtist}` : `/online/artist?name=${encodeURIComponent(primaryArtist(item.artist))}`) },
    item.url && item.provider !== 'library' && { label: t('player.menu.openSource', { provider: providerName(item.provider) }), icon: 'external', run: () => window.open(item.url, '_blank', 'noopener,noreferrer') }
  ], at)
}

export function trackInfo(track) {
  const rows = [
    [t('player.info.title'), track.title],
    [t('player.info.artist'), track.artist],
    [t('player.info.album'), track.album],
    [t('player.info.year'), track.year],
    [t('player.info.genre'), track.genre],
    [t('player.info.duration'), track.duration ? fmtTime(track.duration) : null],
    [t('player.info.format'), [track.codec, track.container].filter(Boolean).join(' · ')],
    [t('player.info.bitrate'), track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : null],
    [t('player.info.sampleRate'), track.sampleRate ? `${(track.sampleRate / 1000).toFixed(1)} kHz${track.bitDepth ? ` · ${track.bitDepth}-bit` : ''}` : null],
    [t('player.info.quality'), track.lossless ? t('player.badge.lossless') : t('player.badge.lossy')],
    [t('player.info.plays'), track.playCount != null ? fmtNumber(track.playCount) : null]
  ].filter(([, v]) => v !== null && v !== undefined && v !== '')
  modal({
    title: t('player.menu.info'),
    build: () => h('dl', { class: 'info-grid' }, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })]))
  })
}

export function providerName(provider) {
  return { deezer: 'Deezer', youtube: 'YouTube Music', spotify: 'Spotify' }[provider] || provider || ''
}

export function primaryArtist(name) {
  return String(name || '').split(/\s*(?:,|;|&|\/| feat\.? | ft\.? | x )\s*/i)[0].trim() || String(name || '')
}

// ---- cards ----------------------------------------------------------------------------

function card({ art, title, subtitle, onOpen, onPlay, onMenu, badge = null, cls = '', href = null, dataset = null }) {
  const el = h(href ? 'a' : 'div', { class: `card ${cls}`.trim(), tabindex: href ? null : '0', role: href ? null : 'button', href, dataset })
  const artWrap = h('div', { class: 'card__art' }, art)
  if (onPlay) {
    const play = h('button', { type: 'button', class: 'play-fab card__play', title: t('player.common.play'), 'aria-label': t('player.common.play') }, icon('play', { size: 22 }))
    play.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onPlay() })
    artWrap.append(play)
  }
  if (badge) artWrap.append(badge)
  append(el, [artWrap, h('div', { class: 'card__title', text: title, title }), subtitle ? h('div', { class: 'card__sub', text: subtitle, title: subtitle }) : null])
  if (onOpen && !href) {
    el.addEventListener('click', onOpen)
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') onOpen(e) })
  }
  if (onMenu) el.addEventListener('contextmenu', (e) => { e.preventDefault(); onMenu(e) })
  return el
}

export function albumCard(album) {
  return card({
    art: artwork(artworkUrl(album.artwork, 256), { alt: album.title, placeholder: 'album', seed: album.title }),
    title: album.title,
    subtitle: [album.year, album.artist].filter(Boolean).join(' · '),
    href: `#/album/${album.id}`,
    onPlay: () => playCollection('album', album.id),
    badge: h('div', { class: 'card__badges card__badges--end' }, saveButton(() => ({ name: album.title, getTrackIds: async () => (await get(`/albums/${album.id}`)).tracks.map((x) => x.id), count: album.trackCount }))),
    onMenu: (e) => contextMenu([
      { label: t('player.common.play'), icon: 'play', run: () => playCollection('album', album.id) },
      { label: t('player.menu.playNext'), icon: 'playNext', run: () => queueCollection('album', album.id, 'next') },
      { label: t('player.menu.addToQueue'), icon: 'queue', run: () => queueCollection('album', album.id, 'add') },
      { label: t('player.menu.addToPlaylist'), icon: 'playlistAdd', submenu: playlistSubmenu(async () => (await get(`/albums/${album.id}`)).tracks.map((x) => x.id)) },
      album.artistId && { label: t('player.menu.goToArtist'), icon: 'user', run: () => app.nav(`/artist/${album.artistId}`) }
    ], e)
  })
}

export function artistCard(artist) {
  return card({
    art: artwork(artworkUrl(artist.artwork, 256), { alt: artist.name, round: true, placeholder: 'user', seed: artist.name }),
    title: artist.name,
    subtitle: artist.plays ? plural(artist.plays, 'player.count.play', 'player.count.plays') : t('player.kind.artist'),
    href: `#/artist/${artist.id}`,
    cls: 'card--artist',
    onPlay: () => playCollection('artist', artist.id)
  })
}

export function playlistCard(pl) {
  return card({
    art: artwork(pl.trackCount ? artworkUrl(pl.artwork, 256) : null, { alt: pl.name, placeholder: 'list', seed: pl.name }),
    title: pl.name,
    subtitle: pl.editable ? plural(pl.trackCount, 'player.count.track', 'player.count.tracks') : t('player.playlist.by', { name: pl.owner?.displayName || '' }),
    href: `#/playlist/${pl.id}`,
    onPlay: pl.trackCount ? () => playCollection('playlist', pl.id) : null
  })
}

export function trackCard(track, list, index, context) {
  return card({
    art: artwork(artworkUrl(track.artwork, 256), { alt: track.title, seed: track.album || track.title }),
    title: track.title,
    subtitle: track.artist,
    cls: 'card--track',
    dataset: { trackId: String(track.id) },
    onOpen: () => playTracks(list, index, context),
    onPlay: () => playTracks(list, index, context),
    onMenu: (e) => trackMenu(track, e)
  })
}

// ---- mixes ---------------------------------------------------------------------------

// Turkish plural suffix follows the spoken decade: 1990'lar, 1980'ler, 2000'ler.
export function decadeLabel(decade) {
  if ((document.documentElement.lang || '').toLowerCase().startsWith('tr')) {
    const back = new Set([10, 30, 40, 60, 90])
    return `${decade}'${back.has(Number(decade) % 100) ? 'lar' : 'ler'}`
  }
  return String(decade)
}

export function mixTitle(mix) {
  const vars = mix.titleVars || {}
  if (mix.kind === 'decade') return t('player.mix.decade', { decade: decadeLabel(vars.decade) })
  return t(`player.mix.${mix.kind}`, vars)
}

export function mixDescription(mix) {
  if (mix.kind === 'daily' && mix.artists?.length) return t('player.mix.dailyDesc', { artists: mix.artists.slice(0, 3).join(', ') })
  if (mix.kind === 'decade') return t('player.mix.decadeDesc', { decade: decadeLabel(mix.titleVars?.decade) })
  return t(`player.mix.${mix.kind}Desc`, mix.titleVars || {})
}

const MIX_HUES = { daily: [96, 28, 160, 200, 330], discover: [265], liked: [345], decade: [38] }
function mixHue(mix) {
  const list = MIX_HUES[mix.kind] || [hueOf(mix.id)]
  return list[((mix.titleVars?.n || 1) - 1) % list.length]
}

/** 2×2 cover mosaic with the mix name on a colored band. */
export function mixArt(mix, { size = 256, label = true } = {}) {
  const covers = (mix.covers || []).slice(0, 4)
  const box = h('div', { class: ['mix-art', covers.length < 4 && 'mix-art--single'] })
  box.style.setProperty('--mix-hue', mixHue(mix))
  const shown = covers.length >= 4 ? covers : covers.slice(0, 1)
  for (const ref of shown) box.append(artwork(artworkUrl(ref, covers.length >= 4 ? Math.round(size / 2) : size), { seed: ref }))
  if (!shown.length) box.append(h('div', { class: 'mix-art__empty' }, icon('sparkles', { size: 34 })))
  if (label) box.append(h('span', { class: 'mix-art__label', text: mixTitle(mix) }))
  return box
}

export function mixCard(mix) {
  return card({
    art: mixArt(mix),
    title: mixTitle(mix),
    subtitle: mixDescription(mix),
    href: `#/mix/${encodeURIComponent(mix.id)}`,
    cls: 'card--mix',
    onPlay: () => playCollection('mix', mix.id),
    badge: h('div', { class: 'card__badges card__badges--end' }, saveButton(() => ({ name: mixTitle(mix), getTrackIds: async () => (await get(`/mixes/${encodeURIComponent(mix.id)}`)).tracks.map((x) => x.id), count: mix.trackCount })))
  })
}

export function genreTile(genre) {
  const name = genre.name || genre
  const el = h('a', { class: 'tile', href: `#/genre/${encodeURIComponent(name)}` },
    h('span', { class: 'tile__title', text: name }),
    genre.trackCount ? h('span', { class: 'tile__sub', text: plural(genre.trackCount, 'player.count.track', 'player.count.tracks') }) : null)
  el.style.setProperty('--tile-hue', hueOf(name))
  return el
}

export function moodTile(preset) {
  const el = h('a', { class: 'tile tile--mood', href: `#/mood/${encodeURIComponent(preset)}` },
    h('span', { class: 'tile__title', text: t(`player.mood.${preset}`) }))
  el.style.setProperty('--tile-hue', hueOf(`mood-${preset}`))
  return el
}

// Online item card (track / album / playlist / artist) with library badge.
export function onlineCard(item, list = [item], index = 0, context = null) {
  const owned = item.library
  const isArtist = item.kind === 'artist'
  let open
  if (item.kind === 'album') open = () => app.nav(onlineAlbumRoute(item))
  else if (item.kind === 'playlist') open = () => app.nav(onlinePlaylistRoute(item))
  else if (isArtist) open = () => app.nav(owned?.artistId ? `/artist/${owned.artistId}` : `/online/artist?${item.provider === 'deezer' ? `id=${item.id}` : `name=${encodeURIComponent(item.title)}`}`)
  else open = () => playOnline(list, index, context)
  const playable = item.kind === 'track' && (owned?.trackId || item.previewUrl)
  const badges = h('div', { class: 'card__badges' })
  if (owned && (item.kind !== 'album' || owned.complete)) badges.append(h('span', { class: 'badge badge--owned', title: t('player.downloads.inLibrary') }, icon('check', { size: 14 })))
  else if (owned && item.kind === 'album') badges.append(h('span', { class: 'badge badge--partial', title: t('player.online.partialAlbum') }, icon('check', { size: 14 })))
  if (!owned && item.kind === 'track' && item.previewUrl) badges.append(h('span', { class: 'badge badge--preview', text: t('player.badge.preview') }))
  if (['album', 'playlist'].includes(item.kind) && (owned || app.canDownload)) {
    badges.append(saveButton(() => ({ name: item.title, onlineItem: item, count: item.trackCount ?? null })))
  }
  if (!owned && app.canDownload && ['track', 'album', 'playlist'].includes(item.kind)) badges.append(downloadButton(item))
  const el = card({
    art: artwork(item.artworkUrl, { alt: item.title, round: isArtist, placeholder: isArtist ? 'user' : item.kind === 'album' ? 'album' : 'music', seed: item.title }),
    title: item.title,
    subtitle: onlineSubtitle(item),
    cls: `card--online card--${item.kind}${isArtist ? ' card--artist' : ''}`,
    onOpen: open,
    onPlay: playable ? () => playOnline(list, index, context) : null,
    onMenu: (e) => onlineMenu(item, e),
    badge: badges,
    dataset: owned?.trackId ? { trackId: String(owned.trackId) } : null
  })
  el.append(h('span', { class: `provider-dot provider-dot--${item.provider}`, title: providerName(item.provider) }))
  return el
}

function onlineSubtitle(item) {
  if (item.kind === 'artist') return item.fans ? t('player.online.fans', { n: fmtNumber(item.fans) }) : t('player.kind.artist')
  if (item.kind === 'album') return [item.year, item.artist].filter(Boolean).join(' · ') || t('player.kind.album')
  if (item.kind === 'playlist') return item.artist || t('player.kind.playlist')
  return item.artist || ''
}

export function onlineAlbumRoute(item) {
  if (item.provider === 'youtube') return `/online/album?provider=youtube&url=${encodeURIComponent(item.url)}&artist=${encodeURIComponent(item.artist || '')}`
  return `/online/album?provider=${item.provider}&id=${encodeURIComponent(item.id)}`
}

export function onlinePlaylistRoute(item) {
  if (item.provider === 'youtube') return `/online/playlist?provider=youtube&url=${encodeURIComponent(item.url)}`
  return `/online/playlist?provider=${item.provider}&id=${encodeURIComponent(item.id)}`
}

// ---- shelves --------------------------------------------------------------------------

// Shelf arrows are measured for all shelves in one frame: all reads first,
// then all writes, so a page of shelves costs one layout instead of one each.
const navQueue = new Set()
function queueNav(measure) {
  if (!navQueue.size) {
    requestAnimationFrame(() => {
      const jobs = [...navQueue]
      navQueue.clear()
      for (const write of jobs.map((job) => job())) write?.()
    })
  }
  navQueue.add(measure)
}

// Opening the queue panel or resizing the window changes how much of a row
// fits, so the arrows are measured again whenever a row changes size.
const navResize = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => {
    for (const { target } of entries) {
      if (target.isConnected) target.__updateNav?.()
      else navResize.unobserve(target)
    }
  })
  : null

export function shelf({ title, subtitle = null, items, render, seeAll = null, id = null, cls = '', tools = [] }) {
  if (!items?.length) return null
  const row = h('div', { class: 'shelf__row' })
  items.forEach((item, i) => { const el = render(item, i); if (el) row.append(el) })
  const section = h('section', { class: `shelf ${cls}`.trim(), dataset: id ? { shelf: id } : null })
  const scrollBy = (dir) => row.scrollBy({ left: dir * row.clientWidth * 0.85, behavior: 'smooth' })
  const prevBtn = iconButton('chevL', t('player.common.previous'), () => scrollBy(-1), { cls: 'shelf__nav' })
  const nextBtn = iconButton('chevR', t('player.common.next'), () => scrollBy(1), { cls: 'shelf__nav' })
  // Hidden rows (e.g. filtered out) have no size; their arrows stay as they are.
  const measureNav = () => {
    if (!row.isConnected || !row.clientWidth) return null
    const prev = row.scrollLeft < 8
    const next = row.scrollLeft + row.clientWidth >= row.scrollWidth - 8
    return () => { prevBtn.disabled = prev; nextBtn.disabled = next }
  }
  const updateNav = () => queueNav(measureNav)
  row.addEventListener('scroll', updateNav, { passive: true })
  row.__updateNav = updateNav
  navResize?.observe(row)
  updateNav()
  // Off-screen shelves are not rendered (content-visibility); measure the
  // arrows again once the shelf comes into view.
  section.addEventListener('contentvisibilityautostatechange', (e) => { if (!e.skipped) updateNav() })
  const expandBtn = h('button', { type: 'button', class: 'link-btn', text: t('player.common.showAll') })
  expandBtn.addEventListener('click', () => {
    if (typeof seeAll === 'function') return seeAll()
    const expanded = section.classList.toggle('is-expanded')
    expandBtn.textContent = expanded ? t('player.common.showLess') : t('player.common.showAll')
    updateNav()
  })
  section.append(
    h('div', { class: 'shelf__head' },
      h('div', { class: 'shelf__titles' },
        h('h2', { class: 'shelf__title', text: title }),
        subtitle && h('p', { class: 'shelf__subtitle', text: subtitle })),
      h('div', { class: 'shelf__tools' }, ...tools, items.length > 4 || seeAll ? expandBtn : null, prevBtn, nextBtn)),
    row
  )
  return section
}

// ---- track lists ---------------------------------------------------------------------

// Library track table. Options: showAlbum, showArt, numbered (album order),
// playlist + onReorder for editable playlists.
export function trackList(tracks, { context = null, showAlbum = true, showArt = true, numbered = false, playlist = null, onChanged = null, showPlays = false } = {}) {
  const list = h('div', { class: ['tracklist', !showAlbum && 'tracklist--noalbum'], role: 'list' })
  list.append(h('div', { class: 'tracklist__head', 'aria-hidden': 'true' },
    h('span', { class: 'tl-num', text: '#' }),
    h('span', { class: 'tl-title', text: t('player.info.title') }),
    showAlbum ? h('span', { class: 'tl-album', text: t('player.info.album') }) : h('span', { class: 'tl-album' }),
    h('span', { class: 'tl-dur' }, icon('clock', { size: 16 })),
    h('span', { class: 'tl-actions' })
  ))
  const editable = Boolean(playlist?.editable)
  let dragFrom = null
  const sel = selectionController(list, tracks, { context, playlist, onChanged })
  tracks.forEach((track, index) => {
    const num = numbered && track.trackNo ? track.trackNo : index + 1
    const row = h('div', { class: 'tl-row', role: 'listitem', tabindex: '0', dataset: { trackId: String(track.id), index: String(index) } })
    const play = () => playTracks(tracks, index, context)
    const numCell = h('span', { class: 'tl-num' },
      h('span', { class: 'tl-check', role: 'checkbox', 'aria-checked': 'false', 'aria-label': t('player.select.one') }, icon('check', { size: 14 })),
      h('span', { class: 'tl-num__n', text: String(num) }),
      h('span', { class: 'tl-eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      iconButton('play', t('player.common.play'), play, { cls: 'tl-num__play', size: 16 }))
    const titleCell = h('span', { class: 'tl-title' },
      showArt ? artwork(artworkUrl(track.artwork, 64), { alt: '', cls: 'tl-art', seed: track.album || track.title }) : null,
      h('span', { class: 'tl-text' },
        h('span', { class: 'tl-name', text: track.title, title: track.title }),
        h('span', { class: 'tl-artist' },
          track.lossless ? h('span', { class: 'chip-mini', text: 'HQ', title: t('player.badge.lossless') }) : null,
          track.artistId ? h('a', { href: `#/artist/${track.artistId}`, text: track.artist, onclick: (e) => e.stopPropagation() }) : h('span', { text: track.artist || '' }))))
    const albumCell = showAlbum
      ? h('span', { class: 'tl-album' }, track.albumId ? h('a', { href: `#/album/${track.albumId}`, text: track.album || '', onclick: (e) => e.stopPropagation() }) : h('span', { text: track.album || '' }))
      : h('span', { class: 'tl-album' }, showPlays && track.playCount ? h('span', { class: 'muted', text: plural(track.playCount, 'player.count.play', 'player.count.plays') }) : null)
    const more = iconButton('more', t('player.common.more'), (e) => trackMenu(track, e.currentTarget, { playlist, entryId: track.entryId, onRemoved: () => onChanged?.() }), { cls: 'tl-more', size: 18 })
    row.append(numCell, titleCell, albumCell,
      h('span', { class: 'tl-dur', text: track.duration ? fmtTime(track.duration) : '' }),
      h('span', { class: 'tl-actions' }, heartButton('track', track.id, track.favorite, { size: 18, cls: 'tl-heart' }), more))
    row.addEventListener('dblclick', () => { if (!sel.active) play() })
    row.addEventListener('click', (e) => {
      if (sel.handleClick(e, index)) return
      if (coarse() && !e.target.closest('button, a')) play()
    })
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (sel.active) sel.toggle(index); else play() } })
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); if (sel.active) return; trackMenu(track, e, { playlist, entryId: track.entryId, onRemoved: () => onChanged?.() }) })
    sel.bindLongPress(row, index)
    if (editable && track.entryId) {
      row.draggable = true
      row.classList.add('is-draggable')
      row.addEventListener('dragstart', (e) => { dragFrom = index; row.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(index)) })
      row.addEventListener('dragend', () => { row.classList.remove('is-dragging'); list.querySelectorAll('.is-drop').forEach((x) => x.classList.remove('is-drop')) })
      row.addEventListener('dragover', (e) => { if (dragFrom === null) return; e.preventDefault(); row.classList.add('is-drop') })
      row.addEventListener('dragleave', () => row.classList.remove('is-drop'))
      row.addEventListener('drop', async (e) => {
        e.preventDefault()
        const from = dragFrom
        dragFrom = null
        if (from === null || from === index) return
        try {
          await post(`/playlists/${playlist.id}/move`, { entryId: tracks[from].entryId, toIndex: index })
          onChanged?.()
        } catch (error) { toastError(error) }
      })
    }
    list.append(row)
  })
  markCurrent(list)
  return list
}

// ---- multi-selection -----------------------------------------------------------------

/** "Select" button for action bars; works with the trackList inside `scope`. */
export function selectButton(getList) {
  return iconButton('select', t('player.select.start'), () => getList()?.selection?.toggle(), { cls: 'icon-btn--lg', size: 24 })
}

function selectionController(list, tracks, { context, playlist, onChanged }) {
  const picked = new Set()
  let active = false
  let anchor = null
  let bar = null
  let offRoute = null
  const rows = () => list.querySelectorAll('.tl-row')
  const chosen = () => [...picked].sort((a, b) => a - b).map((i) => tracks[i]).filter(Boolean)

  function paint() {
    rows().forEach((row) => {
      const on = picked.has(Number(row.dataset.index))
      row.classList.toggle('is-selected', on)
      row.querySelector('.tl-check')?.setAttribute('aria-checked', String(on))
    })
    renderBar()
  }

  function start() {
    if (active) return
    active = true
    list.classList.add('is-selecting')
    offRoute = bus.on('route', stop)
    document.addEventListener('keydown', onKey)
    paint()
  }

  function stop() {
    if (!active) return
    active = false
    picked.clear()
    anchor = null
    list.classList.remove('is-selecting')
    offRoute?.()
    document.removeEventListener('keydown', onKey)
    bar?.remove()
    bar = null
    paint()
  }

  function onKey(e) {
    if (e.key === 'Escape') stop()
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !e.target.closest('input, textarea')) { e.preventDefault(); tracks.forEach((_, i) => picked.add(i)); paint() }
  }

  function toggle(index, range = false) {
    if (range && anchor !== null) {
      const [a, b] = anchor < index ? [anchor, index] : [index, anchor]
      for (let i = a; i <= b; i++) picked.add(i)
    } else if (picked.has(index)) picked.delete(index)
    else picked.add(index)
    anchor = index
    paint()
  }

  // Returns true when the click was used for selecting.
  function handleClick(e, index) {
    if (e.target.closest('a, button:not(.tl-num__play)') && !e.target.closest('.tl-check')) return false
    if (!active && (e.ctrlKey || e.metaKey || e.shiftKey) && !coarse()) { start(); toggle(index); return true }
    if (!active) return false
    e.preventDefault()
    toggle(index, e.shiftKey)
    return true
  }

  function bindLongPress(row, index) {
    let timer = null
    row.addEventListener('touchstart', () => { timer = setTimeout(() => { timer = null; start(); toggle(index); navigator.vibrate?.(20) }, 480) }, { passive: true })
    const cancel = () => { if (timer) clearTimeout(timer); timer = null }
    row.addEventListener('touchend', cancel)
    row.addEventListener('touchmove', cancel, { passive: true })
  }

  function renderBar() {
    if (!active) return
    if (!bar) {
      bar = h('div', { class: 'select-bar', role: 'toolbar', 'aria-label': t('player.select.toolbar') })
      document.body.append(bar)
    }
    const n = picked.size
    const items = chosen()
    const ids = items.map((tr) => tr.id)
    const act = (iconName, label, run, { danger = false } = {}) => {
      const b = h('button', { type: 'button', class: ['select-bar__btn', danger && 'is-danger'], disabled: !n, title: label }, icon(iconName, { size: 18 }), h('span', { text: label }))
      b.addEventListener('click', run)
      return b
    }
    bar.replaceChildren(
      iconButton('close', t('player.common.close'), stop, { cls: 'select-bar__close', size: 18 }),
      h('b', { class: 'select-bar__count', text: n ? t('player.select.count', { n }) : t('player.select.hint') }),
      h('button', { type: 'button', class: 'link-btn select-bar__all', text: n === tracks.length ? t('player.select.none') : t('player.select.all'), onclick: () => {
        if (picked.size === tracks.length) picked.clear(); else tracks.forEach((_, i) => picked.add(i))
        paint()
      } }),
      h('span', { class: 'select-bar__spacer' }),
      act('play', t('player.common.play'), () => { playTracks(items, 0, context); stop() }),
      act('queue', t('player.menu.addToQueue'), () => { app.player.addToQueue(items.map((tr) => fromTrack(tr))); toast(t('player.select.queued', { n })); stop() }),
      act('playlistAdd', t('player.save.short'), async () => {
        const base = context?.label ? t('player.select.suggestName', { name: context.label }) : ''
        if (await saveToPlaylistDialog({ name: base, trackIds: ids, count: n })) stop()
      }),
      act('heart', t('player.favorite.add'), async () => {
        try {
          await Promise.all(ids.map((id) => put(`/favorites/track/${id}`)))
          ids.forEach((id) => bus.emit('favorite', { type: 'track', id, favorite: true }))
          toast(t('player.select.liked', { n }), { type: 'success' })
          stop()
        } catch (error) { toastError(error) }
      }),
      playlist?.editable ? act('trash', t('player.select.remove'), async () => {
        try {
          for (const tr of items) if (tr.entryId) await del(`/playlists/${playlist.id}/tracks/${tr.entryId}`)
          await refreshPlaylists()
          toast(t('player.select.removed', { n }))
          stop()
          onChanged?.()
        } catch (error) { toastError(error) }
      }, { danger: true }) : '')
  }

  const api = { get active() { return active }, start, stop, toggle: (i) => (i === undefined ? (active ? stop() : start()) : toggle(i)), handleClick, bindLongPress }
  list.selection = { start, stop, toggle: () => (active ? stop() : start()) }
  return api
}

// Online track table with library / preview / download state per row.
// `action(item)` adds an own control per row (e.g. "add to playlist").
export function onlineTrackList(items, { context = null, showAlbum = true, numbered = true, action = null } = {}) {
  const list = h('div', { class: ['tracklist', 'tracklist--online', !showAlbum && 'tracklist--noalbum'], role: 'list' })
  items.forEach((item, index) => {
    const owned = adoptDownload(item)
    const row = h('div', { class: ['tl-row', !owned && 'is-missing'], role: 'listitem', tabindex: '0', dataset: owned ? { trackId: String(owned) } : null })
    const play = () => playOnline(items, index, context)
    // A download can finish while the list is open: decide on each tap.
    const canPlay = owned || item.previewUrl || (app.canDownload && item.kind === 'track')
    const status = owned
      ? h('span', { class: 'badge badge--owned', title: t('player.downloads.inLibrary') }, icon('check', { size: 14 }))
      : action ? null
        : app.canDownload ? downloadButton(item, { onDone: () => play() }) : item.previewUrl ? h('span', { class: 'badge badge--preview', text: t('player.badge.preview') }) : null
    row.append(
      h('span', { class: 'tl-num' },
        h('span', { class: 'tl-num__n', text: String(numbered ? index + 1 : '') }),
        h('span', { class: 'tl-eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        canPlay ? iconButton('play', owned ? t('player.common.play') : t('player.menu.preview'), play, { cls: 'tl-num__play', size: 16 }) : null),
      h('span', { class: 'tl-title' },
        artwork(item.artworkUrl || (item.artwork ? artworkUrl(item.artwork, 128) : null), { alt: '', cls: 'tl-art', seed: item.album || item.title }),
        h('span', { class: 'tl-text' },
          h('span', { class: 'tl-name', text: item.title, title: item.title }),
          h('span', { class: 'tl-artist' }, item.explicit ? h('span', { class: 'chip-mini', text: 'E' }) : null, h('span', { text: item.artist || '' })))),
      h('span', { class: 'tl-album' }, showAlbum ? h('span', { text: item.album || '' }) : null),
      h('span', { class: 'tl-dur', text: item.duration ? fmtTime(item.duration) : '' }),
      h('span', { class: 'tl-actions' }, action ? action(item, row) : null, status, iconButton('more', t('player.common.more'), (e) => onlineMenu(item, e.currentTarget), { cls: 'tl-more', size: 18 }))
    )
    if (canPlay) {
      row.addEventListener('dblclick', play)
      row.addEventListener('click', (e) => { if (coarse() && !e.target.closest('button, a')) play() })
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') play() })
    }
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); onlineMenu(item, e) })
    list.append(row)
  })
  markCurrent(list)
  return list
}

// Highlights rows/cards of the track that is playing right now.
export function markCurrent(root = document) {
  const current = app.player?.current
  root.querySelectorAll('[data-track-id].is-current').forEach((el) => el.classList.remove('is-current'))
  if (current?.type === 'library') root.querySelectorAll(`[data-track-id="${current.id}"]`).forEach((el) => el.classList.add('is-current'))
}

// Action bar under detail heroes.
export function actionBar({ onPlay, onShuffle = null, extra = [] }) {
  const play = h('button', { type: 'button', class: 'play-fab play-fab--lg', title: t('player.common.play'), 'aria-label': t('player.common.play') }, icon('play', { size: 28 }))
  play.addEventListener('click', onPlay)
  return h('div', { class: 'action-bar' },
    play,
    onShuffle ? iconButton('shuffle', t('player.controls.shuffle'), onShuffle, { cls: 'icon-btn--lg', size: 26 }) : null,
    ...extra)
}

// Hero header for detail pages; tints the page with the artwork's color.
export function hero({ art, kind, title, meta = [], description = null, round = false, artSrc = null }) {
  const header = h('header', { class: ['hero', round && 'hero--round'] },
    h('div', { class: 'hero__art' }, art),
    h('div', { class: 'hero__text' },
      h('span', { class: 'hero__kind', text: kind }),
      h('h1', { class: ['hero__title', title.length > 28 && 'hero__title--long', title.length > 60 && 'hero__title--xl'], text: title }),
      description ? h('p', { class: 'hero__desc', text: description }) : null,
      h('div', { class: 'hero__meta' }, meta.filter(Boolean).map((m, i) => [i ? h('span', { class: 'dot', text: '•' }) : null, m]))))
  if (artSrc) tintFrom(artSrc)
  else setTint(null, title)
  return header
}

export function setTint(rgb, seed = '') {
  const view = document.getElementById('main')
  if (!view) return
  if (rgb) view.style.setProperty('--tint', `${rgb[0]} ${rgb[1]} ${rgb[2]}`)
  else {
    const hue = hueOf(seed)
    view.style.setProperty('--tint', hslToRgb(hue, 0.35, 0.35).join(' '))
  }
}

// Average color of same-origin artwork (cross-origin images cannot be read).
/** Average colour of same-origin artwork as [r, g, b] (null when unknown). */
export function averageColor(src) {
  return new Promise((resolve) => {
    if (!src || /^https?:\/\//.test(src)) return resolve(null)
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 16
        canvas.height = 16
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0, 16, 16)
        const data = ctx.getImageData(0, 0, 16, 16).data
        let r = 0; let g = 0; let b = 0; let n = 0
        for (let i = 0; i < data.length; i += 4) {
          const max = Math.max(data[i], data[i + 1], data[i + 2])
          const min = Math.min(data[i], data[i + 1], data[i + 2])
          const weight = 1 + (max - min) / 64
          r += data[i] * weight; g += data[i + 1] * weight; b += data[i + 2] * weight; n += weight
        }
        resolve([Math.round(r / n), Math.round(g / n), Math.round(b / n)])
      } catch { resolve(null) }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

export function tintFrom(src) {
  if (!src || /^https?:\/\//.test(src)) { setTint(null, src || ''); return }
  const img = new Image()
  img.decoding = 'async'
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 16
      canvas.height = 16
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(img, 0, 0, 16, 16)
      const data = ctx.getImageData(0, 0, 16, 16).data
      let r = 0; let g = 0; let b = 0; let n = 0
      for (let i = 0; i < data.length; i += 4) {
        const max = Math.max(data[i], data[i + 1], data[i + 2])
        const min = Math.min(data[i], data[i + 1], data[i + 2])
        const weight = 1 + (max - min) / 64
        r += data[i] * weight; g += data[i + 1] * weight; b += data[i + 2] * weight; n += weight
      }
      setTint([Math.round(r / n), Math.round(g / n), Math.round(b / n)])
    } catch { setTint(null, src) }
  }
  img.onerror = () => setTint(null, src)
  img.src = src
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

export function sectionTitle(text, extra = null) {
  return h('div', { class: 'section-head' }, h('h2', { class: 'section-title', text }), extra)
}

export function grid(items, render) {
  const el = h('div', { class: 'card-grid' })
  items.forEach((item, i) => { const c = render(item, i); if (c) el.append(c) })
  return el
}

// Infinite list helper: calls load(offset) until it returns fewer than `page`.
export function infinite(container, load, render, { page = 60 } = {}) {
  let offset = 0
  let done = false
  let busy = false
  const sentinel = h('div', { class: 'sentinel' })
  container.after(sentinel)
  const more = async () => {
    if (done || busy) return
    busy = true
    try {
      const items = await load(offset, page)
      items.forEach((item, i) => { const el = render(item, offset + i); if (el) container.append(el) })
      offset += items.length
      if (items.length < page) { done = true; observer.disconnect(); sentinel.remove() }
    } catch (error) { toastError(error); done = true }
    busy = false
    if (!done && sentinel.getBoundingClientRect().top < window.innerHeight + 600) more()
  }
  const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more() }, { rootMargin: '600px' })
  observer.observe(sentinel)
  more()
  return { reset: () => { offset = 0; done = false; clear(container) } }
}
