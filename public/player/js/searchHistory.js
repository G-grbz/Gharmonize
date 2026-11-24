// The user's search history on the server (shared with their other
// devices): search texts and the results they picked from a search.

import { store } from './app.js'
import { get, post, del } from './api.js'

const OLD_KEY = 'recentSearches'
let moved = null

// Searches saved in this browser before the history moved to the server.
function moveOldSearches() {
  if (moved) return moved
  const old = store.get(OLD_KEY, null)
  if (!Array.isArray(old) || !old.length) { moved = Promise.resolve(); return moved }
  moved = (async () => {
    for (const q of old.slice(0, 20).reverse()) {
      if (typeof q === 'string' && q.trim()) await post('/search/history', { q }).catch(() => {})
    }
    store.remove(OLD_KEY)
  })()
  return moved
}

export async function loadSearchHistory() {
  await moveOldSearches()
  return get('/search/history')
}

export function rememberQuery(q) {
  const text = String(q || '').trim()
  if (!text || /^https?:\/\//i.test(text)) return
  post('/search/history', { q: text }).catch(() => {})
}

/** `item`: { source: 'library', kind, id } or { source: 'online', online }. */
export function rememberPick(item, q = '') {
  const text = String(q || '').trim()
  const body = { item }
  if (text && !/^https?:\/\//i.test(text)) body.q = text
  post('/search/history', body).catch(() => {})
}

export const forgetQuery = (q) => del(`/search/history?q=${encodeURIComponent(q)}`)
export const forgetPick = (key) => del(`/search/history?key=${encodeURIComponent(key)}`)
export const clearSearchHistory = () => del('/search/history')

// The search a list or card was opened from, if any ({ route: '/search?q=…' }).
export function searchQueryOf(context) {
  const route = context?.route || ''
  if (!route.startsWith('/search?')) return null
  return new URLSearchParams(route.slice('/search?'.length)).get('q') || ''
}
