const { AppError } = require('../../lib/errors');

function createAdminService({ db, audit }) {
  async function setUserStatus(admin, userId, status, ctx) {
    if (admin.id === userId) throw AppError.unprocessable('You cannot change your own status');

    return db.transaction(async (client) => {
      const { rows } = await client.query(
        'UPDATE users SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, email, role, status',
        [userId, status]
      );
      if (!rows[0]) throw AppError.notFound('User');
      if (status === 'disabled') {
        await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      }
      await audit.record({ actor: admin, action: `user.${status}`, entityType: 'user', entityId: userId, ctx }, client);
      return rows[0];
    });
  }

  async function failedJobs() {
    const { rows } = await db.query(
      `SELECT id, type, payload, attempts, last_error, updated_at FROM jobs
       WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 100`
    );
    return rows;
  }

  async function retryJob(admin, jobId, ctx) {
    const { rowCount } = await db.query(
      `UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(), updated_at = now() WHERE id = $1 AND status = 'failed'`,
      [jobId]
    );
    if (!rowCount) throw AppError.notFound('Failed job');
    await audit.record({ actor: admin, action: 'job.retried', entityType: 'job', entityId: jobId, ctx });
  }

  return { setUserStatus, failedJobs, retryJob };
}

module.exports = { createAdminService };
