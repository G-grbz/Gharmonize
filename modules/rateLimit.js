const _rlMap = new Map()

setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of _rlMap) {
    if (now - entry.start > entry.windowMs) _rlMap.delete(key)
  }
}, 5 * 60 * 1000).unref()

export function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip
    const now = Date.now()
    let entry = _rlMap.get(key)
    if (!entry || now - entry.start > windowMs) {
      entry = { count: 0, start: now, windowMs }
    }
    entry.count++
    _rlMap.set(key, entry)
    if (entry.count >= max) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded' })
    }
    next()
  }
}
