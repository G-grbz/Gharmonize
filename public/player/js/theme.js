// Dark / light theme. Shares the "theme" key with the rest of Gharmonize so
// the choice follows the user between the downloader and the player.

import { bus } from './app.js'

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

export const ACCENTS = ['blue', 'violet', 'ocean', 'moss', 'amber', 'rose']

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
  try { localStorage.setItem('theme', next) } catch {}
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', next === 'light' ? '#f7f7fb' : '#0d1117')
  setTimeout(() => root.classList.remove('theme-switching'), 350)
  bus.emit('theme', next)
}
