// "Save to playlist" dialog used by the + buttons (mixes, albums, online
// playlists, the queue, multi-selection): new playlist with a suggested name,
// or add to an existing one. Online items are downloaded into the playlist.

import { app } from './app.js'
import { get, post, artworkUrl } from './api.js'
import { h, t, icon, modal, toast, toastError, iconButton, plural, artwork } from './dom.js'
import { refreshPlaylists } from './components.js'

/** Name that does not clash with the user's playlists: "Name", "Name 2"… */
export function suggestName(base) {
  const clean = String(base || '').trim().slice(0, 100) || t('player.playlist.untitled')
  const taken = new Set((app.playlists || []).map((p) => p.name.trim().toLowerCase()))
  if (!taken.has(clean.toLowerCase())) return clean
  for (let i = 2; i < 100; i++) {
    const candidate = `${clean} ${i}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return clean
}

/**
 * opts:
 *  - name: suggested playlist name
 *  - trackIds | getTrackIds(): library tracks to save
 *  - onlineItem: online album / playlist / track (downloaded into the playlist)
 *  - count: number shown in the dialog (optional)
 */
export async function saveToPlaylistDialog({ name = '', trackIds = null, getTrackIds = null, onlineItem = null, count = null } = {}) {
  if (onlineItem && !onlineItem.library && !app.canDownload) {
    toast(t('player.downloads.notAllowed'), { type: 'error' })
    return null
  }
  const editable = (app.playlists || []).filter((p) => p.editable)
  const result = await modal({
    title: t('player.save.title'),
    build: (close) => {
      let mode = 'new'
      const nameInput = h('input', { class: 'input', type: 'text', maxLength: 120, value: suggestName(name) })
      const filter = h('input', { class: 'input input--search', type: 'search', placeholder: t('player.save.findPlaylist') })
      const list = h('div', { class: 'save-list', role: 'radiogroup' })
      let chosen = null
      const paintList = () => {
        list.replaceChildren()
        const q = filter.value.trim().toLowerCase()
        const rows = editable.filter((p) => !q || p.name.toLowerCase().includes(q))
        if (!rows.length) list.append(h('p', { class: 'muted small', text: t('player.save.noPlaylists') }))
        for (const pl of rows) {
          const row = h('button', { type: 'button', class: ['save-row', chosen === pl.id && 'is-on'], role: 'radio', 'aria-checked': String(chosen === pl.id) },
            artwork(pl.trackCount ? artworkUrl(pl.artwork, 64) : null, { cls: 'save-row__art', placeholder: 'list', seed: pl.name }),
            h('span', { class: 'save-row__text' }, h('b', { text: pl.name }), h('small', { class: 'muted', text: plural(pl.trackCount, 'player.count.track', 'player.count.tracks') })),
            h('span', { class: 'save-row__check' }, icon('check', { size: 16 })))
          row.addEventListener('click', () => { chosen = pl.id; paintList(); submit.disabled = false })
          list.append(row)
        }
      }
      const newPane = h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', { class: 'field__label', text: t('player.playlist.name') }), nameInput))
      const oldPane = h('div', { class: 'stack', hidden: true }, filter, list)
      filter.addEventListener('input', paintList)
      const tabs = h('div', { class: 'segmented segmented--full', role: 'tablist' })
      const submit = h('button', { type: 'submit', class: 'btn btn--primary', text: t('player.save.create') })
      for (const [key, label] of [['new', t('player.save.new')], ['existing', t('player.save.existing')]]) {
        const btn = h('button', { type: 'button', class: ['segmented__btn', key === mode && 'is-active'], role: 'tab', text: label, disabled: key === 'existing' && !editable.length })
        btn.addEventListener('click', () => {
          mode = key
          tabs.querySelectorAll('.segmented__btn').forEach((b) => b.classList.toggle('is-active', b === btn))
          newPane.hidden = key !== 'new'
          oldPane.hidden = key !== 'existing'
          submit.textContent = key === 'new' ? t('player.save.create') : t('player.save.add')
          submit.disabled = key === 'existing' && !chosen
          if (key === 'existing') { paintList(); filter.focus() } else nameInput.focus()
        })
        tabs.append(btn)
      }
      const note = onlineItem && !onlineItem.library
        ? h('p', { class: 'note', text: t('player.save.downloadNote') })
        : count != null ? h('p', { class: 'muted small', text: plural(count, 'player.count.track', 'player.count.tracks') }) : null
      const form = h('form', { class: 'stack' }, tabs, newPane, oldPane, note,
        h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn--ghost', text: t('player.common.cancel'), onclick: () => close(null) }), submit))
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        if (mode === 'new') {
          const value = nameInput.value.trim()
          if (!value) return nameInput.focus()
          close({ mode, name: value })
        } else if (chosen) close({ mode, playlistId: chosen })
      })
      setTimeout(() => { nameInput.focus(); nameInput.select() }, 30)
      return form
    }
  })
  if (!result) return null
  try {
    // Online album / playlist / track: download into the playlist.
    if (onlineItem && !(onlineItem.library?.trackId || onlineItem.library?.trackIds || onlineItem.library?.albumId)) {
      // Songs already in the library go in right away; the rest follow
      // as they finish downloading.
      const owned = [...new Set((trackIds || []).map(Number).filter((n) => n > 0))]
      let pl
      if (result.mode === 'new') pl = await post('/playlists', { name: result.name, trackIds: owned })
      else {
        pl = { id: result.playlistId }
        if (owned.length) {
          const current = await get(`/playlists/${result.playlistId}`)
          const have = new Set(current.tracks.map((tr) => tr.id))
          const fresh = owned.filter((id) => !have.has(id))
          if (fresh.length) await post(`/playlists/${result.playlistId}/tracks`, { trackIds: fresh })
        }
      }
      await refreshPlaylists()
      await app.downloads.request(onlineItem, { playlistId: pl.id })
      return pl
    }
    let ids = trackIds || (getTrackIds ? await getTrackIds() : [])
    if (!ids.length && onlineItem?.library) ids = await libraryIdsOf(onlineItem)
    ids = [...new Set(ids.map(Number).filter((n) => n > 0))]
    if (!ids.length) { toast(t('player.playback.nothing')); return null }
    if (result.mode === 'new') {
      const pl = await post('/playlists', { name: result.name, trackIds: ids })
      await refreshPlaylists()
      toast(t('player.playlist.created', { name: pl.name }), { type: 'success', action: { label: t('player.save.open'), run: () => app.nav(`/playlist/${pl.id}`) } })
      return pl
    }
    // Existing playlist: skip songs that are already in it.
    const current = await get(`/playlists/${result.playlistId}`)
    const have = new Set(current.tracks.map((tr) => tr.id))
    const fresh = ids.filter((id) => !have.has(id))
    if (fresh.length) await post(`/playlists/${result.playlistId}/tracks`, { trackIds: fresh })
    await refreshPlaylists()
    const skipped = ids.length - fresh.length
    toast(skipped ? t('player.save.addedSkipped', { n: fresh.length, skipped, name: current.name }) : t('player.playlist.addedTo', { name: current.name }),
      { type: 'success', action: { label: t('player.save.open'), run: () => app.nav(`/playlist/${result.playlistId}`) } })
    return current
  } catch (error) {
    toastError(error)
    return null
  }
}

async function libraryIdsOf(item) {
  const lib = item.library || {}
  if (lib.trackId) return [lib.trackId]
  if (lib.trackIds) return lib.trackIds
  if (lib.albumId) return (await get(`/albums/${lib.albumId}`)).tracks.map((tr) => tr.id)
  return []
}

/** Small round "+" used on cards and headers. */
export function saveButton(opts, { size = 18, cls = 'save-btn' } = {}) {
  const btn = iconButton('playlistAdd', t('player.save.title'), (e) => {
    e.preventDefault()
    e.stopPropagation()
    saveToPlaylistDialog(typeof opts === 'function' ? opts() : opts)
  }, { cls, size })
  return btn
}
