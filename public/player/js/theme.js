// Dark / light theme. Shares the "theme" key with the rest of Gharmonize so
// the choice follows the user between the downloader and the player.

import { bus } from './app.js'

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

export const ACCENTS = ['blue', 'violet', 'ocean', 'moss', 'amber', 'rose', 'indigo', 'coral', 'fuchsia', 'silver']

// Ready-made player colours: five dark and five light ones (each dark colour
// has a light partner). 'navy' and 'light' are the classic Gharmonize themes
// (no data-palette). The last colour picked for each base is remembered, so
// the dark/light toggle switches between those two.
export const PALETTES = [
  ['navy', 'dark'], ['oled', 'dark'], ['deepsea', 'dark'], ['forest', 'dark'], ['plum', 'dark'],
  ['light', 'light'], ['mist', 'light'], ['sky', 'light'], ['mint', 'light'], ['lilac', 'light']
]
const paletteBase = (key) => PALETTES.find(([k]) => k === key)?.[1] || null
const CLASSIC = { dark: 'navy', light: 'light' }
const storageKey = (base) => `ghp.palette.${base}`

/** Remembered colour for a base theme ('dark' | 'light'). */
function savedPalette(base) {
  let key = null
  try { key = localStorage.getItem(storageKey(base)) } catch {}
  return paletteBase(key) === base ? key : CLASSIC[base]
}

function showPalette(base) {
  const key = savedPalette(base)
  const root = document.documentElement
  if (key === CLASSIC[base]) root.removeAttribute('data-palette')
  else root.setAttribute('data-palette', key)
}

/** Palette in effect for the current base theme. */
export function currentPalette() {
  const shown = document.documentElement.getAttribute('data-palette')
  const theme = currentTheme()
  return paletteBase(shown) === theme ? shown : CLASSIC[theme]
}

function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]')
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  if (meta && bg) meta.setAttribute('content', bg)
}

/** Picks a player colour (also switches to its dark or light base). */
export function applyPalette(key) {
  const base = paletteBase(key)
  if (!base) return
  try { localStorage.setItem(storageKey(base), key) } catch {}
  applyTheme(base)
}

export function currentAccent() {
  return ACCENTS.includes(document.documentElement.getAttribute('data-accent')) ? document.documentElement.getAttribute('data-accent') : 'blue'
}

/** Accent colour of the player (stored per browser). */
export function applyAccent(accent) {
  const next = ACCENTS.includes(accent) ? accent : 'blue'
  const root = document.documentElement
  root.classList.add('theme-switching')
  root.setAttribute('data-accent', next)
  try { localStorage.setItem('ghp.accent', next) } catch {}
  setTimeout(() => root.classList.remove('theme-switching'), 350)
  bus.emit('theme', currentTheme())
}

export function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark'
  const root = document.documentElement
  root.classList.add('theme-switching')
  root.setAttribute('data-theme', next)
  // The colour last used with this base comes back with it.
  showPalette(next)
  try { localStorage.setItem('theme', next) } catch {}
  syncThemeColor()
  setTimeout(() => root.classList.remove('theme-switching'), 350)
  bus.emit('theme', next)
}
