// Downloads page: live progress of library downloads, retry / cancel and
// quick play of finished items. Songs picked together are one group entry
// (what is downloading now, how many are done / left), its songs behind a
// toggle; album and playlist downloads show which song of how many.

import { app, bus } from '../app.js'
import { get, post } from '../api.js'
import { h, t, icon, clear, artwork, fmtRelative, emptyState, toggle } from '../dom.js'
import { playTracks, providerName } from '../components.js'
import { ACTIVE_DOWNLOAD_STATUSES } from '../downloads.js'

// "Downloading", "Converting" ... for a core phase, else the status.
function phaseText(status, phase) {
  if (phase === 'waiting-folder') return t('player.health.waitingFolder')
  if (['preparing', 'downloading', 'converting'].includes(phase) && status === 'downloading') return t(`player.downloads.phase.${phase}`)
  return t(`player.downloads.status.${status}`)
}

// "Song 5 of 12 · converting" for album / playlist jobs.
function stepsText(d) {
  const s = d.steps
  if (!s?.total || !ACTIVE_DOWNLOAD_STATUSES.has(d.status)) return null
  if (d.phase === 'converting') return t('player.downloads.steps.converting', { n: Math.min(s.total, s.converted + 1), total: s.total })
  if (s.downloaded >= s.total) return t('player.downloads.steps.downloaded', { total: s.total })
  return t('player.downloads.steps.downloading', { n: Math.min(s.total, s.downloaded + 1), total: s.total, done: s.downloaded })
}

async function playResult(trackIds, label) {
  const res = await post('/tracks/batch', { ids: trackIds })
  playTracks(res.items, 0, { label: label || '', route: '/downloads', downloadsOnly: true })
}

function row(d, { child = false } = {}) {
  const active = ACTIVE_DOWNLOAD_STATUSES.has(d.status)
  const actions = h('div', { class: 'dl-row__actions' })
  if (active) actions.append(h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => app.downloads.cancel(d.id) }, icon('close', { size: 16 }), child ? null : t('player.common.cancel')))
  if (d.status === 'failed' || d.status === 'canceled') actions.append(h('button', { type: 'button', class: 'btn btn--outline btn--sm', onclick: () => app.downloads.retry(d.id) }, icon('refresh', { size: 16 }), child ? null : t('player.downloads.retry')))
  if ((d.status === 'completed' || d.status === 'exists') && d.trackIds?.length) {
    actions.append(h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => playResult(d.trackIds, d.title) }, icon('play', { size: 16 }), child ? null : t('player.common.play')))
    if (d.playlistId && !child) actions.append(h('a', { class: 'btn btn--ghost btn--sm', href: `#/playlist/${d.playlistId}`, text: t('player.downloads.openPlaylist') }))
  }
  const statusText = d.status === 'queued' && d.phase === 'retry-wait' ? t('player.downloads.retryWait', { n: d.attempts }) : phaseText(d.status, d.phase)
  const owner = app.isAdmin() && d.userId !== app.user?.id ? h('span', { class: 'pill', text: t('player.downloads.otherUser') }) : null
  const steps = stepsText(d)
  return h('div', { class: ['dl-row', `is-${d.status}`, child && 'dl-row--child'], dataset: { id: d.id, active: active ? '1' : '0' } },
    child ? null : artwork(d.artworkUrl, { cls: 'dl-row__art', placeholder: d.kind === 'album' ? 'album' : d.kind === 'playlist' ? 'list' : 'music', seed: d.title || d.sourceUrl }),
    h('div', { class: 'dl-row__main' },
      h('div', { class: 'dl-row__title' }, h('b', { text: d.title || d.sourceUrl }), child ? null : h('span', { class: 'pill', text: t(`player.kind.${d.kind}`) }), owner),
      h('div', { class: 'dl-row__sub muted' }, [d.artist, child ? null : providerName(d.provider), child ? null : fmtRelative(d.updatedAt)].filter(Boolean).join(' · ')),
      steps ? h('div', { class: 'dl-row__steps', text: steps }) : null,
      active && !child ? h('div', { class: 'progress' }, h('span', { style: { width: `${d.progress || 0}%` } })) : null,
      d.error && !active ? h('div', { class: 'dl-row__error', text: d.error.message || d.error.code }) : null),
    h('div', { class: ['status-pill', `status-pill--${d.status}`], text: active && d.status !== 'queued' ? `${statusText} · ${Math.round(d.progress || 0)}%` : statusText }),
    actions)
}

const CHILD_RANK = { downloading: 0, indexing: 0, resolving: 1, queued: 2 }

// One entry for songs picked together.
function groupCard(g, { expanded, children, onToggle }) {
  const c = g.counts || {}
  const name = g.title || t('player.downloads.group.untitled')
  const finished = (c.done || 0) + (c.failed || 0) + (c.canceled || 0) + (c.skipped || 0)
  const parts = [
    t('player.downloads.group.doneOf', { done: c.done || 0, total: c.total || 0 }),
    c.running && t('player.downloads.group.running', { n: c.running }),
    c.queued && t('player.downloads.group.queuedN', { n: c.queued }),
    c.waiting && t('player.downloads.group.waiting', { n: c.waiting }),
    c.failed && t('player.downloads.group.failed', { n: c.failed }),
    c.canceled && t('player.downloads.group.canceled', { n: c.canceled }),
    c.skipped && t('player.downloads.group.skipped', { n: c.skipped })
  ].filter(Boolean)
  const actions = h('div', { class: 'dl-row__actions' })
  if (g.active) actions.append(h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => app.downloads.cancelGroup(g.id) }, icon('close', { size: 16 }), t('player.downloads.group.cancelAll')))
  if (c.failed || (c.canceled && !g.active)) actions.append(h('button', { type: 'button', class: 'btn btn--outline btn--sm', onclick: () => app.downloads.retryGroup(g.id) }, icon('refresh', { size: 16 }), t('player.downloads.group.retryFailed')))
  const ids = (children || []).filter((d) => (d.status === 'completed' || d.status === 'exists')).flatMap((d) => d.trackIds || [])
  if (!g.active && c.done && expanded && ids.length) actions.append(h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => playResult(ids, name) }, icon('play', { size: 16 }), t('player.common.play')))
  const cur = g.current
  const now = cur ? h('div', { class: 'dl-group__now' },
    icon('download', { size: 14 }),
    h('span', { text: t('player.downloads.group.now') }),
    h('b', { text: [cur.title, cur.artist].filter(Boolean).join(' — ') }),
    h('span', { class: 'muted', text: `${phaseText(cur.status, cur.phase)} · ${Math.round(cur.progress || 0)}%` })) : null
  const statusText = g.status === 'canceled' ? t('player.downloads.status.canceled')
    : g.active ? `${Math.round(g.progress || 0)}%`
      : c.failed ? t('player.downloads.group.endedWithErrors') : t('player.downloads.status.completed')
  const status = g.status === 'canceled' ? 'canceled' : g.active ? 'downloading' : c.failed ? 'failed' : 'completed'
  const toggleBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm dl-group__toggle', 'aria-expanded': expanded ? 'true' : 'false', onclick: onToggle },
    icon(expanded ? 'chevU' : 'chevD', { size: 16 }), t(expanded ? 'player.downloads.group.hideSongs' : 'player.downloads.group.showSongs', { n: c.total || 0 }))
  const errors = !g.active && g.errors?.length
    ? h('ul', { class: 'dl-group__errors' }, ...g.errors.slice(0, 5).map((e) => h('li', { text: `${[e.title, e.artist].filter(Boolean).join(' — ')}: ${e.message || e.code}` })))
    : null
  const owner = app.isAdmin() && g.userId !== app.user?.id ? h('span', { class: 'pill', text: t('player.downloads.otherUser') }) : null
  return h('div', { class: ['dl-row', 'dl-group', `is-${status}`], dataset: { group: g.id, active: g.active ? '1' : '0' } },
    artwork(g.artworkUrl, { cls: 'dl-row__art', placeholder: 'list', seed: name }),
    h('div', { class: 'dl-row__main' },
      h('div', { class: 'dl-row__title' }, h('b', { text: name }), h('span', { class: 'pill', text: t('player.downloads.group.pill', { n: c.total || 0 }) }), owner),
      h('div', { class: 'dl-row__sub muted' }, [parts.join(' · '), fmtRelative(g.updatedAt)].join(' · ')),
      now,
      g.active ? h('div', { class: 'progress', title: `${finished}/${c.total || 0}` }, h('span', { style: { width: `${g.progress || 0}%` } })) : null,
      errors,
      toggleBtn,
      expanded ? h('div', { class: 'dl-group__songs' }, children ? (children.length ? children.map((d) => row(d, { child: true })) : h('p', { class: 'muted small', text: c.waiting ? t('player.downloads.group.allWaiting') : t('player.downloads.group.noSongs') })) : h('p', { class: 'muted small', text: '…' })) : null),
    h('div', { class: ['status-pill', `status-pill--${status}`], text: statusText }),
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
  let groups = []
  const expanded = new Set()
  const children = new Map()

  const groupNode = (g) => groupCard(g, { expanded: expanded.has(g.id), children: children.get(g.id), onToggle: () => toggleGroup(g.id) })

  async function loadChildren(id) {
    try {
      const res = await get('/downloads', { group: id, limit: 1000 })
      children.set(id, res.items || [])
    } catch { children.set(id, []) }
    repaintGroup(id)
  }

  function toggleGroup(id) {
    if (expanded.has(id)) expanded.delete(id)
    else {
      expanded.add(id)
      loadChildren(id)
    }
    repaintGroup(id)
  }

  function repaintGroup(id) {
    const g = groups.find((x) => x.id === id)
    const el = list.querySelector(`[data-group="${CSS.escape(id)}"]`)
    if (!g || !el) return
    if ((el.dataset.active === '1') === g.active) el.replaceWith(groupNode(g))
    else paint()
  }

  function paint() {
    clear(list)
    if (!items.length && !groups.length) { list.append(emptyState('download', t('player.downloads.emptyTitle'), t('player.downloads.emptyText'), { label: t('player.nav.search'), run: () => app.nav('/search') })); return }
    const entries = [
      ...groups.map((g) => ({ at: g.createdAt, active: g.active, node: () => groupNode(g) })),
      ...items.map((d) => ({ at: d.createdAt, active: ACTIVE_DOWNLOAD_STATUSES.has(d.status), node: () => row(d) }))
    ].sort((a, b) => (b.at || 0) - (a.at || 0))
    const active = entries.filter((e) => e.active)
    const done = entries.filter((e) => !e.active)
    if (active.length) list.append(h('h2', { class: 'section-title', text: t('player.downloads.active', { n: active.length }) }), ...active.map((e) => e.node()))
    if (done.length) list.append(h('h2', { class: 'section-title', text: t('player.downloads.history') }), ...done.map((e) => e.node()))
  }

  async function load() {
    const [res, grp] = await Promise.all([
      get('/downloads', { all: showAll ? 1 : undefined, ungrouped: 1, limit: 200 }),
      get('/downloads/groups', { all: showAll ? 1 : undefined, limit: 50 }).catch(() => ({ items: [] }))
    ])
    items = res.items || []
    groups = grp.items || []
    for (const id of expanded) loadChildren(id)
    paint()
  }
  await load()
  const offRow = bus.on('download', (d) => {
    if (!root.isConnected) return
    if (!showAll && d.userId !== app.user?.id) return
    if (d.groupId) {
      // A song of a group: its card updates from the group event; an open
      // song list updates here.
      const kids = children.get(d.groupId)
      if (!kids) return
      const i = kids.findIndex((x) => x.id === d.id)
      const moved = i < 0 || kids[i].status !== d.status
      if (i >= 0) kids[i] = d
      else kids.push(d)
      const el = list.querySelector(`[data-group="${CSS.escape(d.groupId)}"] [data-id="${CSS.escape(d.id)}"]`)
      if (el && !moved) { el.replaceWith(row(d, { child: true })); return }
      // Running songs first, then the queue in its order (like the server).
      kids.sort((a, b) => (CHILD_RANK[a.status] ?? 3) - (CHILD_RANK[b.status] ?? 3) || (a.createdAt || 0) - (b.createdAt || 0))
      repaintGroup(d.groupId)
      return
    }
    const i = items.findIndex((x) => x.id === d.id)
    if (i >= 0) items[i] = d
    else items.unshift(d)
    const el = list.querySelector(`.dl-list > [data-id="${CSS.escape(d.id)}"]`)
    if (el && (el.dataset.active === '1') === ACTIVE_DOWNLOAD_STATUSES.has(d.status)) el.replaceWith(row(d))
    else paint()
  })
  const offGroup = bus.on('download-group', (g) => {
    if (!root.isConnected) return
    if (!showAll && g.userId !== app.user?.id) return
    const i = groups.findIndex((x) => x.id === g.id)
    if (i >= 0) { groups[i] = g; repaintGroup(g.id) } else { groups.unshift(g); paint() }
  })
  return { node: root, cleanup: () => { offRow?.(); offGroup?.() } }
}
