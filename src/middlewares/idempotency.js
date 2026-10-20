const { AppError } = require('../lib/errors');
const { sha256 } = require('../lib/crypto');

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;
const TTL_HOURS = 24;
const STALE_LOCK_SECONDS = 60;

/**
 * Makes a write endpoint safe to retry. The client sends an Idempotency-Key header;
 * the first request runs and its response is stored, later requests with the same key
 * get the stored response back instead of running again.
 */
module.exports = function idempotency({ db }) {
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) return next(AppError.badRequest('Idempotency-Key header is required for this request'));
    if (!KEY_FORMAT.test(key)) return next(AppError.badRequest('Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-]'));

    const userId = req.user.id;
    const path = req.baseUrl + req.path;
    const requestHash = sha256(`${req.method}\n${path}\n${JSON.stringify(req.body ?? {})}`);

    try {
      // claim the key, or take it over if the old record expired / its request died mid-flight
      const claimed = await db.query(
        `INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'in_progress', now() + make_interval(hours => $6))
         ON CONFLICT (user_id, key) DO UPDATE
           SET method = EXCLUDED.method, path = EXCLUDED.path, request_hash = EXCLUDED.request_hash,
               status = 'in_progress', response_status = NULL, response_body = NULL,
               created_at = now(), expires_at = EXCLUDED.expires_at
           WHERE idempotency_keys.expires_at < now()
              OR (idempotency_keys.status = 'in_progress'
                  AND idempotency_keys.created_at < now() - make_interval(secs => $7))
         RETURNING key`,
        [userId, key, req.method, path, requestHash, TTL_HOURS, STALE_LOCK_SECONDS]
      );

      if (!claimed.rowCount) {
        const { rows } = await db.query('SELECT * FROM idempotency_keys WHERE user_id = $1 AND key = $2', [userId, key]);
        const existing = rows[0];
        if (!existing) return next(AppError.conflict('Please retry the request', 'IDEMPOTENCY_RETRY'));
        if (existing.request_hash !== requestHash) {
          return next(AppError.unprocessable('Idempotency-Key was already used with a different request', 'IDEMPOTENCY_KEY_REUSED'));
        }
        if (existing.status === 'in_progress') {
          return next(AppError.conflict('A request with this Idempotency-Key is still being processed', 'REQUEST_IN_PROGRESS'));
        }
        res.set('Idempotent-Replayed', 'true');
        return res.status(existing.response_status).json(existing.response_body);
      }
    } catch (err) {
      return next(err);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const finish =
        res.statusCode >= 500
          ? // let the client retry server errors with the same key
            db.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2', [userId, key])
          : db.query(
              `UPDATE idempotency_keys SET status = 'completed', response_status = $3, response_body = $4
               WHERE user_id = $1 AND key = $2`,
              [userId, key, res.statusCode, JSON.stringify(body)]
            );
      finish
        .catch((err) => req.log?.error({ err }, 'failed to store idempotency result'))
        .finally(() => originalJson(body));
      return res;
    };

    next();
  };
};
