const { cached } = require('../../lib/cache');

const OVERVIEW_TTL_SEC = 60;

function createAnalyticsService({ db, cache }) {
  async function overview({ from, to }) {
    return cached(cache, `analytics:overview:${from}:${to}`, OVERVIEW_TTL_SEC, async () => {
      const range = [from, to];

      const [byStatus, revenue, users, topDoctors] = await Promise.all([
        db.query(
          `SELECT status, count(*)::int AS count FROM consultations
           WHERE scheduled_start >= $1 AND scheduled_start < $2::date + 1 GROUP BY status`,
          range
        ),
        db.query(
          `SELECT COALESCE(sum(amount) FILTER (WHERE status = 'succeeded'), 0)::bigint AS gross,
                  COALESCE(sum(amount) FILTER (WHERE status IN ('refund_pending', 'refunded')), 0)::bigint AS refunded,
                  count(*) FILTER (WHERE status = 'succeeded')::int AS paid_count
           FROM payments WHERE created_at >= $1 AND created_at < $2::date + 1`,
          range
        ),
        db.query(
          `SELECT count(*) FILTER (WHERE role = 'patient')::int AS new_patients,
                  count(*) FILTER (WHERE role = 'doctor')::int AS new_doctors
           FROM users WHERE created_at >= $1 AND created_at < $2::date + 1`,
          range
        ),
        db.query(
          `SELECT d.id, p.full_name, d.specialization, count(*)::int AS completed
           FROM consultations c JOIN doctors d ON d.id = c.doctor_id JOIN profiles p ON p.user_id = d.user_id
           WHERE c.status = 'completed' AND c.scheduled_start >= $1 AND c.scheduled_start < $2::date + 1
           GROUP BY d.id, p.full_name, d.specialization
           ORDER BY completed DESC LIMIT 5`,
          range
        ),
      ]);

      const statusCounts = Object.fromEntries(byStatus.rows.map((r) => [r.status, r.count]));
      const total = byStatus.rows.reduce((sum, r) => sum + r.count, 0);
      const cancelled = statusCounts.cancelled || 0;
      const rate = (n) => (total ? Number((n / total).toFixed(4)) : 0);

      return {
        range: { from, to },
        consultations: {
          total,
          byStatus: statusCounts,
          cancellationRate: rate(cancelled),
          noShowRate: rate(statusCounts.no_show || 0),
          completionRate: rate(statusCounts.completed || 0),
        },
        revenue: {
          gross: Number(revenue.rows[0].gross),
          refunded: Number(revenue.rows[0].refunded),
          net: Number(revenue.rows[0].gross) - Number(revenue.rows[0].refunded),
          paidConsultations: revenue.rows[0].paid_count,
          currency: 'INR',
        },
        users: { newPatients: users.rows[0].new_patients, newDoctors: users.rows[0].new_doctors },
        topDoctors: topDoctors.rows.map((r) => ({
          id: r.id,
          fullName: r.full_name,
          specialization: r.specialization,
          completedConsultations: r.completed,
        })),
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async function daily({ from, to }) {
    const { rows } = await db.query('SELECT * FROM daily_stats WHERE day BETWEEN $1 AND $2 ORDER BY day', [from, to]);
    return rows.map((r) => ({
      day: r.day,
      consultations: r.consultations_total,
      completed: r.completed,
      cancelled: r.cancelled,
      noShow: r.no_show,
      revenue: Number(r.revenue),
      newPatients: r.new_patients,
    }));
  }

  // job: (re)compute one day's numbers. Idempotent, so running it twice is harmless.
  async function rollupDay(day) {
    await db.query(
      `INSERT INTO daily_stats (day, consultations_total, completed, cancelled, no_show, revenue, new_patients, computed_at)
       SELECT $1::date,
         (SELECT count(*) FROM consultations WHERE scheduled_start >= $1::date AND scheduled_start < $1::date + 1),
         (SELECT count(*) FROM consultations WHERE status = 'completed' AND scheduled_start >= $1::date AND scheduled_start < $1::date + 1),
         (SELECT count(*) FROM consultations WHERE status = 'cancelled' AND scheduled_start >= $1::date AND scheduled_start < $1::date + 1),
         (SELECT count(*) FROM consultations WHERE status = 'no_show' AND scheduled_start >= $1::date AND scheduled_start < $1::date + 1),
         (SELECT COALESCE(sum(amount), 0) FROM payments WHERE status = 'succeeded' AND created_at >= $1::date AND created_at < $1::date + 1),
         (SELECT count(*) FROM users WHERE role = 'patient' AND created_at >= $1::date AND created_at < $1::date + 1),
         now()
       ON CONFLICT (day) DO UPDATE SET
         consultations_total = EXCLUDED.consultations_total, completed = EXCLUDED.completed,
         cancelled = EXCLUDED.cancelled, no_show = EXCLUDED.no_show, revenue = EXCLUDED.revenue,
         new_patients = EXCLUDED.new_patients, computed_at = now()`,
      [day]
    );
  }

  return { overview, daily, rollupDay };
}

module.exports = { createAnalyticsService };
