// Personal mixes, listening statistics and the yearly "Wrapped" story.

import { app } from '../app.js'
import { get, artworkUrl } from '../api.js'
import { h, t, icon, iconButton, clear, artwork, fmtLong, fmtNumber, plural, emptyState, toast } from '../dom.js'
import { hero, actionBar, trackList, onlineTrackList, playTracks, mixArt, mixTitle, mixDescription, shelf, albumCard, setTint, selectButton } from '../components.js'
import { saveButton } from '../playlistSave.js'
import { randomIndex } from '../random.js'

// ---- mix detail -----------------------------------------------------------------

async function mixView(id) {
  const mix = await get(`/mixes/${encodeURIComponent(id)}`)
  const context = { label: mixTitle(mix), route: `/mix/${id}` }
  const root = h('div', { class: 'detail' },
    hero({
      art: mixArt(mix, { size: 512 }),
      kind: t('player.mix.kind'),
      title: mixTitle(mix),
      description: mixDescription(mix),
      meta: [
        plural(mix.trackCount, 'player.count.track', 'player.count.tracks'),
        mix.duration ? fmtLong(mix.duration) : null,
        t(mix.kind === 'discover' ? 'player.mix.refreshWeekly' : 'player.mix.refreshDaily')
      ]
    }))
  setTint(null, `mix-${mix.kind}-${mix.titleVars?.n || ''}`)
  root.append(
    actionBar({
      onPlay: () => playTracks(mix.tracks, 0, context, { shuffle: false }),
      onShuffle: () => playTracks(mix.tracks, randomIndex(Math.max(1, mix.tracks.length)), context, { shuffle: true }),
      extra: [
        saveButton(() => ({ name: mixTitle(mix), trackIds: mix.tracks.map((tr) => tr.id), count: mix.tracks.length }), { cls: 'icon-btn--lg', size: 24 }),
        selectButton(() => root.querySelector('.tracklist'))
      ]
    }),
    trackList(mix.tracks, { context, showPlays: true }))
  // Songs that fit this mix: from the library and new ones (online radios).
  {
    const holder = h('section', { class: 'section mix-online' })
    root.append(holder)
    get(`/mixes/${encodeURIComponent(id)}/online`).then((res) => {
      if (!res.items?.length) return
      holder.append(
        h('div', { class: 'shelf__head' },
          h('div', { class: 'shelf__titles' },
            h('h2', { class: 'section-title', text: t('player.mix.onlineTitle') }),
            h('p', { class: 'shelf__subtitle', text: t(app.canDownload ? 'player.mix.onlineHintDownload' : 'player.mix.onlineHint') }))),
        onlineTrackList(res.items, { context: { label: mixTitle(mix), route: `/mix/${id}` } }))
    }).catch(() => {})
  }
  return { node: root, hero: true }
}

// ---- small chart pieces -----------------------------------------------------------

function bars(values, labels, { highlight = true, title = '' } = {}) {
  const max = Math.max(1, ...values)
  const peak = values.indexOf(Math.max(...values))
  return h('div', { class: 'bars', role: 'img', 'aria-label': title },
    values.map((v, i) => h('div', { class: ['bars__col', highlight && i === peak && v > 0 && 'is-peak'], title: `${labels[i]}: ${t('player.stats.minutesShort', { n: fmtNumber(v) })}` },
      h('div', { class: 'bars__bar', style: `--v:${(v / max).toFixed(3)}` }),
      h('span', { class: 'bars__label', text: labels[i] }))))
}

function weekdayNames() {
  const lang = document.documentElement.lang || 'en'
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(lang, { weekday: 'short' }))
}

function hourLabel(hr) {
  return `${String(hr).padStart(2, '0')}`
}

function statTile(iconName, value, label, cls = '') {
  return h('div', { class: `stat-tile ${cls}`.trim() },
    h('span', { class: 'stat-tile__icon' }, icon(iconName, { size: 20 })),
    h('b', { class: 'stat-tile__value', text: value }),
    h('span', { class: 'stat-tile__label', text: label }))
}

function fmtDay(key) {
  if (!key) return ''
  return new Date(`${key}T12:00:00`).toLocaleDateString(document.documentElement.lang || 'en', { day: 'numeric', month: 'long', year: 'numeric' })
}

function traitText(trait) {
  return { title: t(`player.stats.trait.${trait}`), text: t(`player.stats.trait.${trait}Desc`) }
}

function rankedArtist(artist, i) {
  return h('a', { class: 'rank-artist', href: `#/artist/${artist.id}` },
    h('span', { class: 'rank-artist__n', text: String(i + 1) }),
    artwork(artworkUrl(artist.artwork, 256), { round: true, placeholder: 'user', seed: artist.name, alt: artist.name }),
    h('b', { text: artist.name }),
    h('span', { class: 'muted small', text: plural(artist.plays, 'player.count.play', 'player.count.plays') }))
}

// ---- statistics page ------------------------------------------------------------

const RANGES = ['week', 'month', 'year', 'all']

async function statsView(query) {
  const root = h('div', { class: 'stats-page' })
  const body = h('div', { class: 'stats-page__body' })
  let range = RANGES.includes(query?.get?.('range')) ? query.get('range') : (app.prefs.statsRange || 'month')
  const chips = h('div', { class: 'chips', role: 'tablist' })
  for (const key of RANGES) {
    const chip = h('button', { type: 'button', class: ['chip', key === range && 'is-active'], role: 'tab', text: t(`player.stats.range.${key}`) })
    chip.addEventListener('click', () => {
      range = key
      app.setPref('statsRange', key)
      chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip))
      load()
    })
    chips.append(chip)
  }
  const years = await get('/stats/years').then((r) => r.items || []).catch(() => [])
  const thisYear = new Date().getFullYear()
  const wrappedYear = years.includes(thisYear) ? thisYear : years[0]
  root.append(
    h('header', { class: 'page-head' },
      h('div', {}, h('h1', { class: 'page-title', text: t('player.stats.title') }), h('p', { class: 'muted', text: t('player.stats.subtitle') })),
      chips),
    wrappedYear ? wrappedBanner(wrappedYear) : null,
    body)
  setTint(null, 'stats')

  async function load() {
    clear(body)
    body.append(h('div', { class: 'view-loading' }, h('div', { class: 'spinner' })))
    let s
    try { s = await get('/stats/listening', { range }) } catch (error) { clear(body); body.append(emptyState('info', t('player.error.title'), String(error?.message || ''))); return }
    clear(body)
    if (!s.plays) {
      body.append(emptyState('chart', t('player.stats.emptyTitle'), t('player.stats.emptyText')))
      return
    }
    const context = { label: t('player.stats.topTracks'), route: '/stats' }
    // Show the play count of the chosen period, not the all-time one.
    s.topTracks = s.topTracks.map((tr) => ({ ...tr, playCount: tr.plays }))
    body.append(
      h('div', { class: 'stat-tiles' },
        statTile('clock', fmtNumber(s.minutes), t('player.stats.minutes'), 'stat-tile--accent'),
        statTile('play', fmtNumber(s.plays), t('player.stats.plays')),
        statTile('music', fmtNumber(s.uniqueTracks), t('player.stats.uniqueTracks')),
        statTile('users', fmtNumber(s.uniqueArtists), t('player.stats.uniqueArtists')),
        statTile('flame', plural(s.streak.current, 'player.stats.day', 'player.stats.days'), t('player.stats.streak')),
        statTile('sparkles', fmtNumber(s.newArtists.count), t('player.stats.newArtists'))),
      s.traits.length ? h('div', { class: 'traits' }, s.traits.map((trait) => {
        const { title, text } = traitText(trait)
        return h('div', { class: `trait trait--${trait}` }, h('b', { text: title }), h('span', { text }))
      })) : null)

    if (s.topArtists.length) {
      body.append(h('section', { class: 'shelf' },
        h('div', { class: 'shelf__head' }, h('h2', { class: 'shelf__title', text: t('player.stats.topArtists') })),
        h('div', { class: 'rank-artists' }, s.topArtists.slice(0, 6).map(rankedArtist))))
    }
    if (s.topTracks.length) {
      const holder = h('section', { class: 'shelf' },
        h('div', { class: 'shelf__head' },
          h('h2', { class: 'shelf__title', text: t('player.stats.topTracks') }),
          h('button', { type: 'button', class: 'btn btn--outline btn--sm', onclick: () => playTracks(s.topTracks, 0, context) }, icon('play', { size: 16 }), t('player.stats.playTop'))),
        trackList(s.topTracks, { context, showPlays: true, showAlbum: false }))
      body.append(holder)
    }
    const albums = shelf({ title: t('player.stats.topAlbums'), items: s.topAlbums, render: albumCard })
    if (albums) body.append(albums)

    const charts = h('div', { class: 'stat-charts' },
      h('section', { class: 'panel-card' },
        h('h2', { class: 'panel-card__title', text: t('player.stats.byHour') }),
        bars(s.hours, s.hours.map((_, i) => (i % 3 === 0 ? hourLabel(i) : '')), { title: t('player.stats.byHour') })),
      h('section', { class: 'panel-card' },
        h('h2', { class: 'panel-card__title', text: t('player.stats.byWeekday') }),
        bars(s.weekdays, weekdayNames(), { title: t('player.stats.byWeekday') })))
    body.append(charts)

    if (s.topGenres.length) {
      const max = Math.max(...s.topGenres.map((g) => g.plays))
      body.append(h('section', { class: 'panel-card' },
        h('h2', { class: 'panel-card__title', text: t('player.stats.topGenres') }),
        h('div', { class: 'genre-bars' }, s.topGenres.map((g) => h('a', { class: 'genre-bar', href: `#/genre/${encodeURIComponent(g.name)}` },
          h('span', { class: 'genre-bar__name', text: g.name }),
          h('span', { class: 'genre-bar__track' }, h('span', { class: 'genre-bar__fill', style: `--v:${(g.plays / max).toFixed(3)}` })),
          h('span', { class: 'muted small', text: fmtNumber(g.plays) }))))))
    }
    const facts = [
      s.busiestDay && [t('player.stats.busiestDay'), `${fmtDay(s.busiestDay.date)} · ${t('player.stats.minutesShort', { n: fmtNumber(s.busiestDay.minutes) })}`],
      [t('player.stats.longestStreak'), plural(s.streak.longest, 'player.stats.day', 'player.stats.days')],
      [t('player.stats.activeDays'), fmtNumber(s.activeDays)],
      s.newArtists.names.length && [t('player.stats.newArtistsList'), s.newArtists.names.join(', ')]
    ].filter(Boolean)
    body.append(h('section', { class: 'panel-card' }, h('dl', { class: 'info-grid' }, facts.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))))
  }
  await load()
  return { node: root }
}

function wrappedBanner(year) {
  return h('a', { class: 'wrapped-banner', href: `#/wrapped/${year}` },
    h('span', { class: 'wrapped-banner__kicker', text: t('player.wrapped.kicker') }),
    h('b', { class: 'wrapped-banner__title', text: t('player.wrapped.bannerTitle', { year }) }),
    h('span', { class: 'wrapped-banner__cta' }, t('player.wrapped.open'), icon('chevR', { size: 18 })))
}

// ---- Wrapped story ------------------------------------------------------------------

const SLIDE_MS = 7000

function coverOf(item, size = 512) {
  return artworkUrl(item?.artwork, size)
}

function buildSlides(w) {
  const slides = []
  const name = app.user?.displayName || app.user?.username || ''
  const days = Math.floor(w.minutes / 1440)
  slides.push({ theme: 'intro', body: () => [
    h('span', { class: 'wr__kicker', lang: 'en', text: 'Gharmonize Player' }),
    h('h1', { class: 'wr__huge', text: String(w.year) }),
    h('p', { class: 'wr__lead', text: t('player.wrapped.intro', { name }) })
  ] })
  slides.push({ theme: 'minutes', body: () => [
    h('p', { class: 'wr__lead', text: t('player.wrapped.minutesLead') }),
    h('h1', { class: 'wr__huge wr__count', text: fmtNumber(w.minutes) }),
    h('p', { class: 'wr__big', text: t('player.wrapped.minutesUnit') }),
    h('p', { class: 'wr__sub', text: days >= 1 ? t('player.wrapped.minutesDays', { n: fmtNumber(days) }) : t('player.wrapped.minutesHours', { n: fmtNumber(Math.max(1, Math.round(w.minutes / 60))) }) }),
    h('p', { class: 'wr__sub', text: t('player.wrapped.activeDays', { n: fmtNumber(w.activeDays), plays: fmtNumber(w.plays) }) })
  ] })
  if (w.firstTrack) slides.push({ theme: 'first', body: () => [
    h('p', { class: 'wr__lead', text: t('player.wrapped.firstLead') }),
    artwork(coverOf(w.firstTrack), { cls: 'wr__cover', seed: w.firstTrack.title, lazy: false }),
    h('h2', { class: 'wr__title', text: w.firstTrack.title }),
    h('p', { class: 'wr__sub', text: w.firstTrack.artist || '' })
  ] })
  if (w.topGenres.length) slides.push({ theme: 'genre', body: () => [
    h('p', { class: 'wr__lead', text: t('player.wrapped.genreLead') }),
    h('h1', { class: 'wr__huge wr__huge--word', text: w.topGenres[0].name }),
    w.topGenres.length > 1 ? h('p', { class: 'wr__sub', text: t('player.wrapped.genreRest', { list: w.topGenres.slice(1, 4).map((g) => g.name).join(', ') }) }) : null
  ] })
  if (w.topArtists.length) {
    const top = w.topArtists[0]
    slides.push({ theme: 'artist', body: () => [
      h('p', { class: 'wr__lead', text: t('player.wrapped.artistLead') }),
      artwork(coverOf(top), { cls: 'wr__cover wr__cover--round', round: true, placeholder: 'user', seed: top.name, lazy: false }),
      h('h2', { class: 'wr__title', text: top.name }),
      h('p', { class: 'wr__sub', text: t('player.wrapped.artistPlays', { plays: fmtNumber(top.plays), minutes: fmtNumber(top.minutes) }) })
    ] })
    if (w.topArtists.length >= 3) slides.push({ theme: 'artists', body: () => [
      h('p', { class: 'wr__lead', text: t('player.wrapped.topArtists') }),
      h('ol', { class: 'wr__list' }, w.topArtists.slice(0, 5).map((a, i) => h('li', {},
        h('span', { class: 'wr__n', text: String(i + 1) }),
        artwork(coverOf(a, 128), { round: true, placeholder: 'user', seed: a.name, lazy: false }),
        h('b', { text: a.name }))))
    ] })
  }
  if (w.topTracks.length) {
    const top = w.topTracks[0]
    slides.push({ theme: 'track', body: () => [
      h('p', { class: 'wr__lead', text: t('player.wrapped.trackLead') }),
      artwork(coverOf(top), { cls: 'wr__cover', seed: top.album || top.title, lazy: false }),
      h('h2', { class: 'wr__title', text: top.title }),
      h('p', { class: 'wr__sub', text: `${top.artist || ''} · ${t('player.wrapped.trackPlays', { n: fmtNumber(top.plays) })}` })
    ] })
    if (w.topTracks.length >= 3) slides.push({ theme: 'tracks', body: () => [
      h('p', { class: 'wr__lead', text: t('player.wrapped.topTracks') }),
      h('ol', { class: 'wr__list' }, w.topTracks.slice(0, 5).map((tr, i) => h('li', {},
        h('span', { class: 'wr__n', text: String(i + 1) }),
        artwork(coverOf(tr, 128), { seed: tr.album || tr.title, lazy: false }),
        h('span', { class: 'wr__li-text' }, h('b', { text: tr.title }), h('small', { text: tr.artist || '' })))))
    ] })
  }
  const traits = w.traits || []
  if (traits.length) {
    const peak = w.hours.indexOf(Math.max(...w.hours))
    slides.push({ theme: 'trait', body: () => [
      h('p', { class: 'wr__lead', text: t('player.wrapped.traitLead') }),
      h('h1', { class: 'wr__huge wr__huge--word', text: traitText(traits[0]).title }),
      h('p', { class: 'wr__sub', text: traitText(traits[0]).text }),
      h('p', { class: 'wr__sub', text: t('player.wrapped.peakHour', { hour: `${hourLabel(peak)}:00` }) }),
      traits[1] ? h('p', { class: 'wr__pill', text: traitText(traits[1]).title }) : null
    ] })
  }
  if (w.streak.longest > 1 || w.busiestDay) slides.push({ theme: 'streak', body: () => [
    h('p', { class: 'wr__lead', text: t('player.wrapped.streakLead') }),
    h('h1', { class: 'wr__huge wr__count', text: fmtNumber(w.streak.longest) }),
    h('p', { class: 'wr__big', text: t('player.wrapped.streakUnit') }),
    w.busiestDay ? h('p', { class: 'wr__sub', text: t('player.wrapped.busiest', { date: fmtDay(w.busiestDay.date), minutes: fmtNumber(w.busiestDay.minutes) }) }) : null
  ] })
  slides.push({ theme: 'summary', summary: true, body: () => summaryCard(w) })
  return slides
}

function summaryCard(w) {
  return [
    h('div', { class: 'wr-sum' },
      h('div', { class: 'wr-sum__head' },
        w.topArtists[0] ? artwork(coverOf(w.topArtists[0]), { round: true, placeholder: 'user', seed: w.topArtists[0].name, lazy: false }) : null,
        h('div', {}, h('span', { class: 'wr__kicker', lang: 'en', text: `Gharmonize Player · ${w.year}` }), h('b', { class: 'wr-sum__name', text: app.user?.displayName || '' }))),
      h('div', { class: 'wr-sum__cols' },
        h('div', {}, h('span', { class: 'wr-sum__label', text: t('player.wrapped.sumArtists') }),
          h('ol', {}, w.topArtists.slice(0, 5).map((a) => h('li', { text: a.name })))),
        h('div', {}, h('span', { class: 'wr-sum__label', text: t('player.wrapped.sumTracks') }),
          h('ol', {}, w.topTracks.slice(0, 5).map((tr) => h('li', { text: tr.title }))))),
      h('div', { class: 'wr-sum__cols' },
        h('div', {}, h('span', { class: 'wr-sum__label', text: t('player.wrapped.sumMinutes') }), h('b', { class: 'wr-sum__big', text: fmtNumber(w.minutes) })),
        h('div', {}, h('span', { class: 'wr-sum__label', text: t('player.wrapped.topGenre') }), h('b', { class: 'wr-sum__big', text: w.topGenres[0]?.name || '—' }))))
  ]
}

/** Draws the summary as a 1080×1920 PNG (story size). */
async function summaryImage(w) {
  const W = 1080
  const H = 1920
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const c = canvas.getContext('2d')
  const g = c.createLinearGradient(0, 0, W, H)
  g.addColorStop(0, '#0d1b3a'); g.addColorStop(0.55, '#2563eb'); g.addColorStop(1, '#6a5acd')
  c.fillStyle = g
  c.fillRect(0, 0, W, H)
  const font = (size, weight = 800) => `${weight} ${size}px Inter, system-ui, sans-serif`
  const loadImg = (src) => new Promise((resolve) => {
    if (!src) return resolve(null)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
  const fit = (text, max) => { let s = String(text || ''); while (s.length > 1 && c.measureText(s).width > max) s = `${s.slice(0, -2)}…`; return s }
  c.fillStyle = '#f4f6fb'
  c.font = font(40, 700)
  c.fillText(`GHARMONIZE PLAYER · ${w.year}`, 80, 140)
  const cover = await loadImg(coverOf(w.topArtists[0] || w.topTracks[0], 512))
  if (cover) {
    c.save()
    c.beginPath(); c.arc(W / 2, 520, 300, 0, Math.PI * 2); c.clip()
    c.drawImage(cover, W / 2 - 300, 220, 600, 600)
    c.restore()
  }
  const col = (x, label, items) => {
    c.font = font(38, 700); c.fillStyle = 'rgba(244,238,221,.75)'; c.fillText(fit(label, 440), x, 960)
    c.font = font(44, 800); c.fillStyle = '#f4f6fb'
    items.slice(0, 5).forEach((text, i) => c.fillText(fit(`${i + 1}  ${text}`, 430), x, 1040 + i * 72))
  }
  col(80, t('player.wrapped.sumArtists'), w.topArtists.map((a) => a.name))
  col(570, t('player.wrapped.sumTracks'), w.topTracks.map((tr) => tr.title))
  c.font = font(38, 700); c.fillStyle = 'rgba(244,238,221,.75)'
  c.fillText(fit(t('player.wrapped.sumMinutes'), 440), 80, 1520)
  c.fillText(fit(t('player.wrapped.topGenre'), 440), 570, 1520)
  c.font = font(96, 900); c.fillStyle = '#f4f6fb'
  c.fillText(fit(fmtNumber(w.minutes), 460), 80, 1630)
  c.font = font(72, 900)
  c.fillText(fit(w.topGenres[0]?.name || '—', 440), 570, 1620)
  c.font = font(34, 600); c.fillStyle = 'rgba(244,238,221,.7)'
  c.fillText(app.user?.displayName || '', 80, 1820)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

async function wrappedView(yearParam) {
  const years = await get('/stats/years').then((r) => r.items || []).catch(() => [])
  const year = Number(yearParam) || years[0] || new Date().getFullYear()
  const w = await get('/stats/wrapped', { year })
  const root = h('div', { class: 'wrapped-page' })
  if (!w.plays) {
    root.append(emptyState('chart', t('player.wrapped.emptyTitle', { year }), t('player.wrapped.emptyText'), { label: t('player.stats.title'), run: () => app.nav('/stats') }))
    return { node: root }
  }
  const slides = buildSlides(w)
  let index = 0
  let timer = null
  let paused = false
  let started = 0
  let elapsed = 0
  const progress = h('div', { class: 'wr__progress' }, slides.map(() => h('span', {}, h('i'))))
  const stage = h('div', { class: 'wr__stage' })
  const close = () => { cleanup(); if (history.length > 1) history.back(); else app.nav('/stats') }
  const story = h('div', { class: 'wr', role: 'dialog', 'aria-label': t('player.wrapped.bannerTitle', { year }) },
    progress,
    h('div', { class: 'wr__top' },
      h('span', { class: 'wr__brand' }, h('img', { src: '/src/logo.png', alt: '' }), t('player.wrapped.brand', { year })),
      years.length > 1 ? h('select', { class: 'wr__year', 'aria-label': t('player.wrapped.year'), onchange: (e) => app.nav(`/wrapped/${e.target.value}`) },
        years.map((y) => h('option', { value: String(y), selected: y === year, text: String(y) }))) : null,
      iconButton('close', t('player.common.close'), close, { cls: 'wr__close', size: 24 })),
    stage,
    h('button', { type: 'button', class: 'wr__nav wr__nav--prev', 'aria-label': t('player.common.previous'), onclick: () => go(index - 1) }),
    h('button', { type: 'button', class: 'wr__nav wr__nav--next', 'aria-label': t('player.common.next'), onclick: () => go(index + 1) }))

  function tick() {
    clearTimeout(timer)
    if (paused || index >= slides.length - 1) return
    started = performance.now()
    timer = setTimeout(() => go(index + 1), SLIDE_MS - elapsed)
  }
  function go(next) {
    if (next < 0 || next >= slides.length) return
    index = next
    elapsed = 0
    const slide = slides[index]
    story.dataset.theme = slide.theme
    clear(stage)
    const content = h('div', { class: ['wr__slide', slide.summary && 'wr__slide--summary'] }, slide.body())
    if (slide.summary) {
      content.append(h('div', { class: 'wr__actions' },
        h('button', { type: 'button', class: 'btn btn--primary', onclick: () => { cleanup(); playTracks(w.topTracks, 0, { label: t('player.wrapped.bannerTitle', { year }), route: `/wrapped/${year}` }) } }, icon('play', { size: 18 }), t('player.wrapped.playTop')),
        h('button', { type: 'button', class: 'btn btn--outline', onclick: async () => {
          const blob = await summaryImage(w)
          if (!blob) return toast(t('player.error.title'))
          const file = new File([blob], `gharmonize-${year}.png`, { type: 'image/png' })
          if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: t('player.wrapped.brand', { year }) }); return } catch { /* fall back to download */ } }
          const a = h('a', { href: URL.createObjectURL(blob), download: file.name })
          document.body.append(a); a.click(); a.remove()
          setTimeout(() => URL.revokeObjectURL(a.href), 4000)
        } }, icon('download', { size: 18 }), t('player.wrapped.save'))))
    }
    stage.append(content)
    progress.querySelectorAll('span').forEach((bar, i) => {
      bar.classList.toggle('is-done', i < index)
      bar.classList.toggle('is-active', i === index)
      bar.style.setProperty('--dur', `${SLIDE_MS}ms`)
    })
    // Restart the CSS fill animation.
    const active = progress.children[index]
    active.classList.remove('is-active'); void active.offsetWidth; active.classList.add('is-active')
    tick()
  }
  const pause = (on) => {
    if (on === paused) return
    paused = on
    story.classList.toggle('is-paused', on)
    if (on) { clearTimeout(timer); elapsed += performance.now() - started } else tick()
  }
  stage.addEventListener('pointerdown', () => pause(true))
  window.addEventListener('pointerup', () => pause(false))
  const onKey = (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(index + 1) }
    else if (e.key === 'ArrowLeft') go(index - 1)
    else if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  function cleanup() {
    clearTimeout(timer)
    document.removeEventListener('keydown', onKey)
    story.remove()
  }
  document.body.append(story)
  go(0)
  root.append(emptyState('sparkles', t('player.wrapped.bannerTitle', { year }), '', { label: t('player.wrapped.replay'), run: () => app.nav(`/wrapped/${year}?r=${Date.now()}`) }))
  return { node: root, cleanup }
}

export async function render(name, params, query) {
  if (name === 'mix') return mixView(params[0])
  if (name === 'wrapped') return wrappedView(params[0])
  return statsView(query)
}
