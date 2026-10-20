function createJobHandlers({ db, consultationsService, paymentsService, analyticsService, notifier, queue }) {
  async function userContact(userId) {
    const { rows } = await db.query(
      'SELECT u.id, u.email, p.full_name FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1',
      [userId]
    );
    return rows[0];
  }

  async function consultationParties(consultationId) {
    const { rows } = await db.query(
      `SELECT c.id, c.scheduled_start, c.patient_id, d.user_id AS doctor_user_id
       FROM consultations c JOIN doctors d ON d.id = c.doctor_id WHERE c.id = $1`,
      [consultationId]
    );
    return rows[0];
  }

  return {
    'booking.expire_hold': (payload) => consultationsService.expireHold(payload),

    'booking.sweep_expired': () => consultationsService.sweepExpiredHolds(),

    'payments.refund': (payload) => paymentsService.processRefund(payload),

    'notify.booking_confirmed': async ({ consultationId }) => {
      const c = await consultationParties(consultationId);
      if (!c) return;
      for (const userId of [c.patient_id, c.doctor_user_id]) {
        const user = await userContact(userId);
        await notifier.send({ to: user.email, template: 'booking_confirmed', data: { consultationId, at: c.scheduled_start } });
      }
    },

    'notify.consultation_cancelled': async ({ consultationId, cancelledBy }) => {
      const c = await consultationParties(consultationId);
      if (!c) return;
      for (const userId of [c.patient_id, c.doctor_user_id]) {
        const user = await userContact(userId);
        await notifier.send({ to: user.email, template: 'consultation_cancelled', data: { consultationId, cancelledBy } });
      }
    },

    'notify.prescription_ready': async ({ prescriptionId }) => {
      const { rows } = await db.query('SELECT patient_id FROM prescriptions WHERE id = $1', [prescriptionId]);
      if (!rows[0]) return;
      const user = await userContact(rows[0].patient_id);
      await notifier.send({ to: user.email, template: 'prescription_ready', data: { prescriptionId } });
    },

    'analytics.rollup': async ({ day } = {}) => {
      // default: yesterday and today, since late events can still change yesterday's numbers
      const days = day
        ? [day]
        : [0, 1].map((back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10));
      for (const d of days) await analyticsService.rollupDay(d);
    },

    'maintenance.audit_partitions': async () => {
      await db.query(`SELECT ensure_audit_partition((date_trunc('month', now()) + interval '1 month')::date)`);
      await db.query(`SELECT ensure_audit_partition((date_trunc('month', now()) + interval '2 months')::date)`);
    },

    'maintenance.cleanup': async () => {
      await db.query('DELETE FROM idempotency_keys WHERE expires_at < now()');
      await db.query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days'`);
      await db.query(`DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - interval '7 days'`);
      await queue.requeueStuck();
    },
  };
}

// recurring jobs; one dedupe key per time bucket, so every worker can tick and each job
// still only runs once per interval
const SCHEDULE = [
  { type: 'booking.sweep_expired', everySec: 60 },
  { type: 'maintenance.cleanup', everySec: 3600 },
  { type: 'analytics.rollup', everySec: 900 },
  { type: 'maintenance.audit_partitions', everySec: 86400 },
];

async function scheduleRecurring(queue) {
  const now = Math.floor(Date.now() / 1000);
  for (const { type, everySec } of SCHEDULE) {
    const bucket = Math.floor(now / everySec);
    await queue.enqueue(type, {}, { dedupeKey: `cron:${type}:${bucket}`, maxAttempts: 3 });
  }
}

module.exports = { createJobHandlers, scheduleRecurring };
