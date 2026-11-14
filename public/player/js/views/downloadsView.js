// Downloads page: live progress of library downloads, retry / cancel and
// quick play of finished items.

import { app, bus } from '../app.js'
import { get } from '../api.js'
import { h, t, icon, clear, artwork, fmtRelative, emptyState, toggle } from '../dom.js'
import { playTracks, providerName } from '../components.js'
import { ACTIVE_DOWNLOAD_STATUSES } from '../downloads.js'

function row(d) {
  const active = ACTIVE_DOWNLOAD_STATUSES.has(d.status)
  const actions = h('div', { class: 'dl-row__actions' })
  if (active) actions.append(h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => app.downloads.cancel(d.id) }, icon('close', { size: 16 }), t('player.common.cancel')))
  if (d.status === 'failed' || d.status === 'canceled') actions.append(h('button', { type: 'button', class: 'btn btn--outline btn--sm', onclick: () => app.downloads.retry(d.id) }, icon('refresh', { size: 16 }), t('player.downloads.retry')))
  if ((d.status === 'completed' || d.status === 'exists') && d.trackIds?.length) {
    actions.append(h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: async () => {
      const res = await (await import('../api.js')).post('/tracks/batch', { ids: d.trackIds })
      playTracks(res.items, 0, { label: d.title || '', route: '/downloads' })
    } }, icon('play', { size: 16 }), t('player.common.play')))
    if (d.playlistId) actions.append(h('a', { class: 'btn btn--ghost btn--sm', href: `#/playlist/${d.playlistId}`, text: t('player.downloads.openPlaylist') }))
  }
  const statusText = d.status === 'queued' && d.phase === 'retry-wait'
    ? t('player.downloads.retryWait', { n: d.attempts })
    : t(`player.downloads.status.${d.status}`)
  const owner = app.isAdmin() && d.userId !== app.user?.id ? h('span', { class: 'pill', text: t('player.downloads.otherUser') }) : null
  return h('div', { class: ['dl-row', `is-${d.status}`], dataset: { id: d.id, active: active ? '1' : '0' } },
    artwork(d.artworkUrl, { cls: 'dl-row__art', placeholder: d.kind === 'album' ? 'album' : d.kind === 'playlist' ? 'list' : 'music', seed: d.title || d.sourceUrl }),
    h('div', { class: 'dl-row__main' },
      h('div', { class: 'dl-row__title' }, h('b', { text: d.title || d.sourceUrl }), h('span', { class: 'pill', text: t(`player.kind.${d.kind}`) }), owner),
      h('div', { class: 'dl-row__sub muted' }, [d.artist, providerName(d.provider), fmtRelative(d.updatedAt)].filter(Boolean).join(' · ')),
      active ? h('div', { class: 'progress' }, h('span', { style: { width: `${d.progress || 0}%` } })) : null,
      d.error && !active ? h('div', { class: 'dl-row__error', text: d.error.message || d.error.code }) : null),
    h('div', { class: ['status-pill', `status-pill--${d.status}`], text: active && d.status !== 'queued' ? `${statusText} · ${Math.round(d.progress || 0)}%` : statusText }),
    actions)
}

export async function render() {
  let showAll = false
  const root = h('div', { class: 'downloads-view' })
  const list = h('div', { class: 'dl-list' })
  const head = h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: t('player.nav.downloads') }),
    app.isPlayerAdmin() ? toggle(false, (v) => { showAll = v; load() }, { label: t('player.downloads.allUsers') }) : null)
  root.append(head)
  if (!app.canDownload) root.append(h('p', { class: 'note', text: t('player.downloads.notAllowedHint') }))
  else root.append(h('p', { class: 'muted', text: t('player.downloads.intro') }))
  root.append(list)
  let items = []

  function paint() {
    clear(list)
    if (!items.length) { list.append(emptyState('download', t('player.downloads.emptyTitle'), t('player.downloads.emptyText'), { label: t('player.nav.search'), run: () => app.nav('/search') })); return }
    const active = items.filter((d) => ACTIVE_DOWNLOAD_STATUSES.has(d.status))
    const done = items.filter((d) => !ACTIVE_DOWNLOAD_STATUSES.has(d.status))
    if (active.length) list.append(h('h2', { class: 'section-title', text: t('player.downloads.active', { n: active.length }) }), ...active.map(row))
    if (done.length) list.append(h('h2', { class: 'section-title', text: t('player.downloads.history') }), ...done.map(row))
  }

  async function load() {
    const res = await get('/downloads', { all: showAll ? 1 : undefined, limit: 200 })
    items = res.items || []
    paint()
  }
  await load()
  const off = bus.on('download', (d) => {
    if (!root.isConnected) return
    if (!showAll && d.userId !== app.user?.id) return
    const i = items.findIndex((x) => x.id === d.id)
    if (i >= 0) items[i] = d
    else items.unshift(d)
    const el = list.querySelector(`[data-id="${CSS.escape(d.id)}"]`)
    if (el && (el.dataset.active === '1') === ACTIVE_DOWNLOAD_STATUSES.has(d.status)) el.replaceWith(row(d))
    else paint()
  })
  return { node: root, cleanup: off }
}
