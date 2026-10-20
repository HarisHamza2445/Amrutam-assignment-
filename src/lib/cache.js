// Small cache abstraction. Uses Redis when REDIS_URL is set, otherwise an in-process map
// (fine for local dev and tests, not shared between pods).

function createMemoryStore() {
  const data = new Map();

  return {
    async get(key) {
      const entry = data.get(key);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        data.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSec) {
      data.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    },
    async del(key) {
      data.delete(key);
    },
    async delPrefix(prefix) {
      for (const key of data.keys()) if (key.startsWith(prefix)) data.delete(key);
    },
    async incrWindow(key, windowSec) {
      const now = Date.now();
      const entry = data.get(key);
      if (!entry || entry.expiresAt < now) {
        data.set(key, { value: 1, expiresAt: now + windowSec * 1000 });
        return { count: 1, resetMs: windowSec * 1000 };
      }
      entry.value += 1;
      return { count: entry.value, resetMs: entry.expiresAt - now };
    },
    async close() {},
  };
}

function createRedisStore(redis) {
  return {
    async get(key) {
      const raw = await redis.get(key);
      return raw ? JSON.parse(raw) : null;
    },
    async set(key, value, ttlSec) {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
    },
    async del(key) {
      await redis.del(key);
    },
    async delPrefix(prefix) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        if (keys.length) await redis.del(...keys);
        cursor = next;
      } while (cursor !== '0');
    },
    async incrWindow(key, windowSec) {
      const [[, count], [, ttl]] = await redis.multi().incr(key).pttl(key).exec();
      if (ttl < 0) await redis.pexpire(key, windowSec * 1000);
      return { count, resetMs: ttl < 0 ? windowSec * 1000 : ttl };
    },
    async close() {
      await redis.quit();
    },
  };
}

function createCache({ redisUrl, logger } = {}) {
  if (!redisUrl) return createMemoryStore();

  const Redis = require('ioredis');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
  redis.on('error', (err) => logger?.warn({ err: err.message }, 'redis error'));
  const store = createRedisStore(redis);

  // a cache outage should slow us down, not take the API down
  const safe = (fn, fallback) => async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      logger?.warn({ err: err.message }, 'cache call failed, continuing without it');
      return fallback;
    }
  };

  return {
    get: safe(store.get, null),
    set: safe(store.set),
    del: safe(store.del),
    delPrefix: safe(store.delPrefix),
    incrWindow: safe(store.incrWindow, { count: 0, resetMs: 0 }),
    close: store.close,
  };
}

async function cached(cache, key, ttlSec, load) {
  const hit = await cache.get(key);
  if (hit !== null && hit !== undefined) return hit;
  const value = await load();
  await cache.set(key, value, ttlSec);
  return value;
}

module.exports = { createCache, createMemoryStore, cached };
