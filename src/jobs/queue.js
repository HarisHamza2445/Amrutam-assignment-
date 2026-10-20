const os = require('os');
const { backoffDelay, sleep } = require('../lib/retry');
const { counters, jobLag } = require('../lib/metrics');

/**
 * Durable job queue on top of Postgres. Jobs are inserted in the same transaction as the
 * business change (transactional outbox), so we never lose a job or run one for a change
 * that rolled back. Workers grab jobs with FOR UPDATE SKIP LOCKED, so any number of worker
 * pods can run side by side.
 */
function createQueue({ db, logger }) {
  async function enqueue(type, payload = {}, { client = db, runAt, delayMs, maxAttempts = 5, dedupeKey } = {}) {
    const when = runAt ?? new Date(Date.now() + (delayMs ?? 0));
    const { rows } = await client.query(
      `INSERT INTO jobs (type, payload, run_at, max_attempts, dedupe_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [type, payload, when, maxAttempts, dedupeKey ?? null]
    );
    return rows[0]?.id ?? null;
  }

  async function claim(batchSize) {
    const { rows } = await db.query(
      `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
       WHERE id IN (
         SELECT id FROM jobs
         WHERE status = 'queued' AND run_at <= now()
         ORDER BY run_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [batchSize]
    );
    return rows;
  }

  async function complete(job) {
    await db.query(`UPDATE jobs SET status = 'done', locked_at = NULL, updated_at = now() WHERE id = $1`, [job.id]);
  }

  async function fail(job, err) {
    const giveUp = job.attempts >= job.max_attempts;
    const retryIn = backoffDelay(job.attempts, { baseDelayMs: 2000, maxDelayMs: 10 * 60 * 1000 });
    await db.query(
      `UPDATE jobs
       SET status = $2, locked_at = NULL, last_error = $3, updated_at = now(),
           run_at = now() + make_interval(secs => $4)
       WHERE id = $1`,
      [job.id, giveUp ? 'failed' : 'queued', String(err?.stack || err).slice(0, 2000), retryIn / 1000]
    );
    return giveUp;
  }

  // jobs left "running" by a worker that crashed go back to the queue
  async function requeueStuck(olderThanSec = 300) {
    const { rowCount } = await db.query(
      `UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = now()
       WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)`,
      [olderThanSec]
    );
    return rowCount;
  }

  async function runOnce(handlers, batchSize = 10) {
    const jobs = await claim(batchSize);
    for (const job of jobs) {
      jobLag.observe({ type: job.type }, Math.max(0, (Date.now() - new Date(job.run_at).getTime()) / 1000));
      const handler = handlers[job.type];
      try {
        if (!handler) throw new Error(`no handler registered for job type ${job.type}`);
        await handler(job.payload, job);
        await complete(job);
        counters.jobs.inc({ type: job.type, result: 'ok' });
      } catch (err) {
        const dead = await fail(job, err);
        counters.jobs.inc({ type: job.type, result: dead ? 'dead' : 'retry' });
        logger.warn({ err, jobId: job.id, type: job.type, attempt: job.attempts, dead }, 'job failed');
      }
    }
    return jobs.length;
  }

  function start(handlers, { pollMs = 1000, batchSize = 10 } = {}) {
    let stopped = false;
    const workerId = `${os.hostname()}:${process.pid}`;
    logger.info({ workerId }, 'job worker started');

    const loop = (async () => {
      while (!stopped) {
        try {
          const processed = await runOnce(handlers, batchSize);
          if (!processed) await sleep(pollMs);
        } catch (err) {
          logger.error({ err }, 'job loop error');
          await sleep(pollMs * 5);
        }
      }
    })();

    return async () => {
      stopped = true;
      await loop;
    };
  }

  return { enqueue, runOnce, start, requeueStuck };
}

module.exports = { createQueue };
