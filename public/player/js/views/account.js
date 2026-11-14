// Account: playback preferences, appearance & language, password, paired
// devices and pairing codes for the mobile app.

import { app } from '../app.js'
import { get, post, del } from '../api.js'
import { h, t, icon, clear, toggle, toast, toastError, fmtRelative, confirmDialog, errorText } from '../dom.js'
import { applyTheme, currentTheme, applyAccent, currentAccent, ACCENTS } from '../theme.js'
import { showShortcuts } from '../chrome.js'
import { pairingPanel } from '../pairing.js'
import { PROGRESS_STYLES, progressStyle } from '../seekbar.js'

const QUALITIES = ['original', 'high', 'normal', 'low', 'saver']
const LANGS = [['tr', 'Türkçe'], ['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español']]

function card(title, ...children) {
  return h('section', { class: 'panel-card' }, h('h2', { class: 'panel-card__title', text: title }), ...children)
}

function settingRow(label, hint, control) {
  return h('div', { class: 'setting' }, h('div', { class: 'setting__text' }, h('b', { text: label }), hint ? h('span', { class: 'muted small', text: hint }) : null), control)
}

function segmented(options, value, onChange) {
  const box = h('div', { class: 'segmented', role: 'radiogroup' })
  for (const [key, label] of options) {
    const btn = h('button', { type: 'button', class: ['segmented__btn', key === value && 'is-active'], role: 'radio', 'aria-checked': String(key === value), text: label })
    btn.addEventListener('click', () => {
      box.querySelectorAll('.segmented__btn').forEach((b) => { b.classList.toggle('is-active', b === btn); b.setAttribute('aria-checked', String(b === btn)) })
      onChange(key)
    })
    box.append(btn)
  }
  return box
}

function accentPicker() {
  const box = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': t('player.theme.accent') })
  for (const key of ACCENTS) {
    const btn = h('button', { type: 'button', class: ['swatch', `swatch--${key}`, key === currentAccent() && 'is-on'], role: 'radio', 'aria-checked': String(key === currentAccent()), title: t(`player.theme.accent.${key}`), 'aria-label': t(`player.theme.accent.${key}`) }, icon('check', { size: 16 }))
    btn.addEventListener('click', () => {
      applyAccent(key)
      box.querySelectorAll('.swatch').forEach((b) => { b.classList.toggle('is-on', b === btn); b.setAttribute('aria-checked', String(b === btn)) })
    })
    box.append(btn)
  }
  return box
}

function devicesCard(me) {
  const list = h('div', { class: 'device-list' })
  const paint = (devices) => {
    clear(list)
    if (!devices.length) list.append(h('p', { class: 'muted', text: t('player.account.noDevices') }))
    for (const d of devices) {
      const current = d.id === me.currentDeviceId
      list.append(h('div', { class: 'device' },
        h('span', { class: 'device__icon' }, icon(d.kind === 'device' ? 'phone' : 'globe', { size: 20 })),
        h('div', { class: 'device__text' },
          h('b', {}, d.name || t('player.account.unnamedDevice'), current ? h('span', { class: 'pill pill--accent', text: t('player.account.thisDevice') }) : null),
          h('span', { class: 'muted small', text: [d.platform, d.lastIp, t('player.account.lastUsed', { when: fmtRelative(d.lastUsedAt || d.createdAt) })].filter(Boolean).join(' · ') })),
        current ? null : h('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: t('player.account.revoke'), onclick: async () => {
          if (!await confirmDialog({ title: t('player.account.revoke'), message: t('player.account.revokeConfirm', { name: d.name || '' }), danger: true, confirmLabel: t('player.account.revoke') })) return
          try { await del(`/me/devices/${encodeURIComponent(d.id)}`); const fresh = await get('/me'); paint(fresh.devices) } catch (error) { toastError(error) }
        } })))
    }
  }
  paint(me.devices || [])
  const pairing = pairingPanel({ onPaired: async () => { try { paint((await get('/me')).devices || []) } catch {} } })
  const pairBtn = h('button', { type: 'button', class: 'btn btn--primary' }, icon('phone', { size: 18 }), t('player.account.pairNew'))
  pairBtn.addEventListener('click', () => pairing.start())
  return card(t('player.account.devices'), h('p', { class: 'muted', text: t('player.account.devicesHint') }), list, h('div', { class: 'row-actions' }, pairBtn), pairing.el)
}

function passwordCard() {
  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true })
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 })
  const repeat = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 })
  const error = h('p', { class: 'form-error', hidden: true })
  const form = h('form', { class: 'stack stack--narrow' },
    h('label', { class: 'field' }, h('span', { class: 'field__label', text: t('player.account.currentPassword') }), current),
    h('label', { class: 'field' }, h('span', { class: 'field__label', text: t('player.account.newPassword') }), next),
    h('label', { class: 'field' }, h('span', { class: 'field__label', text: t('player.account.repeatPassword') }), repeat),
    error,
    h('div', {}, h('button', { type: 'submit', class: 'btn btn--primary', text: t('player.account.changePassword') })))
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    error.hidden = true
    if (next.value !== repeat.value) { error.textContent = t('player.account.passwordMismatch'); error.hidden = false; return }
    try {
      await post('/me/password', { currentPassword: current.value, newPassword: next.value })
      form.reset()
      toast(t('player.account.passwordChanged'), { type: 'success' })
    } catch (err) { error.textContent = errorText(err); error.hidden = false }
  })
  return card(t('player.account.password'), h('p', { class: 'muted', text: t('player.account.passwordHint') }), form)
}

export async function render() {
  const me = await get('/me')
  app.me = me
  const user = me.user
  const perms = me.permissions || {}
  const root = h('div', { class: 'account' },
    h('header', { class: 'profile' },
      h('div', { class: 'profile__avatar', text: (user.displayName || user.username).slice(0, 1).toUpperCase() }),
      h('div', {},
        h('span', { class: 'hero__kind', text: t('player.account.profile') }),
        h('h1', { class: 'profile__name', text: user.displayName || user.username }),
        h('p', { class: 'muted' }, `@${user.username}`, ' · ', user.role === 'admin' ? t('player.role.admin') : t('player.role.user')))))

  const quality = h('select', { class: 'select' }, QUALITIES.map((q) => h('option', { value: q, selected: app.prefs.quality === q, text: t(`player.quality.${q}`) })))
  quality.addEventListener('change', () => { app.setPref('quality', quality.value); app.player.reloadCurrent() })
  const cards = h('div', { class: 'account__cards' })
  root.append(cards)
  cards.append(card(t('player.account.playback'),
    settingRow(t('player.quality.title'), t('player.quality.hint'), quality),
    settingRow(t('player.quality.normalize'), t('player.quality.normalizeHint'), toggle(app.prefs.normalize, (v) => { app.setPref('normalize', v); app.player.applyVolume() })),
    settingRow(t('player.account.autoplay'), t('player.account.autoplayHint'), toggle(app.prefs.autoplay, (v) => app.setPref('autoplay', v))),
    settingRow(t('player.account.preload'), t('player.account.preloadHint'), toggle(app.prefs.preload, (v) => app.setPref('preload', v)))))

  const progress = h('select', { class: 'select' }, PROGRESS_STYLES.map((key) => h('option', { value: key, selected: progressStyle() === key, text: t(`player.progress.${key}`) })))
  progress.addEventListener('change', () => app.setPref('progressStyle', progress.value))

  const langSelect = h('select', { class: 'select' }, LANGS.map(([code, label]) => h('option', { value: code, selected: (window.i18n?.lang || 'en') === code, text: label })))
  langSelect.addEventListener('change', () => window.i18n?.setLang(langSelect.value))
  cards.append(card(t('player.account.appearance'),
    settingRow(t('player.theme.title'), null, segmented([['dark', t('player.theme.dark')], ['light', t('player.theme.light')]], currentTheme(), (v) => applyTheme(v))),
    settingRow(t('player.theme.accent'), t('player.theme.accentHint'), accentPicker()),
    settingRow(t('player.progress.title'), t('player.progress.hint'), progress),
    settingRow(t('player.account.language'), null, langSelect),
    settingRow(t('player.shortcuts.title'), null, h('button', { type: 'button', class: 'btn btn--outline btn--sm', text: t('player.shortcuts.show'), onclick: () => showShortcuts() }))))

  cards.append(card(t('player.account.permissions'),
    settingRow(t('player.account.canDownload'), null, h('span', { class: ['pill', perms.canDownload && 'pill--accent'], text: perms.canDownload ? t('player.common.yes') : t('player.common.no') })),
    settingRow(t('player.account.libraries'), null, h('div', { class: 'chips chips--wrap' }, (perms.libraries || []).map((l) => h('span', { class: 'chip chip--static', text: l.name }))))))

  cards.append(devicesCard(me), passwordCard())
  root.append(
    h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn btn--danger', onclick: () => import('../app.js').then(({ bus }) => bus.emit('logout')) }, icon('logout', { size: 18 }), t('player.auth.logout'))))
  return { node: root }
}
