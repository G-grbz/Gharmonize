// Thin client for /api/player. Session auth uses the HttpOnly cookie set by
// the server, so no token is ever stored in the browser.

const BASE = '/api/player'

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`)
    this.status = status
    this.code = code || `HTTP_${status}`
  }
}

let onUnauthorized = null
export function setUnauthorizedHandler(fn) { onUnauthorized = fn }

export async function api(path, { method = 'GET', body, signal, query } = {}) {
  let url = BASE + path
  if (query) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v))
    const qs = params.toString()
    if (qs) url += (url.includes('?') ? '&' : '?') + qs
  }
  const init = { method, signal, credentials: 'same-origin', headers: { Accept: 'application/json' } }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let res
  try {
    res = await fetch(url, init)
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new ApiError(0, 'NETWORK', error?.message || 'Network error')
  }
  let data = null
  const text = await res.text()
  if (text) { try { data = JSON.parse(text) } catch { data = null } }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error?.code, data?.error?.message)
    if (res.status === 401 && err.code === 'PLAYER_AUTH_REQUIRED') onUnauthorized?.(err)
    throw err
  }
  return data
}

export const get = (path, query, opts = {}) => api(path, { ...opts, query })
export const post = (path, body, opts = {}) => api(path, { ...opts, method: 'POST', body: body ?? {} })
export const put = (path, body) => api(path, { method: 'PUT', body: body ?? {} })
export const patch = (path, body) => api(path, { method: 'PATCH', body: body ?? {} })
export const del = (path) => api(path, { method: 'DELETE' })

// `ref` is the "kind/id" string the server returns as `artwork`.
export function artworkUrl(ref, size = 256) {
  if (!ref) return null
  if (/^https:\/\//.test(ref)) return ref
  return `${BASE}/artwork/${ref}?size=${size}`
}

// Deezer preview links expire within minutes; the server redirects to a fresh one.
export function previewStreamUrl(item) {
  if (item?.provider === 'deezer' && /^\d{1,20}$/.test(String(item.id || ''))) return `${BASE}/online/preview/deezer/${item.id}`
  return item?.previewUrl || null
}

export function streamUrl(trackId, quality = 'original') {
  const q = quality && quality !== 'original' ? `?quality=${encodeURIComponent(quality)}` : ''
  return `${BASE}/stream/${Number(trackId)}${q}`
}

export function absoluteUrl(path) {
  try { return new URL(path, window.location.origin).toString() } catch { return path }
}
