// Online detail pages (Deezer / YouTube Music / Spotify): album, playlist,
// artist and mood. Owned songs play from the library, others offer preview
// and download into the library.

import { app } from '../app.js'
import { get, post, api } from '../api.js'
import { h, t, icon, iconButton, artwork, contextMenu, fmtLong, fmtNumber, plural, emptyState, toast, toastError } from '../dom.js'
import { hero, actionBar, onlineTrackList, shelf, onlineCard, playOnline, providerName, createPlaylistFlow, grid, setTint, refreshPlaylists, artistBio, selectButton } from '../components.js'
import { downloadButton } from '../downloads.js'
import { discographyCard } from '../discographyWizard.js'
import { saveButton } from '../playlistSave.js'

function sourceMenu(item) {
  const link = item.url || item.sourceUrl
  return iconButton('more', t('player.common.more'), (e) => contextMenu([
    item.seed && app.providers.includes('deezer') && { label: t('player.menu.goToArtist'), icon: 'user', run: () => app.nav(`/online/artist?name=${encodeURIComponent(item.seed)}`) },
    link && { label: t('player.menu.openSource', { provider: providerName(item.provider) }), icon: 'external', run: () => window.open(link, '_blank', 'noopener,noreferrer') }
  ], e.currentTarget), { cls: 'icon-btn--lg', size: 26 })
}

// Mixes without a downloadable link: every missing song is downloaded on its own.
function downloadEachButton(tracks, title = null) {
  const btn = h('button', { type: 'button', class: 'btn btn--outline' }, icon('download', { size: 18 }), h('span', { text: t('player.online.downloadMissing') }))
  btn.addEventListener('click', async () => {
    const missing = tracks.filter((tr) => !tr.library && tr.url)
    if (!missing.length) return
    btn.disabled = true
    if (!(await app.downloads.requestMany(missing, { title }))) btn.disabled = false
  })
  return btn
}

// "Download" on an album or playlist the library partly has: only the
// missing songs are requested (and the button says so).
function downloadMissingButton(item, kind, tracks) {
  const missing = tracks.filter((tr) => !tr.library)
  const partial = missing.length > 0 && missing.length < tracks.length
  const only = partial ? missing.map((tr) => ({ id: tr.id, url: tr.url, title: tr.title, artist: tr.artist, album: tr.album, isrc: tr.isrc, duration: tr.duration })) : undefined
  return downloadButton({ ...item, kind, trackCount: tracks.length || item.trackCount, only }, {
    compact: false,
    idleLabel: partial ? t('player.online.downloadMissingCount', { n: missing.length }) : null
  })
}

function ownedChip(owned, total) {
  if (!total) return null
  const complete = owned >= total
  return h('span', { class: ['chip-mini', complete ? 'chip-mini--accent' : 'chip-mini--warn'] },
    complete ? t('player.online.complete') : t('player.online.ownedOf', { owned, total }))
}

function playable(tracks) {
  return tracks.some((tr) => tr.library?.trackId || tr.previewUrl)
}

function playFirst(tracks, context) {
  const i = tracks.findIndex((tr) => tr.library?.trackId || tr.previewUrl)
  if (i >= 0) playOnline(tracks, i, context)
}

async function albumView(query) {
  const data = await get('/online/album', { provider: query.get('provider'), id: query.get('id'), url: query.get('url'), artist: query.get('artist') })
  const album = data.album
  const tracks = data.tracks || []
  const context = { label: album.title }
  const artistLink = album.providerIds?.deezerArtist
    ? h('a', { href: `#/online/artist?id=${album.providerIds.deezerArtist}`, text: album.artist })
    : album.artist ? h('a', { href: `#/online/artist?name=${encodeURIComponent(album.artist)}`, text: album.artist }) : null
  const root = h('div', { class: 'detail' },
    hero({
      art: artwork(album.artworkUrl, { alt: album.title, placeholder: 'album', seed: album.title, lazy: false }),
      kind: `${album.recordType === 'single' ? t('player.kind.single') : t('player.kind.album')} · ${providerName(album.provider)}`,
      title: album.title,
      meta: [artistLink, album.year, tracks.length ? plural(tracks.length, 'player.count.track', 'player.count.tracks') : null, tracks.reduce((s, x) => s + (x.duration || 0), 0) ? fmtLong(tracks.reduce((s, x) => s + (x.duration || 0), 0)) : null, ownedChip(data.ownedTracks, tracks.length)]
    }))
  const extra = []
  const complete = album.library?.complete
  if (album.library?.albumId) extra.push(h('a', { class: 'btn btn--outline btn--pill', href: `#/album/${album.library.albumId}` }, icon('library', { size: 18 }), t('player.online.openInLibrary')))
  if (!complete && app.canDownload) extra.push(downloadMissingButton(album, 'album', tracks))
  if (complete || app.canDownload) extra.push(onlineSave(album, 'album', tracks))
  if (tracks.length) extra.push(selectButton(() => root.querySelector('.tracklist')))
  extra.push(sourceMenu(album))
  root.append(playable(tracks)
    ? actionBar({ onPlay: () => playFirst(tracks, context), extra })
    : h('div', { class: 'action-bar' }, ...extra))
  if (!app.canDownload && !complete) root.append(h('p', { class: 'note', text: t('player.downloads.notAllowedHint') }))
  root.append(onlineTrackList(tracks, { context, showAlbum: false }))
  return { node: root, hero: true }
}

// "+" → save as a playlist: owned songs now, the rest downloaded into it.
function onlineSave(item, kind, tracks) {
  const ownedIds = tracks.map((x) => x.library?.trackId).filter(Boolean)
  const all = ownedIds.length === tracks.length && tracks.length > 0
  return saveButton(() => ({
    name: item.title,
    trackIds: ownedIds,
    onlineItem: all ? null : { ...item, kind, trackCount: tracks.length },
    onlineTracks: item.downloadable === false ? tracks : null,
    count: tracks.length
  }), { cls: 'icon-btn--lg', size: 24 })
}

// Follow: the list is tied to a player playlist and checked every day.
function followButton(pl, current) {
  let follow = current
  const btn = h('button', { type: 'button', class: 'btn btn--outline btn--pill' })
  const paint = () => {
    btn.classList.toggle('is-on', Boolean(follow))
    btn.textContent = follow ? t('player.follow.following') : t('player.follow.follow')
    btn.title = t('player.follow.hint')
  }
  paint()
  btn.addEventListener('click', async () => {
    btn.disabled = true
    try {
      if (follow) {
        if (follow.playlistId) return app.nav(`/playlist/${follow.playlistId}`)
      } else {
        follow = await post('/follows/playlists', { provider: pl.provider, id: pl.id, url: pl.url, title: pl.title, artworkUrl: pl.artworkUrl, mix: pl.mix })
        await refreshPlaylists()
        toast(t('player.follow.started', { name: pl.title }), { type: 'success', action: { label: t('player.save.open'), run: () => app.nav(`/playlist/${follow.playlistId}`) } })
      }
    } catch (error) { toastError(error) } finally { btn.disabled = false; paint() }
  })
  return btn
}

async function playlistView(query) {
  const data = await get('/online/playlist', { provider: query.get('provider'), id: query.get('id'), url: query.get('url'), mix: query.get('mix') })
  const pl = data.playlist
  const tracks = data.tracks || []
  const owned = tracks.filter((tr) => tr.library).length
  const context = { label: pl.title }
  const root = h('div', { class: 'detail' },
    hero({
      art: artwork(pl.artworkUrl, { alt: pl.title, placeholder: 'list', seed: pl.title, lazy: false }),
      kind: `${pl.mix ? t('player.kind.mix') : t('player.kind.playlist')} · ${providerName(pl.provider)}`,
      title: pl.title,
      meta: [pl.artist, plural(tracks.length, 'player.count.track', 'player.count.tracks'), ownedChip(owned, tracks.length)]
    }))
  const extra = []
  if (app.canDownload && owned < tracks.length) {
    extra.push(pl.downloadable === false ? downloadEachButton(tracks, pl.title) : downloadMissingButton(pl, 'playlist', tracks))
  }
  if (owned || app.canDownload) extra.push(onlineSave(pl, 'playlist', tracks))
  if (pl.downloadable !== false) extra.push(followButton(pl, data.follow))
  if (tracks.length) extra.push(selectButton(() => root.querySelector('.tracklist')))
  extra.push(sourceMenu(pl))
  root.append(playable(tracks) ? actionBar({ onPlay: () => playFirst(tracks, context), extra }) : h('div', { class: 'action-bar' }, ...extra))
  root.append(tracks.length ? onlineTrackList(tracks, { context }) : emptyState('list', t('player.online.emptyPlaylist')))
  return { node: root, hero: true }
}

// Follow button of an artist that is not in the library (yet). The server
// keeps the artist while it is followed, so new-release alerts work and the
// follow carries on once its songs are downloaded.
function onlineFollowButton(artist) {
  let on = Boolean(artist.follow?.following)
  const btn = h('button', { type: 'button', class: ['btn', 'btn--outline', 'btn--pill', on && 'is-on'] })
  const paint = () => { btn.classList.toggle('is-on', on); btn.textContent = on ? t('player.artist.following') : t('player.artist.follow') }
  paint()
  btn.addEventListener('click', async () => {
    btn.disabled = true
    try {
      const res = on
        ? await api('/follows/artists', { method: 'DELETE', query: { name: artist.title } })
        : await api('/follows/artists', { method: 'PUT', body: { name: artist.title, deezerId: artist.provider === 'deezer' ? artist.id : null } })
      on = Boolean(res.favorite)
      paint()
      toast(on ? t('player.favorite.added') : t('player.favorite.removed'))
    } catch (error) { toastError(error) } finally { btn.disabled = false }
  })
  return btn
}

async function artistView(query) {
  const data = await get('/online/artist', { id: query.get('id'), name: query.get('name') })
  const artist = data.artist
  // In the library: one page for both (library rows + every online row).
  if (artist.library?.artistId) {
    const { renderArtistPage } = await import('./detail.js')
    const page = await renderArtistPage(artist.library.artistId, data)
    history.replaceState(null, '', `#/artist/${artist.library.artistId}`)
    return page
  }
  const context = { label: artist.title }
  const root = h('div', { class: 'detail detail--artist' },
    hero({
      art: artwork(artist.artworkUrl, { alt: artist.title, round: true, placeholder: 'user', seed: artist.title, lazy: false }),
      round: true,
      kind: `${t('player.kind.artist')} · ${providerName(artist.provider)}`,
      title: artist.title,
      meta: [artist.fans ? t('player.online.fans', { n: fmtNumber(artist.fans) }) : null, data.albums.length ? plural(data.albums.length, 'player.count.album', 'player.count.albums') : null]
    }))
  const extra = [onlineFollowButton(artist), sourceMenu(artist)]
  root.append(playable(data.topTracks) ? actionBar({ onPlay: () => playFirst(data.topTracks, context), extra }) : h('div', { class: 'action-bar' }, ...extra))
  const gapCard = discographyCard(data, { name: artist.title })
  if (gapCard) root.append(gapCard)
  if (data.topTracks.length) root.append(h('section', { class: 'section' }, h('h2', { class: 'section-title', text: t('player.artist.popular') }), onlineTrackList(data.topTracks.slice(0, 10), { context })))
  if (data.albums.length) root.append(shelf({ title: t('player.artist.albums'), items: data.albums, render: (item, i) => onlineCard(item, data.albums, i) }))
  if (data.singles.length) root.append(shelf({ title: t('player.artist.singlesEps'), items: data.singles, render: (item, i) => onlineCard(item, data.singles, i) }))
  const bioSlot = h('div', { class: 'hero__bio', hidden: true })
  root.querySelector('.hero')?.append(bioSlot)
  artistBio(bioSlot, { name: artist.title, deezerId: artist.provider === 'deezer' ? artist.id : null })
  if (data.related.length) root.append(shelf({ title: t('player.artist.related'), items: data.related, render: (item, i) => onlineCard(item, data.related, i) }))
  return { node: root, hero: true }
}

async function moodView(preset) {
  const data = await get(`/discover/mood/${encodeURIComponent(preset)}`, { lang: document.documentElement.lang || 'en' })
  const items = data.items || []
  const title = t(`player.mood.${preset}`)
  const root = h('div', { class: 'detail' },
    hero({ art: h('div', { class: 'genre-art genre-art--mood', text: title.slice(0, 1) }), kind: t('player.kind.mood'), title, meta: [providerName('youtube')] }))
  setTint(null, `mood-${preset}`)
  const tracks = items.filter((x) => x.kind === 'track')
  const collections = items.filter((x) => x.kind !== 'track')
  const context = { label: title, route: `/mood/${preset}` }
  if (!items.length) root.append(emptyState('music', t('player.online.moodEmpty')))
  if (collections.length) root.append(h('section', { class: 'section' }, h('h2', { class: 'section-title', text: t('player.online.moodPlaylists') }), grid(collections, (item, i) => onlineCard(item, collections, i, context))))
  if (tracks.length) root.append(h('section', { class: 'section' }, h('h2', { class: 'section-title', text: t('player.library.tracks') }), onlineTrackList(tracks, { context })))
  return { node: root, hero: true }
}

export async function render(name, params, query) {
  if (name === 'album') return albumView(query)
  if (name === 'playlist') return playlistView(query)
  if (name === 'artist') return artistView(query)
  return moodView(params[0])
}
