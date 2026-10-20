const { Pool } = require('pg');
const { withRetry } = require('../lib/retry');

// serialization failures and deadlocks are safe to retry as a whole transaction
const RETRYABLE_CODES = new Set(['40001', '40P01']);

function createDb({ connectionString, max = 20, statementTimeout = 5000, logger }) {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: statementTimeout,
    // store and compare everything in UTC; local time only matters at the edges (search by day)
    options: '-c timezone=UTC',
  });

  pool.on('error', (err) => {
    logger?.error({ err }, 'idle postgres client error');
  });

  function query(text, params) {
    return pool.query(text, params);
  }

  async function transaction(fn, { isolation } = {}) {
    return withRetry(
      async () => {
        const client = await pool.connect();
        try {
          await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
          const result = await fn(client);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      {
        retries: 3,
        baseDelayMs: 20,
        shouldRetry: (err) => RETRYABLE_CODES.has(err.code),
      }
    );
  }

  return {
    pool,
    query,
    transaction,
    ping: () => pool.query('SELECT 1'),
    close: () => pool.end(),
  };
}

module.exports = { createDb };
