// Address the main Gharmonize server listens on (GHARMONIZE_HOST).
//
// Settings may only switch between fixed choices. The value written to the env
// file and passed to listen() is always one of the constants below, never the
// request text itself, so no client-controlled string reaches the socket layer.
// A different address typed into the env file by hand is kept untouched
// ("custom") and simply not offered in the UI.

export const SERVER_HOST_LOOPBACK = '127.0.0.1'
export const SERVER_HOST_ALL = '0.0.0.0'
export const SERVER_HOST_CHOICES = Object.freeze([SERVER_HOST_LOOPBACK, SERVER_HOST_ALL])

// Maps a settings value to a fixed choice; unknown input means "this computer".
export function normalizeServerHostChoice(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === SERVER_HOST_ALL || raw === 'lan' || raw === 'all') return SERVER_HOST_ALL
  return SERVER_HOST_LOOPBACK
}

// Address to bind from the (trusted) process environment.
export function resolveServerHost(env = process.env) {
  return String(env.GHARMONIZE_HOST ?? '').trim() || SERVER_HOST_LOOPBACK
}

// What the settings page shows: a fixed choice or "custom".
export function describeServerHost(env = process.env, { locked = false } = {}) {
  const current = resolveServerHost(env)
  const choice = SERVER_HOST_CHOICES.includes(current) ? current : 'custom'
  return { choice, current, locked: Boolean(locked) }
}

export function isLoopbackHost(host) {
  const value = String(host ?? '').trim().toLowerCase()
  return value === 'localhost' || value === '::1' || /^127\./.test(value)
}
