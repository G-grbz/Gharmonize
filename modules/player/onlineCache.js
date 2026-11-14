// Persistent stale-while-revalidate cache for online discovery data.
// - fresh hit      → returned immediately
// - stale hit      → returned immediately, refreshed in the background
// - miss           → loaded (concurrent callers share one request)
// Failed refreshes keep serving stale data up to `staleMaxMs`, so a provider
// outage never empties the home page.

const DEFAULT_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000

export function createOnlineCache(db, { now = () => Date.now(), logger = console } = {}) {
  const inflight = new Map()
  const stmt = {
    get: db.prepare('SELECT value, fetched_at, expires_at FROM online_cache WHERE key = ?'),
    set: db.prepare(`INSERT INTO online_cache (key, value, fetched_at, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`),
    purge: db.prepare('DELETE FROM online_cache WHERE fetched_at < ?'),
    clear: db.prepare('DELETE FROM online_cache')
  }
  let closed = false

  function read(key) {
    const row = stmt.get.get(key)
    if (!row) return null
    try { return { value: JSON.parse(row.value), fetchedAt: row.fetched_at, expiresAt: row.expires_at } } catch { return null }
  }

  function write(key, value, ttlMs) {
    if (closed) return
    const ts = now()
    stmt.set.run(key, JSON.stringify(value ?? null), ts, ts + ttlMs)
  }

  function load(key, ttlMs, loader, ttlFor) {
    if (inflight.has(key)) return inflight.get(key)
    const promise = Promise.resolve()
      .then(loader)
      .then((value) => { write(key, value, ttlFor ? ttlFor(value) ?? ttlMs : ttlMs); return value })
      .finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }

  // ttlFor(value) may pick a different lifetime per result (e.g. shorter for
  // "not found" answers).
  async function wrap(key, ttlMs, loader, { staleMaxMs = DEFAULT_STALE_MAX_MS, ttlFor = null } = {}) {
    const hit = read(key)
    const ts = now()
    if (hit && hit.expiresAt > ts) return hit.value
    if (hit && ts - hit.fetchedAt < staleMaxMs) {
      load(key, ttlMs, loader, ttlFor).catch((error) => logger.debug?.(`[player] background refresh failed for ${key}: ${error?.message || error}`))
      return hit.value
    }
    return load(key, ttlMs, loader, ttlFor)
  }

  function peek(key) {
    return read(key)?.value ?? null
  }

  function purge(maxAgeMs = DEFAULT_STALE_MAX_MS) {
    stmt.purge.run(now() - maxAgeMs)
  }

  function clear() {
    stmt.clear.run()
  }

  function close() {
    closed = true
  }

  return { wrap, peek, write, purge, clear, close, inflightCount: () => inflight.size }
}
