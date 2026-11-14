import { FLUENT_ICONS } from './fluentIcons.js'
// Small DOM toolkit for Gharmonize Player (no framework, CSP-safe: no inline
// handlers, elements are built node by node, never from HTML strings).

export function t(key, vars = {}) {
  const fn = window.i18n?.t
  const value = fn ? fn(key, vars) : key
  if (value !== key) return value
  // Fallback: keep {placeholders} usable even before i18n is ready.
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), key)
}

export function h(tag, props = null, ...children) {
  const el = document.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value
      else if (key === 'text') el.textContent = value
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value)
      else if (key === 'dataset') Object.assign(el.dataset, value)
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value)
      else if (key in el && typeof value !== 'string' && key !== 'list') el[key] = value
      else el.setAttribute(key, value === true ? '' : String(value))
    }
  }
  append(el, children)
  return el
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove()
  return el
}

// ---- icons ----------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg'
export function icon(name, { size = 20, cls = '', title = null } = {}) {
  const paths = FLUENT_ICONS[name] || FLUENT_ICONS.music
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', size)
  svg.setAttribute('height', size)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', `icon icon-${name} ${cls}`.trim())
  for (const spec of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', spec.d)
    path.setAttribute('fill', 'currentColor')
    path.setAttribute('fill-rule', spec.rule)
    svg.append(path)
  }
  if (title) {
    const titleEl = document.createElementNS(SVG_NS, 'title')
    titleEl.textContent = title
    svg.prepend(titleEl)
  }
  return svg
}

export function iconButton(name, label, onClick, { cls = '', size = 20, pressed = null, disabled = false } = {}) {
  const btn = h('button', { type: 'button', class: `icon-btn ${cls}`.trim(), title: label, 'aria-label': label, disabled }, icon(name, { size }))
  if (pressed !== null) btn.setAttribute('aria-pressed', String(Boolean(pressed)))
  if (onClick) btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(e) })
  return btn
}

export function setIcon(button, name, size = 20) {
  const old = button.querySelector('svg.icon')
  const next = icon(name, { size })
  if (old) old.replaceWith(next)
  else button.prepend(next)
}

// ---- formatting ------------------------------------------------------------

export function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

export function fmtLong(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  if (hours) return t('player.fmt.hoursMinutes', { h: hours, m: minutes })
  if (minutes) return t('player.fmt.minutes', { m: minutes })
  return t('player.fmt.seconds', { s })
}

// Intl formatters are costly to create; cards format many numbers per page.
let numberFormat = null
export function fmtNumber(n) {
  const lang = document.documentElement.lang || 'en'
  try {
    if (numberFormat?.lang !== lang) numberFormat = { lang, format: new Intl.NumberFormat(lang) }
    return numberFormat.format.format(Number(n) || 0)
  } catch { return String(n) }
}

export function fmtBytes(bytes) {
  const n = Number(bytes) || 0
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function fmtRelative(ts) {
  if (!ts) return '—'
  const diff = Date.now() - Number(ts)
  let rtf
  try { rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || 'en', { numeric: 'auto' }) } catch { return new Date(ts).toLocaleString() }
  const abs = Math.abs(diff)
  const sign = diff >= 0 ? -1 : 1
  if (abs < 60_000) return rtf.format(sign * Math.round(abs / 1000), 'second')
  if (abs < 3_600_000) return rtf.format(sign * Math.round(abs / 60_000), 'minute')
  if (abs < 86_400_000) return rtf.format(sign * Math.round(abs / 3_600_000), 'hour')
  if (abs < 30 * 86_400_000) return rtf.format(sign * Math.round(abs / 86_400_000), 'day')
  return new Date(Number(ts)).toLocaleDateString(document.documentElement.lang || undefined)
}

export function plural(count, oneKey, manyKey) {
  return t(Number(count) === 1 ? oneKey : manyKey, { n: fmtNumber(count) })
}

// Stable pleasant hue for an arbitrary string (cards without artwork, moods).
export function hueOf(text) {
  let hash = 0
  for (const ch of String(text || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0
  return hash % 360
}

export function debounce(fn, ms) {
  let timer = null
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
  wrapped.cancel = () => clearTimeout(timer)
  return wrapped
}

// ---- artwork ---------------------------------------------------------------

// Resize only genuine Deezer CDN paths, leaving other hosts and queries intact.
export function cardArtworkUrl(src) {
  try {
    const url = new URL(src)
    if (url.protocol === 'https:' && (url.hostname === 'dzcdn.net' || url.hostname.endsWith('.dzcdn.net'))) {
      url.pathname = url.pathname.replace(/\/(\d{3,4})x\1-/, '/500x500-')
      return url.toString()
    }
  } catch {}
  return src
}

// `src` may be null; a tinted placeholder with an icon is shown instead.
export function artwork(src, { alt = '', round = false, cls = '', placeholder = 'music', seed = alt, lazy = true } = {}) {
  const box = h('div', { class: ['art', round && 'art--round', cls] })
  box.style.setProperty('--art-hue', hueOf(seed || alt || 'x'))
  const ph = h('div', { class: 'art__ph' }, icon(placeholder, { size: 28 }))
  box.append(ph)
  // Deezer serves 1000 px covers by default; cards only need 500 px.
  if (src && lazy) src = cardArtworkUrl(src)
  if (src) {
    // Covers are square; explicit dimensions let the browser reserve the box
    // before a lazy image loads (CSS still sizes it to fill .art).
    const px = String(Number(/[?&]size=(\d+)/.exec(src)?.[1] || /\/(\d{2,4})x\1[-.]/.exec(src)?.[1]) || 256)
    const img = h('img', { alt, width: px, height: px, decoding: 'async', draggable: 'false', referrerpolicy: 'no-referrer' })
    if (lazy) img.loading = 'lazy'
    img.addEventListener('load', () => box.classList.add('art--loaded'))
    img.addEventListener('error', () => img.remove())
    img.src = src
    box.append(img)
  }
  return box
}

// ---- toasts ------------------------------------------------------------------

export function toast(message, { type = 'info', action = null, timeout = 4200 } = {}) {
  let host = document.getElementById('toasts')
  if (!host) { host = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }); document.body.append(host) }
  const el = h('div', { class: `toast toast--${type}`, role: type === 'error' ? 'alert' : 'status' },
    h('span', { class: 'toast__text', text: message }),
    action && h('button', { type: 'button', class: 'toast__action', text: action.label, onclick: () => { action.run(); dismiss() } })
  )
  host.append(el)
  requestAnimationFrame(() => el.classList.add('is-in'))
  const timer = setTimeout(dismiss, timeout)
  function dismiss() {
    clearTimeout(timer)
    el.classList.remove('is-in')
    setTimeout(() => el.remove(), 250)
  }
  return dismiss
}

export function errorText(error) {
  const code = error?.code
  if (code) {
    const key = `player.error.${code}`
    const msg = t(key)
    if (msg !== key) return msg
  }
  return error?.message || t('player.error.generic')
}

export function toastError(error) {
  return toast(errorText(error), { type: 'error' })
}

// ---- modal dialogs -------------------------------------------------------------

// Opens a modal. `build(close)` returns the body; resolves with close(value).
export function modal({ title, build, wide = false, onClose = null }) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: ['modal', wide && 'modal--wide'] })
    let done = false
    const close = (value) => {
      if (done) return
      done = true
      dialog.close()
      dialog.remove()
      onClose?.(value)
      resolve(value)
    }
    const head = h('div', { class: 'modal__head' },
      h('h2', { class: 'modal__title', text: title }),
      iconButton('close', t('player.common.close'), () => close(undefined))
    )
    const body = h('div', { class: 'modal__body' })
    append(body, [build(close)])
    dialog.append(head, body)
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined) })
    dialog.addEventListener('click', (e) => { if (e.target === dialog) close(undefined) })
    document.body.append(dialog)
    dialog.showModal()
    const focusable = body.querySelector('input, select, textarea, button.btn--primary')
    focusable?.focus()
  })
}

export function confirmDialog({ title, message, confirmLabel = t('player.common.confirm'), danger = false }) {
  return modal({
    title,
    build: (close) => h('div', { class: 'stack' },
      h('p', { class: 'muted', text: message }),
      h('div', { class: 'modal__actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', text: t('player.common.cancel'), onclick: () => close(false) }),
        h('button', { type: 'button', class: ['btn', danger ? 'btn--danger' : 'btn--primary'], text: confirmLabel, onclick: () => close(true) })
      )
    )
  }).then(Boolean)
}

export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = t('player.common.save'), maxLength = 120 }) {
  return modal({
    title,
    build: (close) => {
      const input = h('input', { class: 'input', type: 'text', value, placeholder, maxlength: maxLength })
      const form = h('form', { class: 'stack' },
        h('label', { class: 'field' }, h('span', { class: 'field__label', text: label }), input),
        h('div', { class: 'modal__actions' },
          h('button', { type: 'button', class: 'btn btn--ghost', text: t('player.common.cancel'), onclick: () => close(null) }),
          h('button', { type: 'submit', class: 'btn btn--primary', text: confirmLabel })
        )
      )
      form.addEventListener('submit', (e) => { e.preventDefault(); close(input.value.trim() || null) })
      setTimeout(() => { input.focus(); input.select() }, 0)
      return form
    }
  })
}

// ---- context menu ----------------------------------------------------------------

let openMenu = null

export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null }
}

// items: [{ label, icon, run, danger, disabled, submenu: async () => items }] | 'sep'
export function contextMenu(items, at) {
  closeMenu()
  const menu = h('div', { class: 'menu', role: 'menu' })
  const build = (list) => {
    clear(menu)
    for (const item of list.filter(Boolean)) {
      if (item === 'sep') { menu.append(h('div', { class: 'menu__sep', role: 'separator' })); continue }
      if (item.header) { menu.append(h('div', { class: 'menu__header', text: item.header })); continue }
      const btn = h('button', { type: 'button', class: ['menu__item', item.danger && 'is-danger'], role: 'menuitem', disabled: item.disabled },
        item.icon ? icon(item.icon, { size: 18 }) : h('span', { class: 'menu__spacer' }),
        h('span', { class: 'menu__label', text: item.label }),
        item.submenu ? icon('chevR', { size: 16, cls: 'menu__chev' }) : null
      )
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (item.submenu) {
          const sub = await item.submenu()
          build([{ label: t('player.common.back'), icon: 'chevL', submenu: async () => list }, 'sep', ...sub])
          position()
          return
        }
        closeMenu()
        item.run?.()
      })
      menu.append(btn)
    }
  }
  build(items)
  document.body.append(menu)
  openMenu = menu
  function position() {
    const rect = menu.getBoundingClientRect()
    let x
    let y
    if (at instanceof Element) {
      const r = at.getBoundingClientRect()
      x = r.right - rect.width
      y = r.bottom + 4
      if (x < 8) x = r.left
    } else {
      x = at.clientX
      y = at.clientY
    }
    x = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    if (y + rect.height > window.innerHeight - 8) y = Math.max(8, (at instanceof Element ? at.getBoundingClientRect().top - rect.height - 4 : y - rect.height))
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
  }
  position()
  menu.querySelector('.menu__item:not([disabled])')?.focus()
}

document.addEventListener('click', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu() })
window.addEventListener('resize', closeMenu)
document.addEventListener('scroll', closeMenu, true)

// ---- misc --------------------------------------------------------------------

export function skeletonShelf(count = 6) {
  return h('section', { class: 'shelf shelf--skeleton', 'aria-busy': 'true' },
    h('div', { class: 'shelf__head' }, h('div', { class: 'skel skel--title' })),
    h('div', { class: 'shelf__row' }, Array.from({ length: count }, () => h('div', { class: 'card card--skel' }, h('div', { class: 'skel skel--art' }), h('div', { class: 'skel skel--line' }), h('div', { class: 'skel skel--line skel--short' }))))
  )
}

export function emptyState(iconName, title, text = '', action = null) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty__icon' }, icon(iconName, { size: 40 })),
    h('h3', { class: 'empty__title', text: title }),
    text && h('p', { class: 'empty__text', text }),
    action && h('button', { type: 'button', class: 'btn btn--primary', text: action.label, onclick: action.run })
  )
}

export function spinner(size = 28) {
  return h('div', { class: 'spinner', style: { width: `${size}px`, height: `${size}px` }, role: 'status', 'aria-label': t('player.common.loading') })
}

export function toggle(checked, onChange, { label = '', disabled = false } = {}) {
  const input = h('input', { type: 'checkbox', class: 'switch__input', checked: Boolean(checked), disabled })
  input.addEventListener('change', () => onChange(input.checked, input))
  return h('label', { class: 'switch' }, input, h('span', { class: 'switch__track', 'aria-hidden': 'true' }), label && h('span', { class: 'switch__label', text: label }))
}
