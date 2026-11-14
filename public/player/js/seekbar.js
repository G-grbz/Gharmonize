// Seek bar styles (classic / bold / minimal / real waveform / cover ring) and
// the round cover controls of the full player: a progress ring around the
// cover and a volume arc on its right side that follows the finger.

import { app, bus } from './app.js'
import { get } from './api.js'
import { h } from './dom.js'

export const PROGRESS_STYLES = ['classic', 'bold', 'minimal', 'wave', 'ring']

export function progressStyle() {
  const s = app.prefs.progressStyle
  return PROGRESS_STYLES.includes(s) ? s : 'classic'
}

// ---- waveform data ---------------------------------------------------------------

const peaks = new Map()

// Resolves to 0..100 values for a library track, or null (previews, errors).
export function loadPeaks(item) {
  if (!item || item.type !== 'library' || !item.id) return Promise.resolve(null)
  if (!peaks.has(item.id)) {
    if (peaks.size >= 40) peaks.delete(peaks.keys().next().value)
    const job = get(`/waveform/${item.id}`)
      .then((r) => (Array.isArray(r?.bins) && r.bins.length ? r.bins.map((v) => Math.max(0, Math.min(100, Number(v) || 0)) / 100) : null))
      .catch(() => { peaks.delete(item.id); return null })
    peaks.set(item.id, job)
  }
  return peaks.get(item.id)
}

// Loudest value of the bins that fall into bar `i` of `n`.
function sample(bins, i, n) {
  const from = Math.floor((i * bins.length) / n)
  const to = Math.max(from + 1, Math.floor(((i + 1) * bins.length) / n))
  let max = 0
  for (let j = from; j < to && j < bins.length; j += 1) if (bins[j] > max) max = bins[j]
  return max
}

function fitCanvas(canvas, w, hgt) {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const cw = Math.round(w * dpr)
  const ch = Math.round(hgt * dpr)
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, hgt)
  return ctx
}

const cssVar = (el, name, fallback) => getComputedStyle(el).getPropertyValue(name).trim() || fallback

// ---- linear seek bar -----------------------------------------------------------------

// A native range input (keyboard, accessibility, dragging) with the chosen
// look; the "wave" style paints the real waveform on a canvas under it.
// `ring` is not a linear style: bars outside the full player fall back to
// classic, the full player hides its bar and uses the cover ring.
export function seekBar({ big = false, label, onInput, onCommit }) {
  const input = h('input', { type: 'range', class: ['range', 'range--seek', big && 'range--big'], min: '0', max: '1000', step: '1', value: '0', 'aria-label': label })
  const canvas = h('canvas', { class: 'seekbar__wave', 'aria-hidden': 'true' })
  const el = h('div', { class: ['seekbar', big && 'seekbar--big'] }, canvas, input)
  let dragging = false
  let fraction = 0
  let buffered = 0
  let item = null
  let bins = null

  const fill = () => {
    input.style.setProperty('--fill', `${Number(input.value) / 10}%`)
    input.style.setProperty('--buffered', `${Math.max(0, Math.min(100, buffered * 100))}%`)
  }

  function draw() {
    if (el.dataset.style !== 'wave') return
    const w = canvas.clientWidth
    const hgt = canvas.clientHeight
    if (!w || !hgt) return
    const ctx = fitCanvas(canvas, w, hgt)
    const played = cssVar(el, '--wave-played', '#fff')
    const rest = cssVar(el, '--wave-rest', 'rgba(255,255,255,.25)')
    const buf = cssVar(el, '--wave-buf', 'rgba(255,255,255,.4)')
    const barW = big ? 3 : 2
    const gap = big ? 2 : 1.5
    const n = Math.max(8, Math.floor((w + gap) / (barW + gap)))
    const step = (w - barW) / Math.max(1, n - 1)
    const f = dragging ? Number(input.value) / 1000 : fraction
    for (let i = 0; i < n; i += 1) {
      const v = bins ? sample(bins, i, n) : 0.18
      const bh = Math.max(2, v * hgt)
      const x = i * step
      const at = (x + barW / 2) / w
      ctx.fillStyle = at <= f ? played : at <= buffered ? buf : rest
      ctx.fillRect(x, (hgt - bh) / 2, barW, bh)
    }
  }

  function loadBins() {
    const target = item
    bins = null
    if (el.dataset.style !== 'wave' || !target) return
    loadPeaks(target).then((data) => { if (item === target) { bins = data; draw() } })
  }

  function applyStyle() {
    const style = progressStyle()
    const previous = el.dataset.style
    el.dataset.style = style === 'ring' ? 'classic' : style
    if (el.dataset.style === 'wave' && previous !== 'wave') loadBins()
    draw()
  }

  input.addEventListener('pointerdown', () => { dragging = true })
  input.addEventListener('input', () => { fill(); draw(); onInput?.(Number(input.value) / 1000) })
  input.addEventListener('change', () => { dragging = false; onCommit?.(Number(input.value) / 1000) })
  input.addEventListener('pointerup', () => { setTimeout(() => { dragging = false }, 0) })
  new ResizeObserver(() => draw()).observe(canvas)
  bus.on('prefs', ({ key }) => { if (key === 'progressStyle') applyStyle() })
  bus.on('theme', () => requestAnimationFrame(draw))
  applyStyle()

  return {
    el,
    get dragging() { return dragging },
    set(f, b = null) {
      if (b != null) buffered = Math.max(0, Math.min(1, b || 0))
      if (dragging) return
      fraction = Math.max(0, Math.min(1, f || 0))
      input.value = String(Math.round(fraction * 1000))
      fill()
      draw()
    },
    setItem(next) {
      if (next === item) return
      item = next
      loadBins()
      draw()
    }
  }
}

// ---- cover ring ------------------------------------------------------------------------

const TAU = Math.PI * 2
// Volume arc on the right of the cover: from 40° below to 40° above 3 o'clock.
const VOL_FROM = Math.PI * (40 / 180)
const VOL_SPAN = Math.PI * (80 / 180)

// Canvas overlay for the full player's round cover. `wrap` must contain the
// cover; the canvas extends past it so the volume arc fits on the right.
// Drag on the ring = seek, drag along the right arc = volume.
export function coverRing({ getPosition, getDuration, onSeekPreview, onSeek, getVolume, onVolume, canVolume = () => true }) {
  const canvas = h('canvas', { class: 'np-ring__canvas', 'aria-hidden': 'true' })
  let active = false
  let drag = null // { kind: 'seek' | 'volume', value }
  let raf = 0

  const geometry = () => {
    const w = canvas.clientWidth
    const cx = w / 2
    const art = w / 1.5 / 2 // cover radius (canvas is 1.5× the cover)
    return { w, cx, cy: cx, ring: art - 1, vol: art * 1.24 }
  }

  function draw() {
    raf = 0
    if (!active) return
    const { w, cx, cy, ring, vol } = geometry()
    if (!w) return
    const ctx = fitCanvas(canvas, w, w)
    const dur = getDuration() || 0
    const f = drag?.kind === 'seek' ? drag.value : dur ? Math.max(0, Math.min(1, getPosition() / dur)) : 0
    const start = -Math.PI / 2
    ctx.lineCap = 'round'
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(225,241,255,.22)'
    ctx.beginPath(); ctx.arc(cx, cy, ring, 0, TAU); ctx.stroke()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 4
    if (f > 0) { ctx.beginPath(); ctx.arc(cx, cy, ring, start, start + f * TAU); ctx.stroke() }
    const ta = start + f * TAU
    ctx.fillStyle = '#fff'
    ctx.beginPath(); ctx.arc(cx + Math.cos(ta) * ring, cy + Math.sin(ta) * ring, drag?.kind === 'seek' ? 10 : 8, 0, TAU); ctx.fill()

    if (canVolume()) {
      const v = drag?.kind === 'volume' ? drag.value : getVolume()
      // Canvas angles grow clockwise: the bottom end is +VOL_FROM, the top -VOL_FROM.
      const bottom = VOL_FROM
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(225,241,255,.22)'
      ctx.beginPath(); ctx.arc(cx, cy, vol, bottom - VOL_SPAN, bottom); ctx.stroke()
      ctx.strokeStyle = '#fff'
      if (v > 0) { ctx.beginPath(); ctx.arc(cx, cy, vol, bottom - v * VOL_SPAN, bottom); ctx.stroke() }
      const va = bottom - v * VOL_SPAN
      ctx.beginPath(); ctx.arc(cx + Math.cos(va) * vol, cy + Math.sin(va) * vol, drag?.kind === 'volume' ? 9 : 7, 0, TAU); ctx.fill()
      // Small speaker mark next to the arc.
      const sx = cx + vol + 18
      const sy = cy + vol * 0.42
      ctx.fillStyle = 'rgba(255,255,255,.75)'
      ctx.beginPath(); ctx.moveTo(sx - 6, sy - 3); ctx.lineTo(sx - 3, sy - 3); ctx.lineTo(sx + 1, sy - 7); ctx.lineTo(sx + 1, sy + 7); ctx.lineTo(sx - 3, sy + 3); ctx.lineTo(sx - 6, sy + 3); ctx.closePath(); ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,.75)'
      ctx.lineWidth = 1.5
      for (const r of [5, 9]) { ctx.beginPath(); ctx.arc(sx + 1, sy, r, -0.7, 0.7); ctx.stroke() }
    }
  }
  const schedule = () => { if (!raf && active) raf = requestAnimationFrame(draw) }

  // Which control a point hits: the ring band or the volume arc band.
  function hit(x, y) {
    const { cx, cy, ring, vol } = geometry()
    const dx = x - cx
    const dy = y - cy
    const d = Math.hypot(dx, dy)
    const a = Math.atan2(dy, dx)
    // The two bands are close: a touch goes to the nearer one.
    const toRing = Math.abs(d - ring)
    const toVol = canVolume() && dx > 0 && a <= VOL_FROM + 0.3 && a >= VOL_FROM - VOL_SPAN - 0.3 ? Math.abs(d - vol) : Infinity
    const reach = Math.max(20, ring * 0.14)
    if (toVol < toRing && toVol <= reach) return 'volume'
    if (toRing <= reach) return 'seek'
    return null
  }
  function valueAt(kind, x, y) {
    const { cx, cy } = geometry()
    const a = Math.atan2(y - cy, x - cx)
    if (kind === 'seek') return ((a + Math.PI / 2 + TAU) % TAU) / TAU
    return Math.max(0, Math.min(1, (VOL_FROM - a) / VOL_SPAN))
  }
  const local = (e) => {
    const r = canvas.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = local(e)
    const kind = hit(x, y)
    if (!kind) return
    e.preventDefault()
    e.stopPropagation()
    canvas.setPointerCapture(e.pointerId)
    drag = { kind, value: valueAt(kind, x, y), last: null }
    if (kind === 'volume') onVolume(drag.value)
    else onSeekPreview?.(drag.value)
    schedule()
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
      if (e.pointerType === 'mouse') { const [x, y] = local(e); canvas.style.cursor = hit(x, y) ? 'pointer' : '' }
      return
    }
    const [x, y] = local(e)
    let value = valueAt(drag.kind, x, y)
    // No wrap-around jump from the end of the song to its start (or back).
    if (drag.kind === 'seek' && Math.abs(value - drag.value) > 0.5) value = drag.value > 0.5 ? 1 : 0
    drag.value = value
    if (drag.kind === 'volume') onVolume(value)
    else onSeekPreview?.(value)
    schedule()
  })
  const end = () => {
    if (!drag) return
    if (drag.kind === 'seek') onSeek(drag.value)
    drag = null
    schedule()
  }
  canvas.addEventListener('pointerup', end)
  canvas.addEventListener('pointercancel', () => { drag = null; schedule() })
  new ResizeObserver(schedule).observe(canvas)

  return {
    el: canvas,
    get dragging() { return Boolean(drag) },
    // Touches that start on a control must not become swipes.
    owns(target, x, y) {
      if (target !== canvas) return false
      const r = canvas.getBoundingClientRect()
      return Boolean(hit(x - r.left, y - r.top))
    },
    setActive(on) { active = on; canvas.hidden = !on; if (on) schedule() },
    update: schedule
  }
}
