// Application chrome: sidebar, top bar, player bar, side panel (queue /
// lyrics / track info), full-screen now playing, mobile nav and shortcuts.

import { app, bus, store } from './app.js'
import { get, post, artworkUrl } from './api.js'
import { h, append, t, icon, iconButton, setIcon, artwork, fmtTime, clear, contextMenu, toast, toastError, plural } from './dom.js'
import { itemArtwork } from './engine.js'
import { heartButton, createPlaylistFlow, trackMenu, trackInfo, markCurrent, providerName, primaryArtist, mixArt, mixTitle, mixDescription, averageColor, playCollection } from './components.js'
import { applyTheme, currentTheme } from './theme.js'
import { saveButton } from './playlistSave.js'

const QUALITY_OPTIONS = ['original', 'high', 'normal', 'low', 'saver']

// ---- shared bits ------------------------------------------------------------------

function slider({ cls = '', label, onInput, onCommit }) {
  const input = h('input', { type: 'range', class: `range ${cls}`.trim(), min: '0', max: '1000', step: '1', value: '0', 'aria-label': label })
  let dragging = false
  input.addEventListener('pointerdown', () => { dragging = true })
  input.addEventListener('input', () => { paintRange(input); onInput?.(Number(input.value) / 1000) })
  input.addEventListener('change', () => { dragging = false; onCommit?.(Number(input.value) / 1000) })
  input.addEventListener('pointerup', () => { setTimeout(() => { dragging = false }, 0) })
  return { el: input, set(fraction, buffered = null) { if (dragging) return; input.value = String(Math.round(Math.max(0, Math.min(1, fraction || 0)) * 1000)); paintRange(input, buffered) }, get dragging() { return dragging } }
}

function paintRange(input, buffered = null) {
  input.style.setProperty('--fill', `${Number(input.value) / 10}%`)
  if (buffered != null) input.style.setProperty('--buffered', `${Math.max(0, Math.min(100, buffered * 100))}%`)
}

export function codecName(codec, container = '') {
  const c = String(codec || '').toLowerCase()
  if (/mpeg.*layer\s*3|^mp3$/.test(c)) return 'MP3'
  if (/flac/.test(c)) return 'FLAC'
  if (/alac/.test(c)) return 'ALAC'
  if (/aac|mp4a/.test(c)) return 'AAC'
  if (/opus/.test(c)) return 'OPUS'
  if (/vorbis/.test(c)) return 'OGG'
  if (/pcm|wav/.test(c)) return 'WAV'
  return String(codec || container || '').toUpperCase().slice(0, 8)
}

function qualityLabel(item) {
  if (!item) return ''
  if (item.type === 'preview') return t('player.badge.preview')
  const q = app.prefs.quality
  if (q !== 'original') return t(`player.quality.short.${q}`)
  const name = codecName(item.codec) || (item.lossless ? 'FLAC' : '')
  if (item.lossless) return item.bitDepth && item.bitDepth > 16 ? `${name} ${item.bitDepth}/${Math.round((item.sampleRate || 44100) / 1000)}` : name
  return item.bitrate ? `${name} ${Math.round(item.bitrate / 1000)}` : name
}

// ---- lyrics -----------------------------------------------------------------------

const lyricsCache = new Map()

export class LyricsView {
  constructor({ big = false } = {}) {
    this.el = h('div', { class: ['lyrics', big && 'lyrics--big'] })
    this.item = null
    this.lines = []
    this.active = -1
    this.userScrollAt = 0
    this.el.addEventListener('wheel', () => { this.userScrollAt = Date.now() }, { passive: true })
    this.el.addEventListener('touchmove', () => { this.userScrollAt = Date.now() }, { passive: true })
    this.offs = [
      bus.on('player:track', (item) => this.isShown() && this.load(item)),
      bus.on('player:time', ({ position }) => this.sync(position))
    ]
  }

  isShown() { return this.el.isConnected && this.el.offsetParent !== null }

  async load(item = app.player.current) {
    if (item?.uid && this.item?.uid === item.uid) return
    this.item = item
    this.lines = []
    this.active = -1
    this.el.classList.remove('lyrics--plain')
    clear(this.el)
    if (!item) { this.el.append(h('p', { class: 'lyrics__empty', text: t('player.lyrics.nothingPlaying') })); return }
    if (item.type !== 'library') { this.el.append(h('p', { class: 'lyrics__empty', text: t('player.lyrics.previewNone') })); return }
    this.el.append(h('p', { class: 'lyrics__empty', text: t('player.common.loading') }))
    let data = lyricsCache.get(item.id)
    if (data === undefined) {
      try { data = await get(`/tracks/${item.id}/lyrics`) } catch { data = null }
      lyricsCache.set(item.id, data)
    }
    if (this.item !== item) return
    clear(this.el)
    if (!data || (!data.lines?.length && !data.plain)) {
      this.el.append(h('p', { class: 'lyrics__empty', text: t('player.lyrics.none') }))
      return
    }
    if (data.synced && data.lines?.length) {
      this.lines = data.lines
      data.lines.forEach((line, i) => {
        const p = h('p', { class: 'lyrics__line', dataset: { i: String(i) }, text: line.text || '♪' })
        p.addEventListener('click', () => { app.player.seek(line.timeMs / 1000); if (!app.player.playing) app.player.toggle() })
        this.el.append(p)
      })
      this.sync(app.player.position)
    } else {
      this.el.classList.add('lyrics--plain')
      for (const text of String(data.plain).split('\n')) this.el.append(h('p', { class: 'lyrics__line', text: text || ' ' }))
    }
    this.el.append(h('p', { class: 'lyrics__source', text: t('player.lyrics.source', { source: t(`player.lyrics.src.${data.source}`) }) }))
  }

  sync(position) {
    if (!this.lines.length) return
    const ms = position * 1000 + 250
    let idx = -1
    for (let i = 0; i < this.lines.length; i++) { if (this.lines[i].timeMs <= ms) idx = i; else break }
    if (idx === this.active) return
    this.el.querySelector('.lyrics__line.is-active')?.classList.remove('is-active')
    this.active = idx
    const el = this.el.querySelector(`.lyrics__line[data-i="${idx}"]`)
    if (!el) return
    el.classList.add('is-active')
    if (Date.now() - this.userScrollAt > 4000) {
      const top = el.offsetTop - this.el.clientHeight * 0.38
      this.el.scrollTo({ top, behavior: 'smooth' })
    }
  }
}

// ---- shell ------------------------------------------------------------------------

export function buildShell(root) {
  bus.offGroup('chrome')
  bus.currentGroup = 'chrome'
  document.getElementById('npFull')?.remove()
  clear(root)
  const sidebar = buildSidebar()
  const main = h('main', { class: 'main', id: 'main' }, buildTopbar(), h('div', { class: 'view', id: 'view', tabindex: '-1' }))
  const panel = buildPanel()
  const bar = buildPlayerBar()
  const mobileNav = buildMobileNav()
  root.append(sidebar, main, panel.el, bar, mobileNav)
  root.classList.toggle('panel-open', Boolean(panelTab()))
  buildFullPlayer()
  installShortcuts()
  bus.on('player:track', () => markCurrent())
  bus.on('player:state', ({ playing }) => document.body.classList.toggle('is-playing', playing))
  bus.currentGroup = null
}

// ---- sidebar ----------------------------------------------------------------------

function navLink(route, iconName, labelKey, extra = null) {
  return h('a', { class: 'nav-link', href: `#${route}`, title: t(labelKey), dataset: { route } }, icon(iconName, { size: 22 }), h('span', { class: 'nav-link__label', text: t(labelKey) }), extra)
}

function buildSidebar() {
  const dlBadge = h('span', { class: 'count-badge', hidden: true })
  bus.on('downloads:count', (n) => { dlBadge.hidden = !n; dlBadge.textContent = String(n) })
  const adminLink = navLink('/admin', 'shield', 'player.nav.admin')
  adminLink.hidden = !app.isAdmin()

  // Collapse to an icon rail (remembered); narrow windows always use the rail.
  const setCollapsed = (on) => {
    document.getElementById('app')?.classList.toggle('side-collapsed', on)
    app.setPref('sideCollapsed', on)
  }
  const collapseBtn = iconButton('chevL', t('player.side.collapse'), () => setCollapsed(!app.prefs.sideCollapsed), { cls: 'side-collapse', size: 18 })
  requestAnimationFrame(() => document.getElementById('app')?.classList.toggle('side-collapsed', Boolean(app.prefs.sideCollapsed)))

  // ---- "for you" mixes ----
  const forYou = h('div', { class: 'side-sect side-sect--foryou', hidden: true })
  const paintMixes = async () => {
    try {
      const { items } = await get('/mixes')
      clear(forYou)
      if (!items?.length) { forYou.hidden = true; return }
      forYou.hidden = false
      forYou.append(h('div', { class: 'side-section' },
        h('span', { class: 'side-section__title', text: t('player.side.forYou') }),
        h('a', { class: 'side-section__link', href: '#/stats', title: t('player.nav.stats') }, icon('chart', { size: 16 }))))
      for (const mix of items.slice(0, 4)) {
        forYou.append(h('a', { class: 'side-item side-item--mix', href: `#/mix/${encodeURIComponent(mix.id)}`, dataset: { route: `/mix/${mix.id}` }, title: mixTitle(mix) },
          mixArt(mix, { size: 96, label: false }),
          h('span', { class: 'side-item__text' },
            h('span', { class: 'side-item__title', text: mixTitle(mix) }),
            h('span', { class: 'side-item__sub', text: mixDescription(mix) }))))
      }
      highlightRoute()
    } catch { forYou.hidden = true }
  }

  paintMixes()
  bus.on('library:changed', paintMixes)
  return h('aside', { class: 'sidebar', id: 'sidebar' },
    h('div', { class: 'side-card side-card--all' },
      h('div', { class: 'brand-row' },
        h('a', { class: 'brand', href: '#/home' }, h('img', { src: '/src/logo.png', alt: '', class: 'brand__logo' }), h('span', { class: 'brand__text' }, h('b', { text: 'Gharmonize' }), h('span', { text: 'Player' }))), collapseBtn),
      h('nav', { class: 'nav' },
        navLink('/home', 'home', 'player.nav.home'),
        navLink('/search', 'search', 'player.nav.search'),
        navLink('/library', 'library', 'player.nav.library'),
        navLink('/liked', 'heart', 'player.nav.liked'),
        navLink('/history', 'history', 'player.nav.history'),
        navLink('/downloads', 'download', 'player.nav.downloads', dlBadge),
        navLink('/stats', 'chart', 'player.nav.stats'), adminLink),
      h('button', { type: 'button', class: 'side-create btn btn--outline', title: t('player.playlist.create'), onclick: () => createPlaylistFlow().then((pl) => pl && app.nav(`/playlist/${pl.id}`)) },
        icon('plus', { size: 20 }), h('span', { class: 'nav-link__label', text: t('player.playlist.create') }))),
    forYou)
}

export function highlightRoute() {
  const route = window.location.hash.replace(/^#/, '').split('?')[0] || '/home'
  document.querySelectorAll('[data-route]').forEach((el) => {
    const r = el.dataset.route
    el.classList.toggle('is-active', route === r || (r !== '/home' && route.startsWith(`${r}/`)))
  })
}

// ---- top bar -------------------------------------------------------------------------

function buildTopbar() {
  const search = h('input', { class: 'topbar__search-input', type: 'search', placeholder: t('player.search.placeholder'), 'aria-label': t('player.nav.search'), id: 'globalSearch', autocomplete: 'off', spellcheck: 'false' })
  let timer = null
  search.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const q = search.value.trim()
      const target = `/search${q ? `?q=${encodeURIComponent(q)}` : ''}`
      if (window.location.hash.startsWith('#/search')) history.replaceState(null, '', `#${target}`)
      else history.pushState(null, '', `#${target}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }, 220)
  })
  search.addEventListener('focus', () => { if (!window.location.hash.startsWith('#/search')) app.nav('/search') })
  bus.on('route', ({ path, query }) => {
    if (path !== '/search') search.value = ''
    else if (document.activeElement !== search) search.value = query.get('q') || ''
  })
  const themeBtn = iconButton(currentTheme() === 'dark' ? 'sun' : 'moon', t('player.theme.toggle'), () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    setIcon(themeBtn, next === 'dark' ? 'sun' : 'moon')
  }, { cls: 'topbar__btn' })
  bus.on('theme', (theme) => setIcon(themeBtn, theme === 'dark' ? 'sun' : 'moon'))
  const avatar = h('button', { type: 'button', class: 'avatar', title: app.user?.displayName || '', 'aria-label': t('player.nav.account') }, (app.user?.displayName || app.user?.username || '?').slice(0, 1).toUpperCase())
  avatar.addEventListener('click', (e) => {
    e.stopPropagation()
    contextMenu([
      { header: app.user?.displayName || app.user?.username },
      { label: t('player.nav.account'), icon: 'user', run: () => app.nav('/account') },
      app.isAdmin() && { label: t('player.nav.admin'), icon: 'shield', run: () => app.nav('/admin') },
      { label: t('player.nav.downloads'), icon: 'download', run: () => app.nav('/downloads') },
      { label: t('player.nav.stats'), icon: 'chart', run: () => app.nav('/stats') },
      'sep',
      { label: t('player.nav.gharmonize'), icon: 'external', run: () => { window.location.href = '/' } },
      { label: t('player.auth.logout'), icon: 'logout', danger: true, run: () => bus.emit('logout') }
    ], avatar)
  })
  return h('div', { class: 'topbar', id: 'topbar' },
    h('div', { class: 'topbar__nav' },
      iconButton('chevL', t('player.common.back'), () => history.back(), { cls: 'topbar__round' }),
      iconButton('chevR', t('player.common.forward'), () => history.forward(), { cls: 'topbar__round' })),
    h('label', { class: 'topbar__search' }, icon('search', { size: 20 }), search),
    h('div', { class: 'topbar__right' }, themeBtn, avatar))
}

// ---- player bar ------------------------------------------------------------------------

function buildPlayerBar() {
  const p = app.player
  const art = h('button', { type: 'button', class: 'pb-art', 'aria-label': t('player.np.open') })
  art.addEventListener('click', () => openFull())
  const title = h('a', { class: 'pb-title', href: '#' })
  const artist = h('a', { class: 'pb-artist', href: '#' })
  const heartSlot = h('span', { class: 'pb-heart' })
  const shuffle = iconButton('shuffle', t('player.controls.shuffle'), () => p.toggleShuffle(), { cls: 'ctl ctl--toggle', size: 18 })
  const prev = iconButton('prev', t('player.controls.previous'), () => p.prev(), { cls: 'ctl', size: 20 })
  const playBtn = iconButton('play', t('player.common.play'), () => p.toggle(), { cls: 'ctl-play', size: 20 })
  const next = iconButton('next', t('player.controls.next'), () => p.next(), { cls: 'ctl', size: 20 })
  const repeat = iconButton('repeat', t('player.controls.repeat'), () => p.cycleRepeat(), { cls: 'ctl ctl--toggle', size: 18 })
  const posLabel = h('span', { class: 'pb-time', text: '0:00' })
  const durLabel = h('span', { class: 'pb-time', text: '0:00' })
  const seek = slider({ cls: 'range--seek', label: t('player.controls.seek'), onInput: (f) => { posLabel.textContent = fmtTime(f * p.duration) }, onCommit: (f) => p.seek(f * p.duration) })
  const quality = h('button', { type: 'button', class: 'quality-chip', title: t('player.quality.title') })
  quality.addEventListener('click', (e) => { e.stopPropagation(); qualityMenu(quality) })
  const lyricsBtn = iconButton('lyrics', t('player.panel.lyrics'), () => togglePanel('lyrics'), { cls: 'ctl ctl--toggle', size: 18 })
  const queueBtn = iconButton('queue', t('player.panel.queue'), () => togglePanel('queue'), { cls: 'ctl ctl--toggle', size: 18 })
  const playlistsBtn = iconButton('playlist', t('player.panel.playlists'), () => togglePanel('playlists'), { cls: 'ctl ctl--toggle', size: 18 })
  const sleepBtn = iconButton('timer', t('player.sleep.title'), () => sleepMenu(sleepBtn), { cls: 'ctl ctl--toggle', size: 18 })
  const muteBtn = iconButton('volume', t('player.controls.mute'), () => p.toggleMute(), { cls: 'ctl', size: 18 })
  const volume = slider({ cls: 'range--volume', label: t('player.controls.volume'), onInput: (f) => p.setVolume(f), onCommit: (f) => p.setVolume(f) })
  const fullBtn = iconButton('expand', t('player.np.open'), () => openFull(), { cls: 'ctl', size: 18 })
  const miniProgress = h('div', { class: 'pb-mini-progress' }, h('span'))
  const mobilePlay = iconButton('play', t('player.common.play'), () => p.toggle(), { cls: 'pb-mobile-play', size: 24 })

  const bar = h('footer', { class: 'playerbar is-empty', id: 'playerbar' },
    miniProgress,
    h('div', { class: 'pb-left' }, art, h('div', { class: 'pb-meta' }, title, artist), heartSlot),
    h('div', { class: 'pb-center' },
      h('div', { class: 'pb-controls' }, shuffle, prev, playBtn, next, repeat),
      h('div', { class: 'pb-progress' }, posLabel, seek.el, durLabel)),
    h('div', { class: 'pb-right' }, quality, lyricsBtn, queueBtn, playlistsBtn, sleepBtn, h('div', { class: 'pb-volume' }, muteBtn, volume.el), fullBtn),
    mobilePlay)
  // On phones the whole mini player opens the full-screen player (the title
  // and artist links included); only its buttons keep their own action.
  bar.addEventListener('click', (e) => {
    if (!window.matchMedia('(max-width: 760px)').matches || e.target.closest('button, input')) return
    e.preventDefault()
    if (swiped) { swiped = false; return }
    openFull()
  })
  // Phones: swipe the mini player left / right for the next / previous song.
  let swipeStart = null
  let swiped = false
  bar.addEventListener('touchstart', (e) => { swipeStart = e.target.closest('input') ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY } }, { passive: true })
  bar.addEventListener('touchend', (e) => {
    if (!swipeStart) return
    const dx = e.changedTouches[0].clientX - swipeStart.x
    const dy = e.changedTouches[0].clientY - swipeStart.y
    swipeStart = null
    if (Math.abs(dx) > 60 && Math.abs(dy) < 50) {
      swiped = true
      setTimeout(() => { swiped = false }, 400)
      if (dx < 0) p.next(); else p.prev()
    }
  }, { passive: true })

  bus.on('player:track', (item) => {
    bar.classList.toggle('is-empty', !item)
    clear(art)
    clear(heartSlot)
    if (!item) { title.textContent = ''; artist.textContent = ''; return }
    art.append(artwork(itemArtwork(item, 128), { alt: '', seed: item.album || item.title, lazy: false }))
    title.textContent = item.title
    title.title = item.title
    title.href = item.albumId ? `#/album/${item.albumId}` : item.online?.providerIds?.deezerAlbum ? `#/online/album?provider=deezer&id=${item.online.providerIds.deezerAlbum}` : '#/home'
    artist.textContent = item.artist
    artist.href = item.artistId ? `#/artist/${item.artistId}` : `#/online/artist?name=${encodeURIComponent(primaryArtist(item.artist))}`
    if (item.type === 'library') heartSlot.append(heartButton('track', item.id, item.favorite, { size: 18 }))
    else heartSlot.append(h('span', { class: 'badge badge--preview', text: t('player.badge.preview') }))
    quality.textContent = qualityLabel(item)
    document.title = `${item.title} · ${item.artist} — Gharmonize Player`
  })
  bus.on('prefs', ({ key }) => { if (key === 'quality') quality.textContent = qualityLabel(p.current) })
  bus.on('player:state', ({ playing, loading }) => {
    for (const btn of [playBtn, mobilePlay]) {
      setIcon(btn, playing ? 'pause' : 'play', btn === mobilePlay ? 24 : 20)
      btn.title = playing ? t('player.common.pause') : t('player.common.play')
      btn.setAttribute('aria-label', btn.title)
      btn.classList.toggle('is-loading', Boolean(loading))
    }
  })
  bus.on('player:time', ({ position, duration, buffered }) => {
    if (!seek.dragging) posLabel.textContent = fmtTime(position)
    durLabel.textContent = fmtTime(duration)
    seek.set(duration ? position / duration : 0, duration ? buffered / duration : 0)
    miniProgress.firstChild.style.width = `${duration ? (position / duration) * 100 : 0}%`
  })
  bus.on('player:mode', ({ shuffle: s, repeat: r }) => {
    shuffle.classList.toggle('is-on', s)
    shuffle.setAttribute('aria-pressed', String(s))
    repeat.classList.toggle('is-on', r !== 'off')
    repeat.classList.toggle('is-one', r === 'one')
    repeat.title = t(`player.controls.repeat_${r}`)
  })
  bus.on('player:volume', ({ volume: v, muted }) => {
    volume.set(muted ? 0 : v)
    setIcon(muteBtn, muted || v === 0 ? 'mute' : v < 0.5 ? 'volumeLow' : 'volume', 18)
  })
  bus.on('player:sleep', (s) => sleepBtn.classList.toggle('is-on', Boolean(s.until || s.endOfTrack)))
  bus.on('panel', (tab) => {
    lyricsBtn.classList.toggle('is-on', tab === 'lyrics')
    queueBtn.classList.toggle('is-on', tab === 'queue')
    playlistsBtn.classList.toggle('is-on', tab === 'playlists')
  })
  return bar
}

function qualityMenu(anchor) {
  contextMenu([
    { header: t('player.quality.title') },
    ...QUALITY_OPTIONS.map((q) => ({
      label: t(`player.quality.${q}`),
      icon: app.prefs.quality === q ? 'check' : null,
      run: () => { app.setPref('quality', q); app.player.reloadCurrent() }
    })),
    'sep',
    { label: t('player.quality.normalize'), icon: app.prefs.normalize ? 'check' : null, run: () => { app.setPref('normalize', !app.prefs.normalize); app.player.applyVolume() } }
  ], anchor)
}

function sleepMenu(anchor) {
  const s = app.player.sleep
  const left = s.until ? Math.max(1, Math.round((s.until - Date.now()) / 60000)) : null
  contextMenu([
    { header: left ? t('player.sleep.remaining', { m: left }) : s.endOfTrack ? t('player.sleep.endOfTrackOn') : t('player.sleep.title') },
    ...[15, 30, 45, 60, 90].map((m) => ({ label: t('player.sleep.minutes', { m }), icon: 'timer', run: () => { app.player.setSleep(m); toast(t('player.sleep.set', { m })) } })),
    { label: t('player.sleep.endOfTrack'), icon: 'music', run: () => { app.player.setSleep('track'); toast(t('player.sleep.endOfTrackOn')) } },
    (s.until || s.endOfTrack) && 'sep',
    (s.until || s.endOfTrack) && { label: t('player.sleep.off'), icon: 'close', run: () => { app.player.setSleep(null); toast(t('player.sleep.offToast')) } }
  ], anchor)
}

// ---- queue & playlists lists (side panel and full-player sheet) ----------------------

function renderQueueInto(body) {
  const { queue, index } = app.player
  clear(body)
  const current = queue[index]
  if (!current) { body.append(h('p', { class: 'panel__empty', text: t('player.queue.empty') })); return }
  // "+" saves the whole queue (library songs) as / into a playlist.
  const saveQueue = saveButton(() => {
    const ids = queue.slice(index).filter((i) => i.type === 'library').map((i) => i.id)
    const day = new Date().toLocaleDateString(document.documentElement.lang || undefined, { day: 'numeric', month: 'long' })
    return { name: app.player.context?.label ? t('player.save.queueFrom', { name: app.player.context.label }) : t('player.save.queueName', { date: day }), trackIds: ids, count: new Set(ids).size }
  }, { cls: 'icon-btn', size: 18 })
  body.append(h('div', { class: 'panel__section-row' }, h('h3', { class: 'panel__section', text: t('player.queue.nowPlaying') }), saveQueue), queueRow(current, index, true))
  const upcoming = queue.slice(index + 1)
  const userItems = upcoming.filter((i) => !i.auto)
  const autoItems = upcoming.filter((i) => i.auto)
  if (userItems.length) {
    body.append(h('div', { class: 'panel__section-row' },
      h('h3', { class: 'panel__section', text: app.player.context?.label ? t('player.queue.nextFrom', { name: app.player.context.label }) : t('player.queue.next') }),
      h('button', { type: 'button', class: 'link-btn', text: t('player.queue.clear'), onclick: () => app.player.clearUpcoming() })))
    const list = h('div', { class: 'queue-list' })
    userItems.slice(0, 200).forEach((item) => list.append(queueRow(item, queue.indexOf(item))))
    body.append(list)
    if (userItems.length > 200) body.append(h('p', { class: 'muted small', text: t('player.queue.more', { n: userItems.length - 200 }) }))
  }
  if (autoItems.length) {
    body.append(h('h3', { class: 'panel__section', text: t('player.queue.autoplay') }))
    const list = h('div', { class: 'queue-list queue-list--auto' })
    autoItems.slice(0, 50).forEach((item) => list.append(queueRow(item, queue.indexOf(item))))
    body.append(list)
  }
  if (!upcoming.length) body.append(h('p', { class: 'panel__empty small', text: app.prefs.autoplay ? t('player.queue.autoplayHint') : t('player.queue.endHint') }))
}

let dragFrom = null
function queueRow(item, index, isCurrent = false) {
  const row = h('div', { class: ['q-row', isCurrent && 'is-current'], draggable: isCurrent ? null : 'true' },
    artwork(itemArtwork(item, 64), { alt: '', cls: 'q-art', seed: item.album || item.title }),
    h('div', { class: 'q-text' }, h('span', { class: 'q-title', text: item.title }), h('span', { class: 'q-artist', text: item.artist })),
    isCurrent ? h('span', { class: 'tl-eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')) : iconButton('close', t('player.queue.remove'), () => app.player.removeAt(index), { cls: 'q-remove', size: 16 }))
  if (!isCurrent) {
    row.addEventListener('dblclick', () => app.player.jumpTo(index))
    row.addEventListener('click', (e) => { if (!e.target.closest('button') && window.matchMedia('(pointer: coarse)').matches) app.player.jumpTo(index) })
    row.addEventListener('dragstart', (e) => { dragFrom = index; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(index)); row.classList.add('is-dragging') })
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'))
    row.addEventListener('dragover', (e) => { if (dragFrom !== null) { e.preventDefault(); row.classList.add('is-drop') } })
    row.addEventListener('dragleave', () => row.classList.remove('is-drop'))
    row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('is-drop'); if (dragFrom !== null) app.player.move(dragFrom, index); dragFrom = null })
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      contextMenu([
        { label: t('player.common.play'), icon: 'play', run: () => app.player.jumpTo(index) },
        { label: t('player.queue.remove'), icon: 'close', run: () => app.player.removeAt(index) },
        item.albumId && { label: t('player.menu.goToAlbum'), icon: 'album', run: () => app.nav(`/album/${item.albumId}`) },
        item.artistId && { label: t('player.menu.goToArtist'), icon: 'user', run: () => app.nav(`/artist/${item.artistId}`) }
      ], e)
    })
  }
  return row
}

// Your playlists (and the ones shared with you): open one, or play it directly.
function renderPlaylistsInto(body) {
  clear(body)
  const create = h('button', { type: 'button', class: 'btn btn--outline btn--sm pl-pick__create', onclick: () => createPlaylistFlow().then((pl) => pl && app.nav(`/playlist/${pl.id}`)) },
    icon('plus', { size: 16 }), h('span', { text: t('player.playlist.create') }))
  const liked = h('a', { class: 'q-row pl-pick', href: '#/liked' },
    h('span', { class: 'q-art pl-pick__liked' }, icon('heartFill', { size: 20 })),
    h('div', { class: 'q-text' }, h('span', { class: 'q-title', text: t('player.nav.liked') })))
  const list = h('div', { class: 'queue-list' }, liked)
  for (const pl of app.playlists || []) {
    const play = pl.trackCount ? iconButton('play', t('player.common.play'), (e) => { e.preventDefault(); playCollection('playlist', pl.id) }, { cls: 'pl-pick__play', size: 16 }) : null
    list.append(h('a', { class: 'q-row pl-pick', href: `#/playlist/${pl.id}` },
      artwork(pl.trackCount ? artworkUrl(pl.artwork, 128) : null, { alt: '', cls: 'q-art', placeholder: 'list', seed: pl.name }),
      h('div', { class: 'q-text' },
        h('span', { class: 'q-title', text: pl.name }),
        h('span', { class: 'q-artist', text: pl.editable ? plural(pl.trackCount, 'player.count.track', 'player.count.tracks') : t('player.playlist.by', { name: pl.owner?.displayName || '' }) })),
      play))
  }
  body.append(h('div', { class: 'panel__section-row' }, h('h3', { class: 'panel__section', text: t('player.panel.playlists') }), create), list)
}

// ---- side panel ----------------------------------------------------------------------------

let panelApi = null
// On narrow screens the panel is an overlay sheet: it is never restored on
// load and closes on navigation, so the remembered (desktop) choice is kept
// separately.
let transientPanel = null
const narrow = () => window.matchMedia('(max-width: 1100px)').matches
export const panelTab = () => (narrow() ? transientPanel : app.prefs.panel)
function setPanelTab(value) {
  if (narrow()) transientPanel = value
  else app.setPref('panel', value)
  document.getElementById('app')?.classList.toggle('panel-open', Boolean(value))
  bus.emit('panel', value)
}

export function togglePanel(tab) {
  const next = panelTab() === tab ? null : tab
  setPanelTab(next)
  if (next) panelApi.show(next)
}

window.addEventListener('hashchange', () => { if (narrow() && transientPanel) setPanelTab(null) })
window.matchMedia('(max-width: 1100px)').addEventListener?.('change', () => {
  transientPanel = null
  const tab = panelTab()
  document.getElementById('app')?.classList.toggle('panel-open', Boolean(tab))
  if (tab) panelApi?.show(tab)
  bus.emit('panel', tab)
})

function buildPanel() {
  const body = h('div', { class: 'panel__body' })
  const tabs = {}
  const tabBar = h('div', { class: 'panel__tabs', role: 'tablist' })
  for (const key of ['queue', 'playlists', 'lyrics', 'info']) {
    const btn = h('button', { type: 'button', class: 'panel__tab', role: 'tab', text: t(`player.panel.${key}`) })
    btn.addEventListener('click', () => { setPanelTab(key); show(key) })
    tabs[key] = btn
    tabBar.append(btn)
  }
  const el = h('aside', { class: 'panel', id: 'panel' },
    h('div', { class: 'panel__head' }, tabBar, iconButton('close', t('player.common.close'), () => setPanelTab(null))),
    body)
  const lyrics = new LyricsView()
  let tab = null

  function renderInfo() {
    clear(body)
    const item = app.player.current
    if (!item) { body.append(h('p', { class: 'panel__empty', text: t('player.queue.empty') })); return }
    append(body, [
      h('div', { class: 'np-card' },
        artwork(itemArtwork(item, 512), { alt: item.title, cls: 'np-card__art', seed: item.album || item.title }),
        h('h3', { class: 'np-card__title', text: item.title }),
        h('p', { class: 'np-card__artist' }, item.artistId ? h('a', { href: `#/artist/${item.artistId}`, text: item.artist }) : item.artist),
        item.album ? h('p', { class: 'np-card__album' }, item.albumId ? h('a', { href: `#/album/${item.albumId}`, text: item.album }) : item.album) : null),
      item.type === 'library'
        ? h('dl', { class: 'info-grid info-grid--compact' },
          item.codec ? [h('dt', { text: t('player.info.format') }), h('dd', { text: codecName(item.codec) })] : null,
          item.bitrate ? [h('dt', { text: t('player.info.bitrate') }), h('dd', { text: `${Math.round(item.bitrate / 1000)} kbps` })] : null,
          item.sampleRate ? [h('dt', { text: t('player.info.sampleRate') }), h('dd', { text: `${(item.sampleRate / 1000).toFixed(1)} kHz${item.bitDepth ? ` · ${item.bitDepth}-bit` : ''}` })] : null,
          [h('dt', { text: t('player.info.streaming') }), h('dd', { text: t(`player.quality.${app.prefs.quality}`) })],
          item.genre ? [h('dt', { text: t('player.info.genre') }), h('dd', { text: item.genre })] : null)
        : h('p', { class: 'muted small', text: t('player.np.previewInfo', { provider: providerName(item.online?.provider) }) }),
      item.type === 'library' ? h('div', { class: 'np-card__actions' },
        h('button', { type: 'button', class: 'btn btn--outline btn--sm', text: t('player.menu.info'), onclick: async () => { try { trackInfo(await get(`/tracks/${item.id}`)) } catch (error) { toastError(error) } } })) : null])
  }

  function show(key) {
    tab = key
    for (const [k, btn] of Object.entries(tabs)) btn.classList.toggle('is-active', k === key)
    tabs[key]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (key === 'queue') renderQueueInto(body)
    else if (key === 'playlists') renderPlaylistsInto(body)
    else if (key === 'info') renderInfo()
    else { clear(body); body.append(lyrics.el); lyrics.item = null; lyrics.load() }
  }

  bus.on('player:queue', () => { if (tab === 'queue' && panelTab()) renderQueueInto(body) })
  bus.on('playlists', () => { if (tab === 'playlists' && panelTab()) renderPlaylistsInto(body) })
  bus.on('player:track', () => { if (tab === 'info' && panelTab()) renderInfo() })
  panelApi = { show }
  if (panelTab()) setTimeout(() => { show(panelTab()); bus.emit('panel', panelTab()) }, 0)
  return { el, show }
}

// ---- full-screen now playing -------------------------------------------------------------

let fullApi = null

export function openFull() {
  if (!app.player.current) return
  fullApi?.open()
}

function buildFullPlayer() {
  const p = app.player
  const artBox = h('div', { class: 'np-full__art' })
  const title = h('h2', { class: 'np-full__title' })
  const artist = h('a', { class: 'np-full__artist', href: '#' })
  const heartSlot = h('span')
  const lyrics = new LyricsView({ big: true })
  const stage = h('div', { class: 'np-full__stage' }, artBox)
  const pos = h('span', { class: 'pb-time' })
  const dur = h('span', { class: 'pb-time' })
  const seek = slider({ cls: 'range--seek range--big', label: t('player.controls.seek'), onInput: (f) => { pos.textContent = fmtTime(f * p.duration) }, onCommit: (f) => p.seek(f * p.duration) })
  const shuffle = iconButton('shuffle', t('player.controls.shuffle'), () => p.toggleShuffle(), { cls: 'ctl ctl--toggle', size: 22 })
  const repeat = iconButton('repeat', t('player.controls.repeat'), () => p.cycleRepeat(), { cls: 'ctl ctl--toggle', size: 22 })
  const playBtn = iconButton('play', t('player.common.play'), () => p.toggle(), { cls: 'ctl-play ctl-play--xl', size: 30 })
  let mode = 'art'
  const lyricsToggle = h('button', { type: 'button', class: 'np-full__tab', text: t('player.panel.lyrics'), onclick: () => setMode(mode === 'lyrics' ? 'art' : 'lyrics') })
  const lyricsTop = h('button', { type: 'button', class: 'np-full__tab np-full__tab--top', text: t('player.panel.lyrics'), onclick: () => setMode('art') })
  const queueBtn = iconButton('queue', t('player.panel.queue'), () => toggleSheet('queue'), { cls: 'ctl', size: 22 })
  const playlistBtn = iconButton('playlist', t('player.panel.playlists'), () => toggleSheet('playlists'), { cls: 'ctl', size: 22 })
  // Queue / playlists sheet: slides up over the player (swipe or scroll up).
  const sheetBody = h('div', { class: 'np-sheet__body' })
  const sheetTabs = {}
  const sheetTabBar = h('div', { class: 'panel__tabs', role: 'tablist' })
  for (const key of ['queue', 'playlists']) {
    const btn = h('button', { type: 'button', class: 'panel__tab', role: 'tab', text: t(`player.panel.${key}`) })
    btn.addEventListener('click', () => openSheet(key))
    sheetTabs[key] = btn
    sheetTabBar.append(btn)
  }
  const sheet = h('div', { class: 'np-sheet', 'aria-hidden': 'true', inert: true },
    h('div', { class: 'np-sheet__grip', 'aria-hidden': 'true' }),
    h('div', { class: 'np-sheet__head' }, sheetTabBar, iconButton('close', t('player.common.close'), () => closeSheet(), { cls: 'ctl', size: 20 })),
    sheetBody)
  const hint = h('button', { type: 'button', class: 'np-full__hint', onclick: () => openSheet('queue') }, icon('chevU', { size: 16 }), h('span', { text: t('player.np.sheetHint') }))
  const root = h('div', { class: 'np-full', id: 'npFull', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': t('player.np.title') },
    h('div', { class: 'np-full__inner' },
      h('div', { class: 'np-full__top' },
        iconButton('chevD', t('player.common.close'), () => close(), { cls: 'ctl ctl--round', size: 24 }),
        h('div', { class: 'np-full__heading' }, h('b', { text: t('player.np.title') }), h('span', { class: 'np-full__context' })),
        iconButton('more', t('player.common.more'), (e) => {
          const item = p.current
          if (item?.type === 'library') get(`/tracks/${item.id}`).then((tr) => trackMenu(tr, e.currentTarget || e)).catch(toastError)
        }, { cls: 'ctl ctl--round', size: 22 })),
      lyricsTop,
      stage,
      h('div', { class: 'np-full__meta' }, h('div', { class: 'np-full__side' }, queueBtn, playlistBtn), h('div', { class: 'np-full__titles' }, title, artist), heartSlot),
      h('div', { class: 'np-full__progress' }, pos, seek.el, dur),
      h('div', { class: 'np-full__controls' },
        iconButton('prev', t('player.controls.previous'), () => p.prev(), { cls: 'ctl ctl--round ctl--md', size: 24 }),
        playBtn,
        iconButton('next', t('player.controls.next'), () => p.next(), { cls: 'ctl ctl--round ctl--md', size: 24 })),
      hint,
      h('div', { class: 'np-full__extra' }, shuffle, lyricsToggle, repeat),
      sheet))
  document.body.append(root)

  let sheetTab = null
  function paintSheet() {
    if (sheetTab === 'queue') renderQueueInto(sheetBody)
    else if (sheetTab === 'playlists') renderPlaylistsInto(sheetBody)
  }
  function openSheet(key) {
    sheetTab = key
    for (const [k, btn] of Object.entries(sheetTabs)) btn.classList.toggle('is-active', k === key)
    paintSheet()
    root.classList.add('is-sheet')
    sheet.inert = false
    sheet.setAttribute('aria-hidden', 'false')
  }
  function closeSheet() {
    if (!sheetTab) return
    sheetTab = null
    root.classList.remove('is-sheet')
    sheet.inert = true
    sheet.setAttribute('aria-hidden', 'true')
  }
  function toggleSheet(key) { if (sheetTab === key) closeSheet(); else openSheet(key) }
  bus.on('player:queue', () => { if (sheetTab === 'queue' && !root.hidden) paintSheet() })
  bus.on('playlists', () => { if (sheetTab === 'playlists' && !root.hidden) paintSheet() })

  function setMode(next) {
    mode = next
    root.classList.toggle('is-lyrics', mode === 'lyrics')
    lyricsToggle.setAttribute('aria-pressed', String(mode === 'lyrics'))
    clear(stage)
    if (mode === 'lyrics') { stage.append(lyrics.el); lyrics.item = null; lyrics.load() } else stage.append(artBox)
  }

  function paint(item) {
    if (!item) { close(); return }
    clear(artBox)
    artBox.append(artwork(itemArtwork(item, 1024), { alt: item.title, seed: item.album || item.title, lazy: false }))
    title.textContent = item.title
    artist.textContent = item.artist
    artist.href = item.artistId ? `#/artist/${item.artistId}` : `#/online/artist?name=${encodeURIComponent(primaryArtist(item.artist))}`
    root.querySelector('.np-full__context').textContent = p.context?.label || ''
    clear(heartSlot)
    if (item.type === 'library') heartSlot.append(heartButton('track', item.id, item.favorite, { size: 26 }))
    if (mode === 'lyrics') lyrics.load(item)
  }

  let returnFocus = null
  function open() {
    returnFocus = document.activeElement
    root.hidden = false
    document.body.classList.add('np-open')
    paint(p.current)
    setIcon(playBtn, p.playing ? 'pause' : 'play', 30)
    shuffle.classList.toggle('is-on', p.shuffle)
    repeat.classList.toggle('is-on', p.repeat !== 'off')
    pos.textContent = fmtTime(p.position)
    dur.textContent = fmtTime(p.duration)
    seek.set(p.duration ? p.position / p.duration : 0)
    root.querySelector('button')?.focus()
    requestAnimationFrame(() => root.classList.add('is-open'))
  }
  function close() {
    closeSheet()
    root.classList.remove('is-open')
    document.body.classList.remove('np-open')
    returnFocus?.focus()
    setTimeout(() => { if (!root.classList.contains('is-open')) root.hidden = true }, 250)
  }
  artist.addEventListener('click', () => close())
  // Escape also works when focus is outside the player (e.g. after a drag).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || root.hidden || root.contains(document.activeElement)) return
    if (sheetTab) closeSheet(); else close()
  })
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); if (sheetTab) closeSheet(); else close() }
    if (e.key !== 'Tab') return
    const buttons = [...root.querySelectorAll('button, a[href], input')].filter((el) => el.offsetParent !== null)
    const first = buttons[0], last = buttons.at(-1)
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
  })
  // Touch: swipe up opens the queue sheet, swipe down closes it (or the
  // player), swipe left / right changes the song.
  let start = null
  root.addEventListener('touchstart', (e) => {
    const inSheet = Boolean(e.target.closest('.np-sheet'))
    start = !inSheet && e.target.closest('.lyrics, input') ? null : { x: e.touches[0].clientX, y: e.touches[0].clientY, inSheet, atTop: sheetBody.scrollTop <= 0 }
  }, { passive: true })
  root.addEventListener('touchend', (e) => {
    if (!start) return
    const dx = e.changedTouches[0].clientX - start.x
    const dy = e.changedTouches[0].clientY - start.y
    const { inSheet, atTop } = start
    start = null
    if (inSheet) { if (dy > 90 && Math.abs(dx) < 80 && atTop) closeSheet(); return }
    if (dy < -90 && Math.abs(dx) < 80) return openSheet('queue')
    if (dy > 110 && Math.abs(dx) < 80) return close()
    if (Math.abs(dx) > 70 && Math.abs(dy) < 70) swipeTo(dx < 0 ? 'next' : 'prev')
  }, { passive: true })
  // Mouse: drag up or scroll the wheel down to open the sheet; scrolling up
  // at the top of the sheet closes it again.
  let drag = null
  root.addEventListener('pointerdown', (e) => {
    drag = e.pointerType === 'mouse' && e.button === 0 && !e.target.closest('button, a, input, .np-sheet, .lyrics') ? e.clientY : null
  })
  root.addEventListener('pointerup', (e) => {
    if (drag !== null && e.clientY - drag < -80) openSheet('queue')
    drag = null
  })
  let wheel = 0
  let wheelTimer = null
  root.addEventListener('wheel', (e) => {
    const inSheet = Boolean(e.target.closest('.np-sheet'))
    if (!inSheet && e.target.closest('.lyrics')) return
    if (inSheet && (e.deltaY > 0 || sheetBody.scrollTop > 0)) { wheel = 0; return }
    wheel += e.deltaY
    clearTimeout(wheelTimer)
    wheelTimer = setTimeout(() => { wheel = 0 }, 250)
    if (!sheetTab && wheel > 60) { wheel = 0; openSheet('queue') }
    else if (inSheet && wheel < -60) { wheel = 0; closeSheet() }
  }, { passive: true })
  function swipeTo(dir) {
    artBox.classList.remove('swipe-next', 'swipe-prev')
    void artBox.offsetWidth
    artBox.classList.add(dir === 'next' ? 'swipe-next' : 'swipe-prev')
    if (dir === 'next') p.next(); else p.prev()
  }
  window.addEventListener('hashchange', () => { if (root.isConnected && !root.hidden) close() })

  bus.on('player:track', (item) => { if (!root.hidden) paint(item) })
  bus.on('player:state', ({ playing, loading }) => {
    setIcon(playBtn, playing ? 'pause' : 'play', 30)
    playBtn.classList.toggle('is-loading', Boolean(loading))
  })
  bus.on('player:time', ({ position, duration, buffered }) => {
    if (root.hidden) return
    if (!seek.dragging) pos.textContent = fmtTime(position)
    dur.textContent = fmtTime(duration)
    seek.set(duration ? position / duration : 0, duration ? buffered / duration : 0)
  })
  bus.on('player:mode', ({ shuffle: s, repeat: r }) => {
    shuffle.classList.toggle('is-on', s)
    repeat.classList.toggle('is-on', r !== 'off')
    repeat.classList.toggle('is-one', r === 'one')
  })
  fullApi = { open, close }
}

// ---- mobile nav --------------------------------------------------------------------------------

function buildMobileNav() {
  return h('nav', { class: 'mobile-nav', id: 'mobileNav' },
    navLink('/home', 'home', 'player.nav.home'),
    navLink('/search', 'search', 'player.nav.search'),
    navLink('/library', 'library', 'player.nav.library'),
    navLink('/downloads', 'download', 'player.nav.downloads'),
    navLink('/account', 'user', 'player.nav.account'))
}

// ---- keyboard shortcuts ------------------------------------------------------------------------

let shortcutsInstalled = false
function installShortcuts() {
  if (shortcutsInstalled) return
  shortcutsInstalled = true
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey) return
    const target = e.target
    const typing = target.closest?.('input, textarea, select, [contenteditable="true"]')
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
      e.preventDefault()
      document.getElementById('globalSearch')?.focus()
      return
    }
    if (typing || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]')) return
    const p = app.player
    switch (e.key) {
      case ' ': if (!target.closest('button, a')) { e.preventDefault(); p.toggle() } break
      case 'ArrowRight': e.preventDefault(); e.shiftKey ? p.next() : p.seek(p.position + 5); break
      case 'ArrowLeft': e.preventDefault(); e.shiftKey ? p.prev() : p.seek(p.position - 5); break
      case 'ArrowUp': if (e.shiftKey) { e.preventDefault(); p.setVolume(p.volume + 0.05) } break
      case 'ArrowDown': if (e.shiftKey) { e.preventDefault(); p.setVolume(p.volume - 0.05) } break
      case 'm': case 'M': p.toggleMute(); break
      case 's': case 'S': p.toggleShuffle(); break
      case 'r': case 'R': p.cycleRepeat(); break
      case 'q': case 'Q': togglePanel('queue'); break
      case 'l': case 'L': togglePanel('lyrics'); break
      case 'f': case 'F': openFull(); break
      case '?': showShortcuts(); break
      default: break
    }
  })
}

export function showShortcuts() {
  import('./dom.js').then(({ modal }) => modal({
    title: t('player.shortcuts.title'),
    build: () => h('dl', { class: 'info-grid shortcuts' }, [
      ['Space', 'playPause'], ['← / →', 'seek'], ['Shift + ← / →', 'prevNext'], ['Shift + ↑ / ↓', 'volume'],
      ['M', 'mute'], ['S', 'shuffle'], ['R', 'repeat'], ['Q', 'queue'], ['L', 'lyrics'], ['F', 'fullscreen'], ['/  ·  Ctrl+K', 'search']
    ].map(([k, key]) => [h('dt', {}, h('kbd', { text: k })), h('dd', { text: t(`player.shortcuts.${key}`) })]))
  }))
}

export { QUALITY_OPTIONS, post }
