// Server-only: small in-memory fixed-window rate limiter (single-instance deployment).
export function rateLimiter({ windowMs, max, key = (req) => req.ip, name = 'rl' }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, Math.min(windowMs, 60000)).unref();
  return (req, res, next) => {
    const k = `${name}:${key(req)}`;
    const now = Date.now();
    let e = hits.get(k);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; hits.set(k, e); }
    e.count++;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - e.count)));
    if (e.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.', code: 'rate_limited' });
    }
    next();
  };
}
