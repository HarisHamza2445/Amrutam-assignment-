const { AppError } = require('../lib/errors');

// fixed window limiter; the store is the shared cache so limits hold across pods when Redis is on
module.exports = function rateLimit({ store, windowSec, max, prefix = 'rl', keyBy = 'ip' }) {
  return async (req, res, next) => {
    try {
      const who = keyBy === 'user' && req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
      const { count, resetMs } = await store.incrWindow(`${prefix}:${who}`, windowSec);

      res.set('RateLimit-Limit', String(max));
      res.set('RateLimit-Remaining', String(Math.max(0, max - count)));
      res.set('RateLimit-Reset', String(Math.ceil(resetMs / 1000)));

      if (count > max) {
        res.set('Retry-After', String(Math.ceil(resetMs / 1000)));
        return next(new AppError(429, 'RATE_LIMITED', 'Too many requests, slow down'));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
};
