// "Complete the discography": a card on artist pages that opens a wizard
// listing every release the library lacks songs of (albums, EPs, singles,
// compilations) plus missing popular songs. Everything is selected at first;
// a release's box selects all its missing songs, and single songs can be
// left out. The card plays a short "preparing" animation while the list is
// read, so the dialog opens complete instead of showing a loader.

import { app } from './app.js'
import { get } from './api.js'
import { h, t, icon, artwork, fmtTime, modal, toast, toastError } from './dom.js'

const GROUPS = [
  ['album', 'player.gaps.group.albums'],
  ['ep', 'player.gaps.group.eps'],
  ['single', 'player.gaps.group.singles'],
  ['compile', 'player.gaps.group.compilations']
]

const groupOf = (release) => (GROUPS.some(([type]) => type === release.recordType) ? release.recordType : 'album')

// Banner text for the artist page. `albums`: the artist's albums (not
// singles) with their library state, `missingTop`: popular songs not owned.
// Only the parts that are not zero: "2 albums complete · 1 partly · 6 not
// at all · 7 popular tracks missing".
function summary(albums, missingTop) {
  const total = albums.length
  const complete = albums.filter((a) => a.library && a.library.complete !== false).length
  const partial = albums.filter((a) => a.library && a.library.complete === false).length
  const none = total - complete - partial
  if (!partial && !none && !missingTop) return ''
  const parts = []
  if (none === total && total) parts.push(t('player.gaps.noneOwned', { total }))
  else {
    if (complete) parts.push(t('player.gaps.albumsComplete', { n: complete }))
    if (partial) parts.push(t('player.gaps.albumsPartial', { n: partial }))
    if (none) parts.push(t('player.gaps.albumsMissing', { n: none }))
  }
  if (missingTop) parts.push(t('player.gaps.tracksMissing', { n: missingTop }))
  return parts.join(' · ')
}

/**
 * The artist page card. Returns null when nothing is missing as far as the
 * page can tell (the full check happens when the wizard opens).
 * `data`: the /online/artist answer, `name`: the artist name for the lookup.
 */
export function discographyCard(data, { name = null, topCount = 10, quietWhenComplete = false } = {}) {
  const albums = data.albums || []
  const missingTop = (data.topTracks || []).slice(0, topCount).filter((tr) => !tr.library).length
  const text = summary(albums, missingTop)
  if (!text) {
    if (!albums.length || quietWhenComplete) return null
    return h('div', { class: 'online-banner' }, icon('checkCircle', { size: 22 }),
      h('div', {}, h('b', { text: t('player.online.discographyComplete') })))
  }
  if (!app.canDownload) {
    return h('div', { class: 'online-banner' }, icon('sparkles', { size: 22 }),
      h('div', {}, h('b', { text: t('player.gaps.title') }), h('span', { text: `${text} ${t('player.downloads.notAllowedHint')}` })))
  }
  const label = h('span', { class: 'gap-card__text', text })
  const cta = h('span', { class: 'gap-card__cta' }, h('span', { text: t('player.gaps.cta') }), icon('chevR', { size: 18 }))
  const card = h('button', { type: 'button', class: 'online-banner gap-card' },
    h('span', { class: 'gap-card__icon' }, icon('sparkles', { size: 22 })),
    h('span', { class: 'gap-card__body' }, h('b', { text: t('player.gaps.title') }), label),
    cta,
    h('span', { class: 'gap-card__sweep', 'aria-hidden': 'true' }))
  let busy = false
  card.addEventListener('click', async () => {
    if (busy) return
    busy = true
    card.classList.add('is-preparing')
    card.setAttribute('aria-busy', 'true')
    label.textContent = t('player.gaps.preparing')
    const started = performance.now()
    try {
      const artist = data.artist || {}
      const gaps = await get('/online/artist/gaps', artist.provider === 'deezer' && artist.id ? { id: artist.id } : { name: name || artist.title })
      // Let the animation finish one round even when the answer was cached.
      const wait = 650 - (performance.now() - started)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      if (!gaps.releases.length && !gaps.popular.length) {
        toast(t('player.gaps.nothing'), { type: 'success' })
      } else {
        card.classList.add('is-ready')
        await new Promise((resolve) => setTimeout(resolve, 180))
        openWizard(gaps)
      }
    } catch (error) {
      toastError(error)
    } finally {
      busy = false
      card.classList.remove('is-preparing', 'is-ready')
      card.removeAttribute('aria-busy')
      label.textContent = text
    }
  })
  return card
}

function openWizard(gaps) {
  const artistName = gaps.artist?.title || ''
  return modal({
    title: t('player.gaps.modalTitle', { artist: artistName }),
    wide: true,
    build: (close) => wizardBody(gaps, close)
  })
}

function wizardBody(gaps, close) {
  // Only missing songs can be picked; every one of them starts picked.
  const picked = new Set()
  const releases = gaps.releases.map((release) => ({ release, songs: release.tracks.filter((tr) => !tr.library) }))
  for (const { songs } of releases) for (const song of songs) picked.add(song)
  for (const song of gaps.popular) picked.add(song)

  const painters = []
  const repaint = () => { for (const paint of painters) paint() }

  const setMany = (songs, on) => {
    for (const song of songs) on ? picked.add(song) : picked.delete(song)
    repaint()
  }
  const triState = (box, songs) => {
    const n = songs.filter((song) => picked.has(song)).length
    box.checked = n > 0 && n === songs.length
    box.indeterminate = n > 0 && n < songs.length
  }
  const groupBox = (songs, label) => {
    const box = h('input', { type: 'checkbox', class: 'gap-check', 'aria-label': label })
    box.addEventListener('click', (e) => e.stopPropagation())
    box.addEventListener('change', () => setMany(songs, box.checked))
    painters.push(() => triState(box, songs))
    return box
  }

  const songRow = (song, index) => {
    const owned = Boolean(song.library)
    const box = h('input', { type: 'checkbox', class: 'gap-check', disabled: owned, checked: owned, 'aria-label': song.title })
    if (!owned) {
      box.addEventListener('change', () => setMany([song], box.checked))
      painters.push(() => { box.checked = picked.has(song) })
    }
    return h('label', { class: ['gap-song', owned && 'is-owned'] },
      box,
      h('span', { class: 'gap-song__no', text: index != null ? String(index + 1) : '' }),
      h('span', { class: 'gap-song__title' }, h('span', { text: song.title }),
        owned ? h('small', { class: 'gap-song__tag', text: t('player.gaps.owned') }) : null),
      h('span', { class: 'gap-song__time', text: song.duration ? fmtTime(song.duration) : '' }))
  }

  const releaseRow = ({ release, songs }) => {
    const box = groupBox(songs, release.title)
    const meta = [
      release.year,
      release.missing === release.trackCount
        ? t('player.gaps.songs', { n: release.trackCount })
        : t('player.gaps.missingOf', { missing: release.missing, total: release.trackCount })
    ].filter(Boolean).join(' · ')
    const count = h('span', { class: 'gap-release__count' })
    painters.push(() => {
      const n = songs.filter((song) => picked.has(song)).length
      count.textContent = n && n < songs.length ? t('player.gaps.pickedOf', { n, total: songs.length }) : ''
    })
    const list = h('div', { class: 'gap-release__songs', hidden: true }, ...release.tracks.map((song, i) => songRow(song, i)))
    const toggle = h('button', { type: 'button', class: 'gap-release__toggle', 'aria-expanded': 'false', 'aria-label': t('player.gaps.showSongs') }, icon('chevD', { size: 18 }))
    const head = h('div', { class: 'gap-release__head' },
      box,
      artwork(release.artworkUrl, { alt: release.title, cls: 'gap-release__art', seed: release.title }),
      h('span', { class: 'gap-release__info' }, h('b', { text: release.title }), h('small', { text: meta })),
      count,
      toggle)
    const row = h('div', { class: 'gap-release' }, head, list)
    const flip = () => {
      const open = list.hidden
      list.hidden = !open
      row.classList.toggle('is-open', open)
      toggle.setAttribute('aria-expanded', String(open))
      toggle.setAttribute('aria-label', t(open ? 'player.gaps.hideSongs' : 'player.gaps.showSongs'))
    }
    head.addEventListener('click', (e) => { if (e.target !== box) flip() })
    return row
  }

  const section = (title, songs, rows) => h('section', { class: 'gap-group' },
    h('label', { class: 'gap-group__head' }, groupBox(songs, title), h('span', { text: title }),
      h('small', { class: 'muted', text: t('player.gaps.songs', { n: songs.length }) })),
    ...rows)

  const sections = []
  for (const [type, key] of GROUPS) {
    const own = releases.filter(({ release }) => groupOf(release) === type)
    if (!own.length) continue
    sections.push(section(t(key), own.flatMap(({ songs }) => songs), own.map(releaseRow)))
  }
  if (gaps.popular.length) {
    sections.push(section(t('player.gaps.group.popular'), gaps.popular,
      [h('div', { class: 'gap-release gap-release--flat' }, ...gaps.popular.map((song) => songRow(song, null)))]))
  }

  const everything = [...releases.flatMap(({ songs }) => songs), ...gaps.popular]
  const all = h('label', { class: 'gap-all' }, groupBox(everything, t('player.gaps.selectAll')), h('span', { text: t('player.gaps.selectAll') }))
  const status = h('span', { class: 'gap-footer__status' })
  const go = h('button', { type: 'button', class: 'btn btn--primary' })
  painters.push(() => {
    const n = countPicked(releases, gaps.popular, picked)
    status.textContent = t('player.gaps.picked', { releases: n.releases, tracks: n.tracks })
    go.textContent = t('player.gaps.download', { n: n.tracks })
    go.disabled = !n.tracks
  })
  go.addEventListener('click', async () => {
    const items = downloadItems(releases, gaps.popular, picked)
    if (!items.length) return
    go.disabled = true
    const group = await app.downloads.requestMany(items, {
      title: t('player.gaps.groupTitle', { artist: gaps.artist?.title || '' }),
      artworkUrl: gaps.artist?.artworkUrl || null
    })
    if (group) close(true)
    else go.disabled = false
  })
  repaint()
  return h('div', { class: 'gap-wizard' },
    h('p', { class: 'muted gap-wizard__lead', text: t('player.gaps.lead', { tracks: countPicked(releases, gaps.popular, picked).tracks }) }),
    all,
    ...sections,
    h('div', { class: 'gap-footer' }, status,
      h('button', { type: 'button', class: 'btn btn--ghost', text: t('player.common.cancel'), onclick: () => close(false) }),
      go))
}

// A single's song that a picked album song covers is downloaded once.
function covered(song, picked, byUrl) {
  const twin = song.sameAs && byUrl.get(song.sameAs)
  return Boolean(twin && picked.has(twin))
}

function songIndex(releases) {
  const byUrl = new Map()
  for (const { songs } of releases) for (const song of songs) byUrl.set(song.url, song)
  return byUrl
}

function countPicked(releases, popular, picked) {
  const byUrl = songIndex(releases)
  let tracks = 0
  let count = 0
  for (const { songs } of releases) {
    const n = songs.filter((song) => picked.has(song) && !covered(song, picked, byUrl)).length
    tracks += n
    if (n) count += 1
  }
  tracks += popular.filter((song) => picked.has(song)).length
  return { releases: count, tracks }
}

// One download per release (only the picked songs) and one per popular song.
function downloadItems(releases, popular, picked) {
  const byUrl = songIndex(releases)
  const items = []
  for (const { release, songs } of releases) {
    const chosen = songs.filter((song) => picked.has(song) && !covered(song, picked, byUrl))
    if (!chosen.length) continue
    const whole = chosen.length === release.trackCount
    items.push({
      kind: 'album',
      url: release.url,
      title: release.title,
      artist: release.artist,
      artworkUrl: release.artworkUrl,
      trackCount: release.trackCount,
      only: whole ? undefined : chosen.map((song) => ({
        id: song.id, url: song.url, title: song.title, artist: song.artist, album: release.title, isrc: song.isrc, duration: song.duration
      }))
    })
  }
  for (const song of popular) if (picked.has(song)) items.push({ ...song, kind: 'track' })
  return items
}
