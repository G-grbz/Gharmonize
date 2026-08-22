import { ipKeyGenerator, rateLimit as createExpressRateLimit } from 'express-rate-limit'

export function rateLimit(max, windowMs) {
  const limit = Math.max(1, Math.floor(Number(max) || 1))
  const window = Math.max(1, Math.floor(Number(windowMs) || 1))

  return createExpressRateLimit({
    windowMs: window,
    limit,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    // Keep IPv6 clients grouped by subnet while retaining the previous fallback
    // for non-Express test and integration callers.
    keyGenerator: (req) => ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'),
    handler: (_req, res) => res.status(429).json({
      error: 'TOO_MANY_REQUESTS',
      message: 'Rate limit exceeded'
    })
  })
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
