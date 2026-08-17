const _rlStores = new Set()

// Periodically remove expired IP entries from all limiter instances.
const cleanupTimer = setInterval(() => {
  const now = Date.now()
  for (const store of _rlStores) {
    for (const [key, entry] of store) {
      if (now - entry.start >= entry.windowMs) store.delete(key)
    }
  }
}, 5 * 60 * 1000)
cleanupTimer.unref?.()

export function rateLimit(max, windowMs) {
  const limit = Math.max(1, Math.floor(Number(max) || 1))
  const window = Math.max(1, Math.floor(Number(windowMs) || 1))
  const store = new Map()
  _rlStores.add(store)

  return (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || 'unknown'
    const now = Date.now()
    let entry = store.get(key)

    if (!entry || now - entry.start >= window) {
      entry = { count: 0, start: now, windowMs: window }
    }

    entry.count += 1
    store.set(key, entry)

    const resetSeconds = Math.max(1, Math.ceil((entry.start + window - now) / 1000))
    res.setHeader?.('RateLimit-Limit', String(limit))
    res.setHeader?.('RateLimit-Remaining', String(Math.max(0, limit - entry.count)))
    res.setHeader?.('RateLimit-Reset', String(resetSeconds))

    // Allow exactly `limit` requests. The next request is rejected.
    if (entry.count > limit) {
      res.setHeader?.('Retry-After', String(resetSeconds))
      return res.status(429).json({
        error: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded'
      })
    }

    next()
  }
}

export function concurrencyLimit(max) {
  const limit = Math.max(1, Math.floor(Number(max) || 1))
  const active = new Map()

  return (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || 'unknown'
    const current = Number(active.get(key) || 0)

    res.setHeader?.('ConcurrencyLimit-Limit', String(limit))
    res.setHeader?.('ConcurrencyLimit-Remaining', String(Math.max(0, limit - current - 1)))

    if (current >= limit) {
      return res.status(429).json({
        error: 'TOO_MANY_CONCURRENT_REQUESTS',
        message: 'Too many concurrent requests'
      })
    }

    active.set(key, current + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      const value = Number(active.get(key) || 0) - 1
      if (value > 0) active.set(key, value)
      else active.delete(key)
    }

    res.once?.('finish', release)
    res.once?.('close', release)
    next()
  }
}
