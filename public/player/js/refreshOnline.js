// "Refresh online" (admin): replace a library song with a version picked from
// YouTube Music results or pasted as a link. The old file goes to the player
// trash and the new one takes its name, folder and places in playlists.

import { bus } from './app.js'
import { get, post, artworkUrl } from './api.js'
import { h, t, icon, artwork, fmtTime, clear, modal, confirmDialog, toast, toastError, errorText } from './dom.js'

const POLL_MS = 2000

function primaryArtist(name) {
  return String(name || '').split(/\s*(?:,|;|&|\/| feat\.? | ft\.? | x )\s*/i)[0].trim()
}

// Follows the replacement batch and reports its end.
function follow(batchId, title) {
  const tick = async () => {
    let batch
    try { batch = (await get('/admin/health/batch')).batch } catch { return setTimeout(tick, POLL_MS * 2) }
    if (batch?.id !== batchId) return
    if (batch.running) return setTimeout(tick, POLL_MS)
    const error = batch.errors?.[0]
    if (batch.succeeded) {
      toast(t('player.refresh.done', { title }), { type: 'success' })
      bus.emit('library:changed', null)
    } else if (error) toast(`${t('player.refresh.failed', { title })} ${errorText(error)}`, { type: 'error' })
    else if (batch.canceled) toast(t('player.refresh.canceled', { title }))
  }
  setTimeout(tick, POLL_MS)
}

export function refreshOnline(track) {
  return modal({
    title: t('player.refresh.title'),
    wide: true,
    build: (close) => {
      const current = h('div', { class: 'refresh-current' },
        artwork(artworkUrl(track.artwork, 128), { cls: 'refresh-current__art', placeholder: 'music', seed: track.album || track.title }),
        h('div', { class: 'refresh-current__text' },
          h('b', { text: track.title }),
          h('small', { class: 'muted', text: [track.artist, track.duration ? fmtTime(track.duration) : null].filter(Boolean).join(' · ') })))

      async function choose(source) {
        const ok = await confirmDialog({
          title: t('player.refresh.title'),
          message: t('player.refresh.confirm', { old: track.title, new: source.title || source.url }),
          confirmLabel: t('player.refresh.replace'),
          danger: true
        })
        if (!ok) return
        try {
          const status = await post('/admin/health/replace', { trackId: track.id, source })
          toast(t('player.refresh.started', { title: track.title }))
          close(true)
          if (status.batch?.id) follow(status.batch.id, track.title)
        } catch (error) { toastError(error) }
      }

      // YouTube Music results.
      const query = h('input', {
        class: 'input', type: 'search', value: [primaryArtist(track.artist), track.title].filter(Boolean).join(' '),
        'aria-label': t('player.refresh.search')
      })
      const results = h('div', { class: 'refresh-results', 'aria-live': 'polite' })
      const row = (item) => {
        const gap = item.duration && track.duration ? Math.round(item.duration - track.duration) : null
        const length = item.duration ? fmtTime(item.duration) : null
        const diff = gap ? ` (${gap > 0 ? '+' : '−'}${fmtTime(Math.abs(gap))})` : ''
        return h('div', { class: 'refresh-result' },
          artwork(item.artworkUrl, { cls: 'refresh-result__art', placeholder: 'music', seed: item.title }),
          h('div', { class: 'refresh-result__text' },
            h('b', { text: item.title }),
            h('small', { class: 'muted', text: [item.artist, length ? `${length}${diff}` : null].filter(Boolean).join(' · ') })),
          h('a', { class: 'btn btn--ghost btn--sm', href: item.url, target: '_blank', rel: 'noopener noreferrer', title: t('player.refresh.open') }, icon('external', { size: 16 })),
          h('button', { type: 'button', class: 'btn btn--primary btn--sm', text: t('player.refresh.pick'), onclick: () => choose({
            url: item.url, title: item.title, artist: item.artist, duration: item.duration, artworkUrl: item.artworkUrl
          }) }))
      }
      let searchSeq = 0
      async function search() {
        const q = query.value.trim()
        if (!q) return
        const seq = ++searchSeq
        clear(results).append(h('div', { class: 'row-actions' }, h('span', { class: 'spinner spinner--sm' }), h('span', { class: 'muted', text: t('player.refresh.searching') })))
        try {
          const data = await get('/online/search', { q, kinds: 'track', providers: 'youtube', limit: 10 })
          if (seq !== searchSeq) return
          const tracks = (data.tracks || []).filter((item) => item.url)
          clear(results).append(...(tracks.length ? tracks.map(row) : [h('p', { class: 'muted small', text: t('player.refresh.noResults') })]))
        } catch (error) {
          if (seq === searchSeq) clear(results).append(h('p', { class: 'muted small', text: errorText(error) }))
        }
      }
      const searchForm = h('form', { class: 'refresh-search', onsubmit: (e) => { e.preventDefault(); search() } },
        query, h('button', { type: 'submit', class: 'btn btn--outline', text: t('player.refresh.search') }))

      // Or a link to one song.
      const link = h('input', { class: 'input', type: 'url', placeholder: 'https://music.youtube.com/watch?v=…', 'aria-label': t('player.refresh.link') })
      const linkForm = h('form', { class: 'refresh-search', onsubmit: (e) => {
        e.preventDefault()
        const url = link.value.trim()
        if (url) choose({ url })
      } }, link, h('button', { type: 'submit', class: 'btn btn--outline', text: t('player.refresh.useLink') }))

      search()
      return h('div', { class: 'stack refresh' },
        current,
        h('p', { class: 'muted small', text: t('player.refresh.hint') }),
        searchForm,
        results,
        h('div', { class: 'field' }, h('span', { class: 'field__label', text: t('player.refresh.link') }), linkForm))
    }
  })
}
