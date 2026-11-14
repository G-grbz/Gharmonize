// Administration: server settings, download bridge, libraries, users with
// library grants and download rights, devices and caches.

import { app } from '../app.js'
import { get, post, patch, del } from '../api.js'
import { h, t, icon, iconButton, clear, toggle, toast, toastError, modal, confirmDialog, promptDialog, fmtBytes, fmtRelative, fmtNumber, emptyState, errorText } from '../dom.js'
import { refreshPlaylists } from '../components.js'

const TABS = ['server', 'remote', 'libraries', 'users', 'downloads']
const DOWNLOAD_FORMATS = {
  mp3: ['auto', '128k', '192k', '256k', '320k'],
  flac: ['lossless'],
  ogg: ['auto', '128k', '192k', '256k', '320k'],
  aac: ['128k', '192k', '256k', '320k']
}
const SCAN_INTERVALS = [0, 15, 30, 60, 180, 360, 720, 1440]
const PROVIDERS = ['deezer', 'youtube', 'spotify']

function card(title, hint, ...children) {
  return h('section', { class: 'panel-card' }, h('h2', { class: 'panel-card__title', text: title }), hint ? h('p', { class: 'muted', text: hint }) : null, ...children)
}

function settingRow(label, hint, control) {
  return h('div', { class: 'setting' }, h('div', { class: 'setting__text' }, h('b', { text: label }), hint ? h('span', { class: 'muted small', text: hint }) : null), control)
}

async function saveConfig(patchBody) {
  try {
    const res = await patch('/admin/config', patchBody)
    toast(t('player.admin.saved'), { type: 'success', timeout: 1600 })
    return res.config
  } catch (error) { toastError(error); return null }
}

// ---- server ------------------------------------------------------------------------

async function serverTab() {
  const [{ config, remoteAccess }, cache, status] = await Promise.all([get('/admin/config'), get('/admin/cache'), get('/status')])
  const box = h('div', { class: 'stack-lg' })
  const name = h('input', { class: 'input', type: 'text', value: config.serverName, maxlength: 64 })
  name.addEventListener('change', () => saveConfig({ serverName: name.value }))
  const scan = h('select', { class: 'select' }, SCAN_INTERVALS.map((m) => h('option', { value: String(m), selected: config.scanIntervalMinutes === m, text: m ? t('player.admin.everyMinutes', { m: m >= 60 ? `${m / 60}h` : `${m}m` }) : t('player.admin.manualOnly') })))
  if (!SCAN_INTERVALS.includes(config.scanIntervalMinutes)) scan.append(h('option', { value: String(config.scanIntervalMinutes), selected: true, text: `${config.scanIntervalMinutes} min` }))
  scan.addEventListener('change', () => saveConfig({ scanIntervalMinutes: Number(scan.value) }))

  const cacheMb = h('input', { class: 'input input--num', type: 'number', min: '0', max: '524288', step: '256', value: String(config.transcodeCacheMb) })
  cacheMb.addEventListener('change', () => saveConfig({ transcodeCacheMb: Number(cacheMb.value) }))
  const usage = h('span', { class: 'muted small', text: t('player.admin.cacheUsage', { size: fmtBytes(cache.transcode?.bytes), files: fmtNumber(cache.transcode?.files || 0) }) })

  const providers = h('div', { class: 'chips chips--wrap' }, PROVIDERS.map((p) => {
    const input = h('input', { type: 'checkbox', checked: config.onlineProviders.includes(p) })
    input.addEventListener('change', async () => {
      const list = [...providers.querySelectorAll('input')].map((el, i) => (el.checked ? PROVIDERS[i] : null)).filter(Boolean)
      const saved = await saveConfig({ onlineProviders: list })
      if (saved) app.providers = saved.onlineProviders
    })
    return h('label', { class: 'check-chip' }, input, h('span', { text: { deezer: 'Deezer', youtube: 'YouTube Music', spotify: 'Spotify' }[p] }))
  }))

  box.append(
    card(t('player.admin.general'), null,
      settingRow(t('player.admin.serverName'), t('player.admin.serverNameHint'), name),
      settingRow(t('player.admin.scanInterval'), t('player.admin.scanIntervalHint'), scan),
      settingRow(t('player.admin.onlineLyrics'), t('player.admin.onlineLyricsHint'), toggle(config.onlineLyrics, (v) => saveConfig({ onlineLyrics: v })))),
    card(t('player.admin.discovery'), t('player.admin.discoveryHint'),
      settingRow(t('player.admin.discoveryEnabled'), null, toggle(config.discoveryEnabled, (v) => saveConfig({ discoveryEnabled: v }))),
      settingRow(t('player.admin.providers'), t('player.admin.providersHint'), providers),
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn--outline btn--sm', onclick: async () => { try { await del('/admin/online-cache'); toast(t('player.admin.onlineCacheCleared'), { type: 'success' }) } catch (error) { toastError(error) } } }, icon('refresh', { size: 16 }), t('player.admin.clearOnlineCache')))),
    card(t('player.admin.streaming'), t('player.admin.streamingHint'),
      settingRow(t('player.admin.cacheLimit'), t('player.admin.cacheLimitHint'), h('div', { class: 'inline' }, cacheMb, h('span', { class: 'muted', text: 'MB' }))),
      h('div', { class: 'row-actions' }, usage, h('button', { type: 'button', class: 'btn btn--outline btn--sm', onclick: async () => {
        try { await del('/admin/cache'); usage.textContent = t('player.admin.cacheUsage', { size: fmtBytes(0), files: 0 }); toast(t('player.admin.cacheCleared'), { type: 'success' }) } catch (error) { toastError(error) }
      } }, icon('trash', { size: 16 }), t('player.admin.clearCache')))),
    card(t('player.admin.remote'), null,
      settingRow(t('player.admin.remoteMode'), t('player.admin.remoteHint'), h('span', { class: ['pill', remoteAccess !== 'off' && 'pill--accent'], text: t(`player.admin.remote_${remoteAccess}`) })),
      settingRow(t('player.admin.yourNetwork'), null, h('span', { class: 'pill', text: t(`player.admin.net_${status.network || 'lan'}`) })),
      h('div', { class: 'row-actions' }, h('a', { class: 'btn btn--outline btn--sm', href: '#/admin/remote', text: t('player.remote.open') }))))
  return box
}

// ---- remote access ---------------------------------------------------------------

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast(t('player.pair.copied'), { type: 'success', timeout: 1500 }) } catch { toast(text) }
}

function copyButton(text) {
  return iconButton('copy', t('player.pair.copyLink'), () => copyText(text), { size: 16 })
}

async function remoteTab() {
  const box = h('div', { class: 'stack-lg' })
  async function load(fresh = false) {
    const [info, { config }] = await Promise.all([get('/admin/network', fresh ? { fresh: 1 } : null), get('/admin/config')])
    clear(box)
    paint(info, config)
  }

  function paint(info, config) {
    const ts = info.tailscale || {}
    const listener = info.listener || {}
    const listenerText = !listener.enabled ? t('player.remote.listenerOff')
      : listener.listening ? t('player.remote.listenerOn', { port: listener.port })
        : t('player.remote.listenerFailed', { error: listener.error?.message || listener.error?.code || '' })
    const refresh = h('button', { type: 'button', class: 'btn btn--outline btn--sm' }, icon('refresh', { size: 16 }), t('player.remote.refresh'))
    refresh.addEventListener('click', async () => { refresh.disabled = true; try { await load(true) } catch (error) { toastError(error); refresh.disabled = false } })

    box.append(card(t('player.remote.statusTitle'), t('player.remote.statusHint'),
      settingRow(t('player.admin.remoteMode'), t('player.admin.remoteHint'), h('span', { class: ['pill', info.remoteAccess !== 'off' && 'pill--accent'], text: t(`player.admin.remote_${info.remoteAccess}`) })),
      settingRow(t('player.admin.yourNetwork'), null, h('span', { class: 'pill', text: t(`player.admin.net_${info.requestNetwork || 'lan'}`) })),
      settingRow(t('player.remote.mainServer'), info.docker ? t('player.remote.docker') : null, h('span', { class: ['pill', info.main.lan && 'pill--accent'] }, `${info.main.host}:${info.main.port} · ${info.main.lan ? t('player.remote.mainNetwork') : t('player.remote.mainLocal')}`)),
      settingRow(t('player.remote.listener'), t('player.remote.listenerHint'), h('span', { class: ['pill', listener.listening && 'pill--accent', listener.enabled && !listener.listening && 'pill--warn'], text: listenerText })),
      ...(info.warnings || []).map((w) => h('p', { class: 'note', text: t(`player.remote.warn.${w}`) })),
      h('div', { class: 'row-actions' }, refresh, h('a', { class: 'btn btn--outline btn--sm', href: '/', text: t('player.admin.openGharmonizeSettings') }))))

    const list = h('div', { class: 'addr-list' })
    if (!info.addresses.length) list.append(h('p', { class: 'muted', text: t('player.remote.addressesEmpty') }))
    for (const a of info.addresses) {
      const state = a.funnel ? ['pill--warn', t('player.remote.funnel')] : a.blocked ? ['pill--warn', t('player.remote.needsRemote')] : ['pill--accent', t('player.remote.ok')]
      list.append(h('div', { class: 'addr' },
        h('span', { class: 'addr__icon' }, icon(a.network === 'tailscale' ? 'shield' : a.network === 'lan' ? 'server' : 'globe', { size: 18 })),
        h('div', { class: 'addr__text' }, h('b', { text: t(`player.remote.kind.${a.kind}`) }), h('code', { text: a.url })),
        h('span', { class: ['pill', state[0]], text: state[1] }),
        copyButton(a.url)))
    }
    box.append(card(t('player.remote.addressesTitle'), t('player.remote.addressesHint'), list))

    // Cloudflare Tunnel (recommended remote access).
    const tunnel = info.tunnel || { status: 'stopped' }
    const tunnelOn = info.remoteAccess === 'tunnel'
    const tunnelRows = []
    tunnelRows.push(settingRow(t('player.remote.tunnelState'), tunnel.binary ? `cloudflared ${tunnel.binary.version}` : null,
      h('span', { class: ['pill', tunnel.status === 'running' && 'pill--accent', (tunnel.status === 'error' || !tunnelOn) && 'pill--warn'], text: tunnelOn ? t(`player.remote.tunnel_${tunnel.status}`) : t('player.remote.tunnelOff') })))
    if (tunnel.url) {
      tunnelRows.push(h('div', { class: 'cmd' }, h('code', { text: tunnel.url }), copyButton(tunnel.url)))
      if (tunnel.mode === 'quick') tunnelRows.push(h('p', { class: 'note', text: t('player.remote.tunnelQuickNote') }))
    }
    if (tunnel.error) tunnelRows.push(h('p', { class: 'form-error small', text: tunnel.error.message || tunnel.error.code }))
    if (tunnelOn) {
      const restart = h('button', { type: 'button', class: 'btn btn--outline btn--sm' }, icon('refresh', { size: 16 }), t('player.remote.tunnelRestart'))
      restart.addEventListener('click', async () => {
        restart.disabled = true
        try { await post('/admin/tunnel/restart', {}); setTimeout(() => load(true).catch(() => {}), 4000) } catch (error) { toastError(error); restart.disabled = false }
      })
      tunnelRows.push(h('div', { class: 'row-actions' }, restart))
    } else {
      tunnelRows.push(h('ol', { class: 'steps' },
        h('li', { text: t('player.remote.tunnelStep1') }),
        h('li', { text: t('player.remote.tunnelStep2') }),
        h('li', { text: t('player.remote.tunnelStep3') })))
    }
    box.append(card(t('player.remote.tunnelTitle'), t('player.remote.tunnelHint'), ...tunnelRows))

    const tsBody = []
    if (ts.running) {
      tsBody.push(
        settingRow(t('player.remote.tsState'), null, h('span', { class: 'pill pill--accent', text: t('player.remote.tsRunning') })),
        ts.tailnet ? settingRow(t('player.remote.tsTailnet'), null, h('code', { text: ts.tailnet })) : null,
        ts.dnsName ? settingRow(t('player.remote.tsDevice'), null, h('code', { text: ts.dnsName })) : null,
        ts.ips?.length ? settingRow(t('player.remote.tsIps'), null, h('code', { text: ts.ips.join('  ') })) : null,
        !ts.cli ? h('p', { class: 'muted small', text: t('player.remote.tsNoCli') }) : null)
    } else {
      tsBody.push(
        settingRow(t('player.remote.tsState'), null, h('span', { class: 'pill pill--warn', text: ts.detected ? t('player.remote.tsStopped', { state: ts.backendState || '?' }) : t('player.remote.tsNotDetected') })),
        info.docker ? h('p', { class: 'note', text: t('player.remote.tsDocker') }) : null)
    }
    const port = info.directPort || info.main.port
    const serveCmd = `tailscale serve --bg ${port}`
    box.append(card(t('player.remote.tsTitleAlt'), t('player.remote.tsHint'),
      ...tsBody,
      h('h3', { class: 'panel-card__sub', text: t('player.remote.tsStepsTitle') }),
      h('ol', { class: 'steps' },
        h('li', {}, t('player.remote.tsStep1'), ' ', h('a', { href: 'https://tailscale.com/download', target: '_blank', rel: 'noopener noreferrer', text: 'tailscale.com/download' })),
        h('li', { text: t('player.remote.tsStep2') }),
        h('li', { text: t('player.remote.tsStep3') }),
        info.docker ? null : h('li', { text: t('player.remote.tsStep4') }),
        h('li', { text: t('player.remote.tsStep5') })),
      h('h3', { class: 'panel-card__sub', text: t('player.remote.httpsTitle') }),
      h('p', { class: 'muted small', text: t('player.remote.httpsHint') }),
      h('div', { class: 'cmd' }, h('code', { text: serveCmd }), copyButton(serveCmd)),
      ts.serveUrls?.length ? h('p', { class: 'note note--ok', text: t('player.remote.httpsActive', { url: ts.serveUrls.join(', ') }) }) : null))

    const area = h('textarea', { class: 'input', rows: 3, placeholder: 'https://music.example.com\nhttp://100.101.102.103:5174', spellcheck: 'false' })
    area.value = (config.publicUrls || []).join('\n')
    const save = h('button', { type: 'button', class: 'btn btn--primary btn--sm', text: t('player.common.save') })
    save.addEventListener('click', async () => {
      const saved = await saveConfig({ publicUrls: area.value.split(/\s+/).filter(Boolean) })
      if (saved) load()
    })
    box.append(card(t('player.remote.customTitle'), t('player.remote.customHint'), area, h('div', { class: 'row-actions' }, save)))
  }

  await load()
  return box
}

// ---- downloads config -------------------------------------------------------------

async function downloadsTab() {
  const { config } = await get('/admin/config')
  const box = h('div', { class: 'stack-lg' })
  const format = h('select', { class: 'select' }, Object.keys(DOWNLOAD_FORMATS).map((f) => h('option', { value: f, selected: config.downloadFormat === f, text: f.toUpperCase() })))
  const bitrate = h('select', { class: 'select' })
  const fillBitrates = (fmt, selected) => {
    clear(bitrate)
    for (const b of DOWNLOAD_FORMATS[fmt]) bitrate.append(h('option', { value: b, selected: b === selected, text: b === 'lossless' ? t('player.badge.lossless') : b === 'auto' ? t('player.admin.bitrateAuto') : b.replace('k', ' kbps') }))
  }
  fillBitrates(config.downloadFormat, config.downloadBitrate)
  format.addEventListener('change', async () => {
    const saved = await saveConfig({ downloadFormat: format.value })
    if (saved) fillBitrates(saved.downloadFormat, saved.downloadBitrate)
  })
  bitrate.addEventListener('change', () => saveConfig({ downloadBitrate: bitrate.value }))
  const parallel = h('input', { class: 'input input--num', type: 'number', min: '1', max: '10', value: String(config.maxParallelDownloads) })
  parallel.addEventListener('change', () => saveConfig({ maxParallelDownloads: Number(parallel.value) }))
  const perUser = h('input', { class: 'input input--num', type: 'number', min: '1', max: '1000', value: String(config.maxQueuedPerUser) })
  perUser.addEventListener('change', () => saveConfig({ maxQueuedPerUser: Number(perUser.value) }))
  box.append(card(t('player.admin.bridge'), t('player.admin.bridgeHint'),
    settingRow(t('player.admin.downloadsEnabled'), t('player.admin.downloadsEnabledHint'), toggle(config.downloadsEnabled, async (v) => { if (await saveConfig({ downloadsEnabled: v })) { const me = await get('/me'); app.me = me; app.canDownload = Boolean(me.permissions?.canDownload) } })),
    settingRow(t('player.admin.format'), null, format),
    settingRow(t('player.admin.bitrate'), null, bitrate),
    settingRow(t('player.admin.downloadLyrics'), t('player.admin.downloadLyricsHint'), toggle(config.downloadLyrics, (v) => saveConfig({ downloadLyrics: v }))),
    settingRow(t('player.admin.parallel'), t('player.admin.parallelHint'), parallel),
    settingRow(t('player.admin.perUser'), t('player.admin.perUserHint'), perUser)),
  h('p', { class: 'note', text: t('player.admin.permissionsNote') }))
  return box
}

// ---- libraries ----------------------------------------------------------------------

async function librariesTab() {
  const box = h('div', { class: 'stack-lg' })
  const list = h('div', { class: 'lib-list' })
  const scanBox = h('div', { class: 'scan-status' })
  let pollTimer = null

  async function load() {
    const res = await get('/admin/libraries')
    paint(res.items, res.scan)
  }

  function paintScan(scan) {
    clear(scanBox)
    if (!scan?.running) {
      clearInterval(pollTimer)
      pollTimer = null
      if (scan?.finishedAt) scanBox.append(h('span', { class: 'muted small', text: t('player.admin.scanDone', { when: fmtRelative(scan.finishedAt), added: scan.added, updated: scan.updated, removed: scan.removed }) }))
      return
    }
    scanBox.append(h('div', { class: 'scan-status__live' },
      h('div', { class: 'spinner spinner--sm' }),
      h('span', { text: t('player.admin.scanning', { name: scan.libraryName || '', phase: t(`player.admin.phase_${scan.phase}`), scanned: fmtNumber(scan.scanned || 0), added: scan.added || 0 }) })))
    if (!pollTimer) pollTimer = setInterval(async () => {
      if (!box.isConnected) { clearInterval(pollTimer); pollTimer = null; return }
      try {
        const s = await get('/admin/scan')
        paintScan(s)
        if (!s.running) load()
      } catch {}
    }, 1500)
  }

  function paint(items, scan) {
    clear(list)
    for (const lib of items) {
      const offline = lib.lastScanStatus === 'offline'
      list.append(h('div', { class: ['lib', !lib.enabled && 'is-disabled'] },
        h('div', { class: 'lib__icon' }, icon(lib.isDefault ? 'download' : 'folder', { size: 22 })),
        h('div', { class: 'lib__text' },
          h('div', { class: 'lib__name' }, h('b', { text: lib.name }), lib.isDefault ? h('span', { class: 'pill pill--accent', text: t('player.admin.defaultLibrary') }) : null, offline ? h('span', { class: 'pill pill--warn', text: t('player.admin.offline') }) : null),
          h('code', { class: 'lib__path', text: lib.path }),
          h('span', { class: 'muted small', text: [plural2(lib.trackCount), lib.lastScanAt ? t('player.admin.lastScan', { when: fmtRelative(lib.lastScanAt) }) : t('player.admin.neverScanned')].join(' · ') }),
          offline && lib.lastScanError ? h('span', { class: 'form-error small', text: lib.lastScanError }) : null),
        h('div', { class: 'lib__actions' },
          toggle(lib.enabled, async (v, input) => {
            try { await patch(`/admin/libraries/${lib.id}`, { enabled: v }); toast(t('player.admin.saved'), { type: 'success', timeout: 1500 }) } catch (error) { input.checked = !v; toastError(error) }
          }, { label: t('player.admin.enabled') }),
          iconButton('refresh', t('player.admin.scanNow'), async () => { try { paintScan(await post('/admin/scan', { libraryId: lib.id })) } catch (error) { toastError(error) } }),
          iconButton('edit', t('player.admin.rename'), async () => {
            const name = await promptDialog({ title: t('player.admin.rename'), label: t('player.admin.libraryName'), value: lib.name, maxLength: 80 })
            if (!name) return
            try { await patch(`/admin/libraries/${lib.id}`, { name }); load() } catch (error) { toastError(error) }
          }),
          lib.isDefault ? null : iconButton('trash', t('player.admin.removeLibrary'), async () => {
            if (!await confirmDialog({ title: t('player.admin.removeLibrary'), message: t('player.admin.removeLibraryConfirm', { name: lib.name }), danger: true, confirmLabel: t('player.common.delete') })) return
            try { await del(`/admin/libraries/${lib.id}`); load() } catch (error) { toastError(error) }
          }, { cls: 'icon-btn--danger' }))))
    }
    paintScan(scan)
  }

  const nameInput = h('input', { class: 'input', type: 'text', placeholder: t('player.admin.libraryNamePh'), maxlength: 80 })
  const pathInput = h('input', { class: 'input', type: 'text', placeholder: '/music', required: true, spellcheck: 'false', autocapitalize: 'none' })
  const error = h('p', { class: 'form-error', hidden: true })
  const form = h('form', { class: 'lib-add' },
    h('label', { class: 'field' }, h('span', { class: 'field__label', text: t('player.admin.libraryName') }), nameInput),
    h('label', { class: 'field field--grow' }, h('span', { class: 'field__label', text: t('player.admin.libraryPath') }), pathInput),
    h('button', { type: 'submit', class: 'btn btn--primary' }, icon('plus', { size: 18 }), t('player.admin.addLibrary')),
    error)
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    error.hidden = true
    try {
      await post('/admin/libraries', { name: nameInput.value.trim() || undefined, path: pathInput.value.trim() })
      form.reset()
      toast(t('player.admin.libraryAdded'), { type: 'success' })
      load()
    } catch (err) { error.textContent = errorText(err); error.hidden = false }
  })

  box.append(
    card(t('player.admin.libraries'), t('player.admin.librariesHint'),
      h('div', { class: 'row-actions' }, scanBox, h('button', { type: 'button', class: 'btn btn--outline btn--sm', onclick: async () => { try { paintScan(await post('/admin/scan', {})) } catch (error) { toastError(error) } } }, icon('refresh', { size: 16 }), t('player.admin.scanAll'))),
      list),
    card(t('player.admin.addLibrary'), t('player.admin.addLibraryHint'), form, h('p', { class: 'muted small', text: t('player.admin.dockerHint') })))
  await load()
  return box
}

function plural2(n) {
  return t(Number(n) === 1 ? 'player.count.track' : 'player.count.tracks', { n: fmtNumber(n || 0) })
}

// ---- users -------------------------------------------------------------------------------

function userForm(user, libraries) {
  const isNew = !user
  return modal({
    title: isNew ? t('player.admin.newUser') : t('player.admin.editUser', { name: user.displayName || user.username }),
    wide: true,
    build: (close) => {
      const username = h('input', { class: 'input', type: 'text', required: true, minlength: 2, autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off' })
      const displayName = h('input', { class: 'input', type: 'text', value: user?.displayName || '', maxlength: 64 })
      const password = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: isNew, placeholder: isNew ? '' : t('player.admin.passwordKeep') })
      const role = h('select', { class: 'select' }, ['user', 'admin'].map((r) => h('option', { value: r, selected: (user?.role || 'user') === r, text: t(`player.role.${r}`) })))
      const canDownload = h('input', { type: 'checkbox', checked: Boolean(user?.canDownload) })
      const disabled = h('input', { type: 'checkbox', checked: Boolean(user?.disabled) })
      const all = h('input', { type: 'radio', name: 'libAccess', value: 'all', checked: Boolean(user?.allLibraries) })
      const some = h('input', { type: 'radio', name: 'libAccess', value: 'some', checked: !user?.allLibraries })
      const selected = new Set(user ? (user.libraryIds || []) : libraries.filter((l) => l.isDefault).map((l) => l.id))
      const libBoxes = libraries.map((lib) => {
        const input = h('input', { type: 'checkbox', value: String(lib.id), checked: selected.has(lib.id) })
        return h('label', { class: 'check' }, input, h('span', {}, h('b', { text: lib.name }), h('small', { class: 'muted', text: lib.path })))
      })
      const libList = h('div', { class: 'check-list' }, libBoxes)
      const syncAccess = () => {
        const isAdmin = role.value === 'admin'
        libList.classList.toggle('is-disabled', all.checked || isAdmin)
        libList.querySelectorAll('input').forEach((el) => { el.disabled = all.checked || isAdmin })
        all.disabled = isAdmin
        some.disabled = isAdmin
        canDownload.disabled = isAdmin
        adminNote.hidden = !isAdmin
      }
      const adminNote = h('p', { class: 'note', text: t('player.admin.adminAllAccess'), hidden: true })
      all.addEventListener('change', syncAccess)
      some.addEventListener('change', syncAccess)
      role.addEventListener('change', syncAccess)
      const error = h('p', { class: 'form-error', hidden: true })
      const form = h('form', { class: 'user-form' },
        h('div', { class: 'form-grid' },
          isNew ? h('label', { class: 'field' }, h('span', { class: 'field__label', text: t('player.auth.username') }), username) : h('div', { class: 'field' }, h('span', { class: 'field__label', text: t('player.auth.username') }), h('code', { text: user.username })),
          h('label', { class: 'field' }, h('span', { class: 'field__label', text: t('player.setup.displayName') }), displayName),
          h('label', { class: 'field' }, h('span', { class: 'field__label', text: isNew ? t('player.auth.password') : t('player.admin.resetPassword') }), password),
          h('label', { class: 'field' }, h('span', { class: 'field__label', text: t('player.admin.role') }), role)),
        h('fieldset', { class: 'fieldset' },
          h('legend', { text: t('player.admin.permissions') }),
          h('label', { class: 'check' }, canDownload, h('span', {}, h('b', { text: t('player.admin.canDownload') }), h('small', { class: 'muted', text: t('player.admin.canDownloadHint') }))),
          isNew ? null : h('label', { class: 'check' }, disabled, h('span', {}, h('b', { text: t('player.admin.disabled') }), h('small', { class: 'muted', text: t('player.admin.disabledHint') })))),
        h('fieldset', { class: 'fieldset' },
          h('legend', { text: t('player.admin.libraryAccess') }),
          h('label', { class: 'check' }, all, h('span', {}, h('b', { text: t('player.admin.allLibraries') }), h('small', { class: 'muted', text: t('player.admin.allLibrariesHint') }))),
          h('label', { class: 'check' }, some, h('span', {}, h('b', { text: t('player.admin.someLibraries') }))),
          libList,
          adminNote),
        error,
        h('div', { class: 'modal__actions' },
          h('button', { type: 'button', class: 'btn btn--ghost', text: t('player.common.cancel'), onclick: () => close(null) }),
          h('button', { type: 'submit', class: 'btn btn--primary', text: isNew ? t('player.common.create') : t('player.common.save') })))
      syncAccess()
      form.addEventListener('submit', async (e) => {
        e.preventDefault()
        error.hidden = true
        const libraryAccess = all.checked ? 'all' : [...libList.querySelectorAll('input:checked')].map((el) => Number(el.value))
        const body = { displayName: displayName.value.trim() || undefined, role: role.value, canDownload: canDownload.checked, libraryAccess }
        if (password.value) body.password = password.value
        try {
          let saved
          if (isNew) saved = await post('/admin/users', { ...body, username: username.value.trim() })
          else saved = await patch(`/admin/users/${user.id}`, { ...body, disabled: disabled.checked })
          close(saved)
        } catch (err) { error.textContent = errorText(err); error.hidden = false }
      })
      return form
    }
  })
}

function devicesModal(user) {
  return modal({
    title: t('player.admin.devicesOf', { name: user.displayName || user.username }),
    build: () => {
      const list = h('div', { class: 'device-list' }, h('div', { class: 'spinner' }))
      const load = async () => {
        const res = await get(`/admin/users/${user.id}/devices`)
        clear(list)
        if (!res.items.length) list.append(h('p', { class: 'muted', text: t('player.account.noDevices') }))
        for (const d of res.items) {
          list.append(h('div', { class: 'device' },
            h('span', { class: 'device__icon' }, icon(d.kind === 'device' ? 'phone' : 'globe', { size: 20 })),
            h('div', { class: 'device__text' }, h('b', { text: d.name || t('player.account.unnamedDevice') }), h('span', { class: 'muted small', text: [d.platform, d.lastIp, t('player.account.lastUsed', { when: fmtRelative(d.lastUsedAt || d.createdAt) })].filter(Boolean).join(' · ') })),
            h('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: t('player.account.revoke'), onclick: async () => { try { await del(`/admin/devices/${encodeURIComponent(d.id)}`); load() } catch (error) { toastError(error) } } })))
        }
      }
      load().catch(toastError)
      return list
    }
  })
}

async function usersTab() {
  const box = h('div', { class: 'stack-lg' })
  const table = h('div', { class: 'user-table' })
  let libraries = []

  async function load() {
    const [users, libs] = await Promise.all([get('/admin/users'), get('/admin/libraries')])
    libraries = libs.items
    paint(users.items)
  }

  function accessSummary(user) {
    if (user.role === 'admin' || user.allLibraries) return t('player.admin.allLibraries')
    const names = (user.libraryIds || []).map((id) => libraries.find((l) => l.id === id)?.name).filter(Boolean)
    return names.length ? names.join(', ') : t('player.admin.noLibraries')
  }

  function paint(users) {
    clear(table)
    table.append(h('div', { class: 'user-row user-row--head' },
      h('span', { text: t('player.admin.user') }), h('span', { text: t('player.admin.role') }), h('span', { text: t('player.admin.libraryAccess') }), h('span', { text: t('player.admin.canDownload') }), h('span')))
    for (const user of users) {
      const self = user.id === app.user?.id
      table.append(h('div', { class: ['user-row', user.disabled && 'is-disabled'] },
        h('span', { class: 'user-row__name' },
          h('span', { class: 'avatar avatar--sm', text: (user.displayName || user.username).slice(0, 1).toUpperCase() }),
          h('span', {}, h('b', { text: user.displayName || user.username }), h('small', { class: 'muted', text: `@${user.username}${self ? ` · ${t('player.admin.you')}` : ''}` }))),
        h('span', {}, h('span', { class: ['pill', user.role === 'admin' && 'pill--accent'], text: t(`player.role.${user.role}`) }), user.disabled ? h('span', { class: 'pill pill--warn', text: t('player.admin.disabled') }) : null),
        h('span', { class: 'small', text: accessSummary(user) }),
        h('span', {}, user.canDownload ? icon('checkCircle', { size: 18, cls: 'ok' }) : icon('close', { size: 18, cls: 'muted' })),
        h('span', { class: 'user-row__actions' },
          iconButton('edit', t('player.admin.edit'), async () => { const saved = await userForm(user, libraries); if (saved) { toast(t('player.admin.saved'), { type: 'success' }); if (self) refreshPlaylists(); load() } }),
          iconButton('phone', t('player.admin.devices'), () => devicesModal(user)),
          self ? null : iconButton('trash', t('player.admin.deleteUser'), async () => {
            if (!await confirmDialog({ title: t('player.admin.deleteUser'), message: t('player.admin.deleteUserConfirm', { name: user.displayName || user.username }), danger: true, confirmLabel: t('player.common.delete') })) return
            try { await del(`/admin/users/${user.id}`); load() } catch (error) { toastError(error) }
          }, { cls: 'icon-btn--danger' }))))
    }
  }

  const add = h('button', { type: 'button', class: 'btn btn--primary' }, icon('plus', { size: 18 }), t('player.admin.newUser'))
  add.addEventListener('click', async () => {
    const saved = await userForm(null, libraries)
    if (saved) { toast(t('player.admin.userCreated', { name: saved.displayName || saved.username }), { type: 'success' }); load() }
  })
  box.append(card(t('player.admin.users'), t('player.admin.usersHint'), h('div', { class: 'row-actions' }, add), table))
  await load()
  return box
}

// ---- page ---------------------------------------------------------------------------------

export async function render(_name, params) {
  if (!app.isAdmin()) return { node: emptyState('lock', t('player.admin.noAccess'), t('player.admin.noAccessText')) }
  const tab = TABS.includes(params[0]) ? params[0] : 'server'
  const root = h('div', { class: 'admin' },
    h('header', { class: 'page-head' }, h('h1', { class: 'page-title' }, icon('shield', { size: 30 }), t('player.nav.admin'))),
    h('div', { class: 'chips' }, TABS.map((key) => h('a', { class: ['chip', key === tab && 'is-active'], href: `#/admin/${key}`, text: t(`player.admin.tab.${key}`) }))))
  const content = tab === 'libraries' ? await librariesTab() : tab === 'users' ? await usersTab() : tab === 'downloads' ? await downloadsTab() : tab === 'remote' ? await remoteTab() : await serverTab()
  root.append(content)
  return { node: root }
}
