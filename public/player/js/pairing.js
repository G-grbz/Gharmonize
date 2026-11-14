// Phone pairing: one-time code + QR code. Scanning the QR with the phone
// camera opens the web player already signed in; the Gharmonize Player app
// reads the same link (code + every known server address).

import { get, post } from './api.js'
import { h, t, icon, clear, toast, toastError } from './dom.js'
import { qrSvg } from './qr.js'

export function pairLink(base, code, { serverName = '', alternatives = [] } = {}) {
  const params = new URLSearchParams()
  params.set('code', code)
  if (serverName) params.set('s', serverName)
  for (const alt of alternatives) params.append('alt', alt)
  return `${String(base).replace(/\/+$/, '')}/player/#/pair?${params.toString()}`
}

// Reads ?code=… from a "#/pair?…" location hash.
export function pairCodeFromHash(hash = window.location.hash) {
  const match = String(hash || '').match(/^#\/pair\?(.*)$/)
  if (!match) return null
  const code = new URLSearchParams(match[1]).get('code')
  return code ? code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : null
}

// Short human name for this browser, shown in the device list.
export function deviceLabel(ua = navigator.userAgent || '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return [browser, os].filter(Boolean).join(' · ')
}

function kindLabel(address) {
  return t(`player.remote.kind.${address.kind}`)
}

// Panel shown after "Pair a phone": QR, code, address choice, countdown.
export function pairingPanel({ onPaired = null } = {}) {
  const box = h('div', { class: 'pairing', hidden: true })
  let countdown = null
  let watcher = null
  let run = 0

  function stop() {
    clearInterval(countdown)
    clearInterval(watcher)
  }

  async function start() {
    stop()
    const current = ++run
    clear(box)
    box.hidden = false
    box.append(h('div', { class: 'spinner' }))
    let codeRes
    let connect
    try {
      ;[codeRes, connect] = await Promise.all([post('/me/pairing-code'), get('/connect').catch(() => ({ addresses: [], warnings: [] }))])
    } catch (error) {
      box.hidden = true
      toastError(error)
      return
    }
    clear(box)
    const usable = connect.addresses.filter((a) => !a.blocked)
    const blocked = connect.addresses.filter((a) => a.blocked)
    let selected = usable[0] || null
    const qrBox = h('div', { class: 'pairing__qr' })
    const linkText = h('code', { class: 'pairing__link' })
    const left = h('span', { class: 'muted small' })
    const code = `${codeRes.code.slice(0, 4)}-${codeRes.code.slice(4)}`

    const link = () => selected && pairLink(selected.url, codeRes.code, {
      serverName: connect.serverName,
      alternatives: usable.filter((a) => a !== selected).map((a) => a.url).slice(0, 3)
    })
    const paint = () => {
      clear(qrBox)
      if (!selected) {
        qrBox.append(h('div', { class: 'pairing__noqr' }, icon('lock', { size: 30 }), h('span', { text: t('player.pair.noAddress') })))
        linkText.textContent = ''
        return
      }
      qrBox.append(qrSvg(link(), { label: t('player.pair.qrLabel') }))
      linkText.textContent = selected.url
    }

    const choices = h('div', { class: 'pairing__choices', role: 'radiogroup' })
    for (const address of [...usable, ...blocked]) {
      const input = h('input', { type: 'radio', name: 'pairAddress', checked: address === selected, disabled: address.blocked })
      input.addEventListener('change', () => { selected = address; paint() })
      choices.append(h('label', { class: ['pairing__choice', address.blocked && 'is-blocked'] },
        input,
        h('span', { class: 'pairing__choice-text' },
          h('b', { text: kindLabel(address) }),
          h('code', { text: address.url }),
          address.blocked ? h('small', { class: 'muted', text: t('player.remote.blockedHint') }) : null)))
    }

    const copy = h('button', { type: 'button', class: 'btn btn--outline btn--sm', disabled: !selected }, icon('copy', { size: 16 }), t('player.pair.copyLink'))
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link()); toast(t('player.pair.copied'), { type: 'success' }) } catch { toast(link()) }
    })

    box.append(
      h('div', { class: 'pairing__main' },
        qrBox,
        h('div', { class: 'pairing__side' },
          h('ol', { class: 'pairing__steps' },
            h('li', { text: t('player.pair.step1') }),
            h('li', { text: t('player.pair.step2') }),
            h('li', { text: t('player.pair.step3') })),
          h('div', { class: 'pairing__code' }, h('span', { class: 'muted small', text: t('player.pair.manual') }), h('div', { class: 'pair-code__value', text: code }), linkText),
          left,
          h('div', { class: 'row-actions row-actions--start' }, copy,
            h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => start() }, icon('refresh', { size: 16 }), t('player.pair.newCode'))))),
      connect.addresses.length > 1 ? h('details', { class: 'pairing__more' }, h('summary', { text: t('player.pair.addresses') }), choices) : null,
      ...(connect.warnings || []).filter((w) => ['LOCAL_ONLY', 'REMOTE_OFF', 'LISTENER_FAILED'].includes(w)).map((w) => h('p', { class: 'note', text: t(`player.remote.warn.${w}`) })))
    paint()

    const tick = () => {
      const s = Math.max(0, Math.round((codeRes.expiresAt - Date.now()) / 1000))
      left.textContent = s ? t('player.account.pairExpires', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') }) : t('player.account.pairExpired')
      box.classList.toggle('is-expired', !s)
      if (!s) clearInterval(countdown)
    }
    tick()
    countdown = setInterval(() => { if (!box.isConnected) clearInterval(countdown); else tick() }, 1000)

    // Close the panel as soon as the phone has used the code.
    watcher = setInterval(async () => {
      if (!box.isConnected || box.hidden || current !== run) { clearInterval(watcher); return }
      if (document.hidden) return
      try {
        const status = await get(`/me/pairing-code/${encodeURIComponent(codeRes.code)}`)
        if (current !== run) return
        if (status.used) {
          stop()
          clear(box)
          box.hidden = true
          toast(t('player.pair.paired'), { type: 'success' })
          onPaired?.()
        } else if (status.expired) clearInterval(watcher)
      } catch {}
    }, 2500)
  }

  return { el: box, start }
}
