/**
 * Limiteur « fenêtre glissante » minimaliste et en mémoire.
 * Suffisant pour 1-3 utilisateurs ; remplaçable par Redis si l'on scale.
 */
export function createRateLimiter({ points, windowMs, name = 'default' }) {
  const buckets = new Map();

  function consume(key, cost = 1) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { used: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.used + cost > points) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now, remaining: 0, name };
    }
    bucket.used += cost;
    return { allowed: true, retryAfterMs: 0, remaining: points - bucket.used, name };
  }

  function sweep() {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  }

  const timer = setInterval(sweep, Math.max(windowMs, 30_000));
  if (typeof timer.unref === 'function') timer.unref();

  return { consume, sweep, stop: () => clearInterval(timer) };
}

/** Adaptateur Express. */
export function rateLimitMiddleware(limiter, keyFn = (req) => req.ip) {
  return (req, res, next) => {
    const result = limiter.consume(keyFn(req));
    if (result.allowed) return next();
    res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
    return res.status(429).json({
      error: 'rate_limited',
      message: 'Trop de requêtes, réessayez dans quelques instants.',
      retryAfterMs: result.retryAfterMs,
    });
  };
}

export default createRateLimiter;
