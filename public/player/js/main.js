// Gharmonize Player web client entry: status gate, sign-in / first setup,
// shell construction and hash routing.

import { app, bus } from './app.js'
import { api, get, post, setUnauthorizedHandler, ApiError } from './api.js'
import { h, t, clear, icon, spinner, errorText, emptyState } from './dom.js'
import { Engine } from './engine.js'
import { DownloadTracker } from './downloads.js'
import { buildShell, highlightRoute } from './chrome.js'
import { refreshPlaylists, setTint } from './components.js'
import { pairCodeFromHash, deviceLabel } from './pairing.js'

const ROUTES = [
  [/^\/home$/, () => import('./views/home.js'), 'home'],
  [/^\/search$/, () => import('./views/search.js'), 'search'],
  [/^\/library(?:\/(\w+))?$/, () => import('./views/library.js'), 'library'],
  [/^\/liked$/, () => import('./views/library.js'), 'liked'],
  [/^\/history$/, () => import('./views/library.js'), 'history'],
  [/^\/genre\/(.+)$/, () => import('./views/library.js'), 'genre'],
  [/^\/album\/(\d+)$/, () => import('./views/detail.js'), 'album'],
  [/^\/artist\/(\d+)$/, () => import('./views/detail.js'), 'artist'],
  [/^\/playlist\/(\d+)$/, () => import('./views/detail.js'), 'playlist'],
  [/^\/online\/album$/, () => import('./views/online.js'), 'album'],
  [/^\/online\/playlist$/, () => import('./views/online.js'), 'playlist'],
  [/^\/online\/artist$/, () => import('./views/online.js'), 'artist'],
  [/^\/mood\/([\w-]+)$/, () => import('./views/online.js'), 'mood'],
  [/^\/mix\/([\w-]+)$/, () => import('./views/insights.js'), 'mix'],
  [/^\/stats$/, () => import('./views/insights.js'), 'stats'],
  [/^\/wrapped(?:\/(\d{4}))?$/, () => import('./views/insights.js'), 'wrapped'],
  [/^\/downloads$/, () => import('./views/downloadsView.js'), 'downloads'],
  [/^\/account$/, () => import('./views/account.js'), 'account'],
  [/^\/admin(?:\/(\w+))?$/, () => import('./views/admin.js'), 'admin']
]

const scrollMemory = new Map()
let renderSeq = 0
let currentCleanup = null
let lastHash = null

// Views that return { keepAlive: true } (the home page) stay in memory: going
// back shows them instantly with their images, and they refresh quietly.
const KEEP_ALIVE_MS = 15 * 60 * 1000
const kept = new Map()
const dropKept = () => { for (const k of kept.values()) { try { k.result.cleanup?.() } catch {} } kept.clear() }
let libraryRefreshTimer = null
bus.on('library:changed', () => {
  for (const k of kept.values()) k.stale = true
  clearTimeout(libraryRefreshTimer)
  libraryRefreshTimer = setTimeout(() => {
    if (app.user && /^#\/online\/(?:playlist|album)/.test(window.location.hash)) route()
  }, 300)
})
bus.on('i18n', dropKept)
export function forgetKeptViews() { dropKept() }

async function route() {
  const hash = window.location.hash.replace(/^#/, '') || '/home'
  const [path, qs = ''] = hash.split('?')
  const query = new URLSearchParams(qs)
  const view = document.getElementById('view')
  const main = document.getElementById('main')
  if (!view || !main) return
  if (lastHash) scrollMemory.set(lastHash, main.scrollTop)
  const sameRoute = lastHash && lastHash.split('?')[0] === path && path === '/search'
  lastHash = hash
  highlightRoute()
  bus.emit('route', { path, query })
  if (sameRoute) { bus.emit('route:query', { path, query }); return }

  const match = ROUTES.find(([re]) => re.test(path))
  const seq = ++renderSeq
  try { currentCleanup?.() } catch {}
  currentCleanup = null
  main.classList.remove('has-hero')
  setTint(null, path)
  if (!match) { app.nav('/home'); return }
  const [re, loader, name] = match
  const params = path.match(re).slice(1).map((p) => (p ? decodeURIComponent(p) : p))
  const keep = kept.get(path)
  if (keep && Date.now() - keep.at < KEEP_ALIVE_MS) {
    clear(view)
    view.append(keep.node)
    currentCleanup = () => keep.result.onHide?.()
    if (keep.result.hero) main.classList.add('has-hero')
    main.scrollTop = scrollMemory.get(hash) || 0
    try { keep.result.onShow?.({ stale: keep.stale }) } catch {}
    keep.stale = false
    return
  }
  if (keep) { kept.delete(path); try { keep.result.cleanup?.() } catch {} }
  const loadingTimer = setTimeout(() => { if (seq === renderSeq) { clear(view); view.append(h('div', { class: 'view-loading' }, spinner(36))) } }, 180)
  try {
    const mod = await loader()
    const result = await mod.render(name, params, query)
    if (seq !== renderSeq) { result?.cleanup?.(); return }
    clearTimeout(loadingTimer)
    clear(view)
    const node = result?.node || result
    view.append(node)
    if (result?.keepAlive) {
      kept.set(path, { node, result, at: Date.now(), stale: false })
      currentCleanup = () => result.onHide?.()
    } else currentCleanup = result?.cleanup || null
    if (result?.hero) main.classList.add('has-hero')
    main.scrollTop = scrollMemory.get(hash) || 0
  } catch (error) {
    clearTimeout(loadingTimer)
    if (seq !== renderSeq) return
    clear(view)
    if (error?.status === 401) return
    view.append(emptyState(error?.status === 404 ? 'search' : 'info', error?.status === 404 ? t('player.error.notFoundTitle') : t('player.error.title'), errorText(error), { label: t('player.common.retry'), run: () => route() }))
  }
}

// ---- gate screens ------------------------------------------------------------------

function gateFrame(...children) {
  const gate = document.getElementById('gate')
  clear(gate)
  gate.append(h('div', { class: 'gate__card' },
    h('div', { class: 'gate__brand' }, h('img', { src: '/src/logo.png', alt: '', class: 'gate__logo' }), h('div', {}, h('b', { text: 'Gharmonize' }), h('span', { text: 'Player' }))),
    ...children))
  gate.hidden = false
  document.getElementById('app').hidden = true
  document.getElementById('boot').hidden = true
}

function infoGate(iconName, title, text, linkLabel = null) {
  gateFrame(
    h('div', { class: 'gate__icon' }, icon(iconName, { size: 36 })),
    h('h1', { class: 'gate__title', text: title }),
    h('p', { class: 'gate__text', text }),
    linkLabel ? h('a', { class: 'btn btn--primary btn--block', href: '/', text: linkLabel }) : null,
    h('button', { type: 'button', class: 'btn btn--ghost btn--block', text: t('player.common.retry'), onclick: () => start() }))
}

function field(label, input) {
  return h('label', { class: 'field' }, h('span', { class: 'field__label', text: label }), input)
}

function loginGate(status, notice = null) {
  const username = h('input', { class: 'input', type: 'text', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: 'false' })
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true })
  const error = h('p', { class: 'form-error', hidden: true })
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block', text: t('player.auth.login') })
  const form = h('form', { class: 'stack' }, field(t('player.auth.username'), username), field(t('player.auth.password'), password), error, submit)
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    submit.disabled = true
    error.hidden = true
    try {
      await post('/auth/login', { username: username.value.trim(), password: password.value, deviceName: deviceLabel() })
      await start()
    } catch (err) {
      error.textContent = errorText(err)
      error.hidden = false
      submit.disabled = false
      password.select()
    }
  })
  gateFrame(
    h('h1', { class: 'gate__title', text: t('player.auth.welcome') }),
    h('p', { class: 'gate__text', text: t('player.auth.loginHint', { name: status?.name || 'Gharmonize Player' }) }),
    notice ? h('p', { class: 'note', text: `${t('player.pair.failed')} ${notice}` }) : null,
    form,
    h('p', { class: 'gate__foot' }, h('a', { href: '/', text: t('player.nav.gharmonize') })))
  setTimeout(() => username.focus(), 50)
}

function setupGate(status) {
  const username = h('input', { class: 'input', type: 'text', autocomplete: 'username', required: true, minlength: 2, autocapitalize: 'none', spellcheck: 'false' })
  const displayName = h('input', { class: 'input', type: 'text', autocomplete: 'name' })
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 })
  const adminPassword = h('input', { class: 'input', type: 'password', autocomplete: 'off' })
  const error = h('p', { class: 'form-error', hidden: true })
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block', text: t('player.setup.submit') })
  const form = h('form', { class: 'stack' },
    field(t('player.auth.username'), username),
    field(t('player.setup.displayName'), displayName),
    field(t('player.setup.password'), password),
    status.gharmonizeAdmin ? null : field(t('player.setup.adminPassword'), adminPassword),
    status.gharmonizeAdmin ? h('p', { class: 'note note--ok' }, icon('checkCircle', { size: 16 }), t('player.setup.adminSession')) : h('p', { class: 'note', text: t('player.setup.adminHint') }),
    error, submit)
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    submit.disabled = true
    error.hidden = true
    try {
      await post('/setup', { username: username.value.trim(), displayName: displayName.value.trim() || undefined, password: password.value, adminPassword: adminPassword.value || undefined, deviceName: deviceLabel() })
      await start()
    } catch (err) {
      error.textContent = errorText(err)
      error.hidden = false
      submit.disabled = false
    }
  })
  gateFrame(
    h('h1', { class: 'gate__title', text: t('player.setup.title') }),
    h('p', { class: 'gate__text', text: t('player.setup.text') }),
    form)
  setTimeout(() => username.focus(), 50)
}

// ---- startup ---------------------------------------------------------------------------

async function loadSession() {
  const [me, providers] = await Promise.all([
    get('/me'),
    get('/online/providers').catch(() => ({ providers: [], canDownload: false })),
    refreshPlaylists()
  ])
  app.me = me
  app.user = me.user
  app.canDownload = Boolean(me.permissions?.canDownload)
  app.providers = (providers.providers || []).filter((p) => p.enabled !== false && p.available !== false).map((p) => p.name || p.id || p)
}

// Rights can change while the app is open (an admin grants downloads):
// re-read them now and then and when the window comes back, and redraw.
let permsCheckedAt = 0
async function refreshPermissions() {
  if (!app.user || Date.now() - permsCheckedAt < 30_000) return
  permsCheckedAt = Date.now()
  try {
    const me = await get('/me')
    const can = Boolean(me.permissions?.canDownload)
    const roleChanged = me.user?.role !== app.user?.role
    app.me = me
    app.user = me.user
    if (can !== app.canDownload || roleChanged) {
      app.canDownload = can
      forgetKeptViews()
      bus.emit('permissions', { canDownload: can })
      if (roleChanged) buildShell(document.getElementById('app'))
      lastHash = null
      route()
    }
  } catch {}
}
window.addEventListener('focus', refreshPermissions)
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPermissions() })
setInterval(refreshPermissions, 2 * 60_000)

async function start() {
  let status
  try {
    status = await api('/status')
  } catch (error) {
    if (error instanceof ApiError && error.code === 'PLAYER_REMOTE_ACCESS_DISABLED') return infoGate('lock', t('player.gate.remoteTitle'), t('player.gate.remoteText'))
    if (error instanceof ApiError && error.code === 'PLAYER_DISABLED') return infoGate('info', t('player.gate.disabledTitle'), t('player.gate.disabledText'), t('player.nav.gharmonize'))
    return infoGate('info', t('player.error.title'), errorText(error))
  }
  app.status = status
  if (!status.enabled) return infoGate('info', t('player.gate.disabledTitle'), t('player.gate.disabledText'), t('player.nav.gharmonize'))
  if (status.setupRequired) return setupGate(status)
  // Opened from a pairing QR code: sign this browser in with the code.
  const pairCode = pairCodeFromHash()
  let pairingError = null
  if (pairCode) {
    history.replaceState(null, '', '#/home')
    if (!status.user) {
      try {
        await post('/pair', { code: pairCode, client: 'web', deviceName: deviceLabel() })
        // Only the server's refreshed session status can admit this browser.
        status = await api('/status')
      } catch (error) {
        pairingError = errorText(error)
      }
    }
  }
  app.status = status
  if (!status.user) return loginGate(status, pairingError)
  try {
    await loadSession()
  } catch (error) {
    if (error?.status === 401) return loginGate(status)
    return infoGate('info', t('player.error.title'), errorText(error))
  }
  showApp()
}

function showApp() {
  const root = document.getElementById('app')
  if (!app.player) app.player = new Engine()
  if (!app.downloads) app.downloads = new DownloadTracker()
  buildShell(root)
  document.getElementById('gate').hidden = true
  document.getElementById('boot').hidden = true
  root.hidden = false
  if (app.player.userId !== app.user.id) app.player.restore(app.user.id)
  else app.player.emitAll()
  app.downloads.start()
  lastHash = null
  route()
}

async function logout() {
  dropKept()
  try { await post('/auth/logout') } catch {}
  app.player?.reset()
  app.downloads?.stop()
  app.user = null
  app.me = null
  document.title = 'Gharmonize Player'
  start()
}

setUnauthorizedHandler(() => {
  if (!app.user) return
  dropKept()
  app.user = null
  app.downloads?.stop()
  app.player?.pause()
  start()
})

bus.on('logout', logout)
window.addEventListener('hashchange', route)
document.addEventListener('i18n:applied', () => {
  bus.emit('i18n')
  if (app.user && !document.getElementById('app').hidden) {
    buildShell(document.getElementById('app'))
    app.player.emitAll()
    app.downloads.emitCount()
    lastHash = null
    route()
  }
})
bus.on('library:changed', () => refreshPlaylists())

async function boot() {
  try { await window.i18nInit?.() } catch {}
  document.documentElement.removeAttribute('data-i18n-pending')
  await start()
}

boot()
